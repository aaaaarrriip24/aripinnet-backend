/**
 * Scheduler cron.
 *
 * VERSI 2 — tambahan:
 * - wa-watchdog  : pantau kesehatan WhatsApp, kirim alert
 * - plan-verify  : periksa profile paket di semua router
 * - router-alert : alert kalau router offline berkepanjangan
 *
 * Dependensi: npm i node-cron dayjs
 *
 * Dua hal yang sering bikin cron billing rusak dan sudah ditangani:
 * 1. OVERLAP — job sebelumnya belum selesai tapi sudah dipicu lagi.
 *    Ditangani dengan lock di MongoDB (bukan flag in-memory), supaya
 *    tetap aman kalau dijalankan lebih dari satu instance.
 * 2. TIMEZONE — cron default pakai timezone server. VPS biasanya UTC,
 *    jadi "0 1 * * *" bisa jalan jam 8 pagi WIB. Selalu set eksplisit.
 */

const cron = require('node-cron');
const mongoose = require('mongoose');

const invoiceGenerator = require('./invoice-generator');
const isolation = require('./isolation');
const watchdog = require('./wa-watchdog');
const { Service, Invoice, Router } = require('../models');
const routeros = require('../services/routeros');
const alert = require('../services/alert');

const TZ = process.env.TZ_APP || 'Asia/Jakarta';
const LOCK_TTL_MS = 10 * 60 * 1000;
const ROUTER_OFFLINE_ALERT_MIN = Number(process.env.ROUTER_OFFLINE_ALERT_MIN || 20);

/* ------------------------------------------------------------------ */
/* Lock berbasis MongoDB                                               */
/* ------------------------------------------------------------------ */

function locks() {
  return mongoose.connection.collection('job_locks');
}

async function acquire(name) {
  const now = Date.now();
  try {
    await locks().updateOne(
      { _id: name, expires_at: { $lt: new Date(now) } },
      { $set: { expires_at: new Date(now + LOCK_TTL_MS), acquired_at: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // lock masih dipegang proses lain
    throw err;
  }
}

async function release(name) {
  await locks().updateOne({ _id: name }, { $set: { expires_at: new Date(0) } });
}

async function runLocked(name, fn) {
  if (!(await acquire(name))) {
    console.log(`[cron] ${name} dilewati — masih berjalan`);
    return;
  }

  const started = Date.now();
  try {
    const result = await fn();
    console.log(`[cron] ${name} selesai ${Date.now() - started}ms`, JSON.stringify(result));
    return result;
  } catch (err) {
    console.error(`[cron] ${name} GAGAL:`, err.message, err.stack);

    // Job billing yang gagal diam-diam adalah bagaimana tagihan tidak
    // terbit selama sebulan tanpa ada yang sadar.
    await alert.send(
      `cron:${name}`,
      'warning',
      `Job terjadwal "${name}" gagal.\n\n${err.message}\n\nPeriksa: pm2 logs billing-api`,
      { cooldownMinutes: 180 }
    ).catch(() => {});
  } finally {
    await release(name);
  }
}

/* ------------------------------------------------------------------ */
/* Job rekonsiliasi                                                    */
/* ------------------------------------------------------------------ */

/**
 * Perbaiki service yang sudah lunas tapi masih terisolir — biasanya
 * karena restore gagal saat webhook masuk (router sedang tidak
 * terjangkau, atau profile paket belum tersinkron).
 */
async function reconcile() {
  const isolated = await Service.find({ status: 'isolated' }).limit(200);
  const result = { checked: isolated.length, restored: 0, failed: 0, errors: [] };

  for (const service of isolated) {
    const stillOwing = await Invoice.exists({
      service_id: service._id,
      status: 'unpaid',
      due_date: { $lt: new Date() },
    });

    if (stillOwing) continue;

    const res = await isolation.restoreService(service, { trigger: 'auto' });
    if (res.success) {
      result.restored++;
    } else {
      result.failed++;
      result.errors.push({ service: String(service._id), message: res.message });
    }
  }

  // Pelanggan yang sudah membayar tapi tetap tidak bisa internetan adalah
  // keluhan paling merusak kepercayaan. Jangan menunggu mereka menelepon.
  if (result.failed > 0) {
    await alert.send(
      'reconcile:stuck',
      'critical',
      `${result.failed} layanan sudah LUNAS tapi gagal dibuka isolirnya.\n\n` +
      `Contoh error: ${result.errors[0]?.message}\n\n` +
      'Pelanggan ini sudah membayar dan masih tidak bisa internetan. ' +
      'Periksa panel → Pelanggan → Riwayat layanan.',
      { cooldownMinutes: 60 }
    ).catch(() => {});
  }

  return result;
}

/**
 * Health-check router. Mengisi routers.status untuk dashboard,
 * dan mengirim alert kalau ada yang offline berkepanjangan.
 */
async function healthCheck() {
  const routers = await Router.find({}).select('+secret_enc');
  const result = { total: routers.length, online: 0, offline: 0, offline_names: [] };

  for (const router of routers) {
    const res = await routeros.ping(router);

    await Router.updateOne(
      { _id: router._id },
      {
        $set: {
          status: res.success ? 'online' : 'offline',
          ...(res.success ? { last_seen_at: new Date() } : {}),
        },
      }
    );

    if (res.success) {
      result.online++;
      continue;
    }

    result.offline++;
    result.offline_names.push(router.name);

    // Alert hanya kalau sudah offline cukup lama — MikroTik yang
    // restart sebentar tidak perlu membangunkan siapa pun.
    const offlineMin = router.last_seen_at
      ? (Date.now() - new Date(router.last_seen_at).getTime()) / 60_000
      : Infinity;

    if (offlineMin > ROUTER_OFFLINE_ALERT_MIN) {
      await alert.send(
        `router:offline:${router.name}`,
        'critical',
        `Router ${router.name}${router.site ? ` (${router.site})` : ''} tidak terjangkau ` +
        `sejak ${fmtTime(router.last_seen_at)}.\n\n` +
        'Dampak: isolir otomatis dan pembukaan isolir setelah pembayaran ' +
        'tidak jalan di router ini.\n\n' +
        'Periksa koneksi VPN ke router dan listrik di lokasi.',
        { cooldownMinutes: 120 }
      ).catch(() => {});
    }
  }

  return result;
}

function fmtTime(d) {
  if (!d) return 'entah kapan';
  return new Date(d).toLocaleString('id-ID', {
    timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/* ------------------------------------------------------------------ */
/* Jadwal                                                              */
/* ------------------------------------------------------------------ */

function start() {
  const opts = { timezone: TZ };

  // 00:10 — terbitkan invoice yang jatuh tempo dalam 7 hari ke depan
  cron.schedule('10 0 * * *', () => {
    runLocked('invoice-generator', () => invoiceGenerator.run());
  }, opts);

  // 08:00 — pengingat H-2 sebelum isolir (jam manusiawi, bukan tengah malam)
  cron.schedule('0 8 * * *', () => {
    runLocked('reminder', () => isolation.runReminder());
  }, opts);

  // 09:00 — isolir yang lewat tenggang. Sengaja jam kerja, supaya kalau
  // ada yang salah isolir, admin masih bangun dan bisa segera membuka.
  cron.schedule('0 9 * * *', () => {
    runLocked('isolation', () => isolation.run());
  }, opts);

  // Tiap 15 menit — sinkronkan yang sudah lunas tapi masih terisolir
  cron.schedule('*/15 * * * *', () => {
    runLocked('reconcile', () => reconcile());
  }, opts);

  // Tiap 5 menit — status router
  cron.schedule('*/5 * * * *', () => {
    runLocked('health-check', () => healthCheck());
  }, opts);

  // Tiap 5 menit — kesehatan WhatsApp. Interval pendek disengaja:
  // nomor yang diblokir jam 9 pagi tidak boleh baru ketahuan besok.
  cron.schedule('*/5 * * * *', () => {
    runLocked('wa-watchdog', () => watchdog.run());
  }, opts);

  // 03:00 — verifikasi profile paket di semua router. Profile yang
  // diubah manual lewat Winbox akan ketahuan di sini.
  cron.schedule('0 3 * * *', () => {
    runLocked('plan-verify', async () => {
      const { verifyAll } = require('../routes/admin-plans');
      const result = await verifyAll();

      if (result.missing > 0 || result.out_of_sync > 0) {
        await alert.send(
          'plans:out_of_sync',
          'warning',
          `${result.missing} profile paket hilang dan ${result.out_of_sync} tidak cocok ` +
          'dengan rate-limit paket.\n\n' +
          result.issues.slice(0, 5).map((i) => `- ${i.plan} @ ${i.router}: ${i.problem}`).join('\n') +
          '\n\nLayanan dengan profile hilang tidak bisa dibuka isolirnya. ' +
          'Perbaiki di panel: Paket → Sinkronkan.',
          { cooldownMinutes: 720 }
        ).catch(() => {});
      }

      return result;
    });
  }, opts);

  console.log(`[cron] scheduler aktif, timezone ${TZ}`);

  // Peringatan sekali saat start kalau alert belum dikonfigurasi.
  // Sistem yang bisa memberi tahu tapi tidak punya tujuan kirim sama
  // saja dengan sistem yang diam.
  if (!alert.configured().any) {
    console.warn(
      '[cron] PERINGATAN: kanal alert belum diatur. Isi TELEGRAM_BOT_TOKEN + ' +
      'TELEGRAM_CHAT_ID atau ALERT_WEBHOOK_URL di .env, kalau tidak masalah ' +
      'WhatsApp dan router hanya tercatat di log.'
    );
  }
}

function stop() {
  cron.getTasks().forEach((task) => task.stop());
  routeros.closeAll();
}

module.exports = { start, stop, reconcile, healthCheck, runLocked };

/* ==================================================================
 * MENJALANKAN MANUAL (untuk tes sebelum dipasang cron)
 * ==================================================================
 *   node -e "require('dotenv').config(); \
 *     require('mongoose').connect(process.env.MONGO_URI).then(async () => { \
 *       const r = await require('./jobs/invoice-generator').run(); \
 *       console.log(r); process.exit(0); \
 *     })"
 *
 * Tes alert (paling penting dilakukan lebih dulu):
 *   node -e "require('dotenv').config(); \
 *     require('mongoose').connect(process.env.MONGO_URI).then(async () => { \
 *       console.log(await require('./services/alert').test()); process.exit(0); \
 *     })"
 * ================================================================== */

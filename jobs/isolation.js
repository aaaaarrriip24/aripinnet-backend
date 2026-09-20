/**
 * Job isolir otomatis.
 *
 * VERSI 2 — restore kini me-resolve PPP profile per router lewat
 * lib/plan-profile.js. Pesan error dibuat spesifik supaya admin tahu
 * harus berbuat apa, karena kegagalan restore berarti pelanggan yang
 * sudah membayar tetap tidak bisa internetan.
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { Invoice, Service, Router, Plan, ServiceEvent, Notification } = require('../models');
const routeros = require('../services/routeros');

const TZ = process.env.TZ_APP || 'Asia/Jakarta';
const GRACE_DAYS = Number(process.env.ISOLIR_GRACE_DAYS || 3);

/**
 * Isolir satu service. Dipakai job ini dan endpoint manual di panel.
 */
async function isolateService(service, opts = {}) {
  const router = await Router.findById(service.router_id).select('+secret_enc');
  if (!router) {
    return logEvent(service, 'isolate', opts, false, 'Router tidak ditemukan');
  }

  const result = await routeros.isolate(router, service);

  if (result.success) {
    service.status = 'isolated';
    service.isolated_at = new Date();
    await service.save();
  }

  await logEvent(
    service,
    'isolate',
    opts,
    result.success,
    result.success ? JSON.stringify(result.raw) : result.message
  );

  return result;
}

/**
 * Buka isolir. Dipanggil dari handler settlement pembayaran, BUKAN dari
 * dalam transaksi database — lihat catatan di bawah file.
 */
async function restoreService(service, opts = {}) {
  const router = await Router.findById(service.router_id).select('+secret_enc');
  if (!router) {
    return logEvent(service, 'restore', opts, false, 'Router tidak ditemukan');
  }

  // Ambil plan lengkap dengan profiles[] — populate('plan_id') pada
  // dokumen service sudah cukup, tapi Plan.findById lebih eksplisit dan
  // menghindari masalah kalau service sudah ter-populate sebagian.
  const plan = await Plan.findById(service.plan_id);
  if (!plan) {
    return logEvent(service, 'restore', opts, false, 'Paket tidak ditemukan');
  }

  const result = await routeros.restore(router, service, plan);

  if (result.success) {
    service.status = 'active';
    service.isolated_at = null;
    await service.save();
  }

  await logEvent(
    service,
    'restore',
    opts,
    result.success,
    result.success ? JSON.stringify(result.raw) : result.message
  );

  return result;
}

async function logEvent(service, action, opts, success, response) {
  await ServiceEvent.create({
    service_id: service._id,
    admin_id:   opts.adminId || null,
    action,
    trigger:    opts.trigger || 'manual',
    success,
    router_response: String(response).slice(0, 1000),
  });
  return { success, message: response };
}

/**
 * Job utama: isolir semua yang nunggak.
 */
async function run() {
  const cutoff = dayjs().tz(TZ).subtract(GRACE_DAYS, 'day').startOf('day').toDate();

  const overdue = await Invoice.distinct('service_id', {
    status: 'unpaid',
    due_date: { $lt: cutoff },
  });

  const services = await Service.find({
    _id: { $in: overdue },
    status: 'active',
  });

  const result = { candidates: services.length, isolated: 0, failed: 0, errors: [] };

  for (const service of services) {
    const res = await isolateService(service, { trigger: 'auto' });

    if (res.success) {
      result.isolated++;
      await queueIsolirNotification(service);
    } else {
      result.failed++;
      result.errors.push({ service: String(service._id), message: res.message });
    }
  }

  return result;
}

async function queueIsolirNotification(service) {
  await service.populate('customer_id', 'name phone');
  try {
    await Notification.create({
      customer_id: service.customer_id._id,
      channel:  'whatsapp',
      template: 'isolir',
      payload:  { nama: service.customer_id.name },
      status:   'queued',
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
}

/**
 * Pengingat H-2 sebelum isolir.
 */
async function runReminder() {
  const from = dayjs().tz(TZ).startOf('day').toDate();
  const to = dayjs().tz(TZ).add(2, 'day').endOf('day').toDate();

  const invoices = await Invoice.find({
    status: 'unpaid',
    due_date: { $gte: from, $lte: to },
  }).populate('customer_id', 'name phone');

  let queued = 0;
  for (const inv of invoices) {
    try {
      await Notification.create({
        customer_id: inv.customer_id._id,
        invoice_id:  inv._id,
        channel:  'whatsapp',
        template: 'h2_jatuh_tempo',
        payload: {
          nama:  inv.customer_id.name,
          nomor: inv.number,
          total: inv.total_idr,
          jatuh_tempo: dayjs(inv.due_date).tz(TZ).format('DD MMM YYYY'),
        },
        status: 'queued',
      });
      queued++;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }

  return { checked: invoices.length, queued };
}

module.exports = { run, runReminder, isolateService, restoreService };

/* ==================================================================
 * CATATAN: URUTAN SAAT PEMBAYARAN MASUK
 * ==================================================================
 * JANGAN panggil restoreService() di dalam session.withTransaction().
 * Kalau router timeout, transaksi DB ikut rollback dan pembayaran hilang
 * padahal uang sudah masuk ke rekening.
 *
 * Urutan yang benar di webhook handler:
 *   1. Transaksi DB: payments.status = settled, invoices.status = paid.
 *      Commit.
 *   2. Setelah commit sukses, baru panggil restoreService().
 *   3. Kalau langkah 2 gagal, biarkan — service tetap 'isolated' di DB,
 *      dan job reconcile (lihat scheduler) akan mencoba lagi.
 *
 * Pembayaran tidak boleh bergantung pada router yang hidup.
 *
 * PENYEBAB BARU KEGAGALAN RESTORE (versi 2):
 * Paket belum dipetakan ke profile di router tersebut, atau profile-nya
 * tidak ada di router. Pesannya muncul di riwayat layanan. Perbaikannya:
 * Paket → pilih paket → Sinkronkan ke router. Setelah itu job reconcile
 * akan membuka isolirnya sendiri dalam 15 menit.
 * ================================================================== */

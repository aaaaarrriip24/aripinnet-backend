/**
 * Worker pengirim notifikasi WhatsApp.
 *
 * VERSI 3 — perubahan:
 * - Heartbeat ke koleksi wa_statuses, supaya watchdog di proses lain
 *   bisa tahu worker ini masih hidup
 * - Menyimpan kondisi koneksi (connected / banned / kode disconnect)
 * - Berhenti bekerja kalau nomor diblokir, alih-alih mengulang selamanya
 *
 * Model: outbox pattern. Job lain hanya menulis dokumen Notification
 * berstatus 'queued' — tidak ada satu pun yang memanggil WhatsApp langsung.
 *
 * Worker ini WAJIB satu proses saja (pm2 -i 1). Session Baileys tidak
 * bisa dipakai dua proses; keduanya akan saling menendang sampai session
 * rusak dan nomor berisiko diblokir.
 */

const { Notification, Customer, WaStatus } = require('../models');
const wa = require('../services/whatsapp');
const alert = require('../services/alert');
const settings = require('../lib/settings');
const { render } = require('../templates/messages');

const BATCH_SIZE    = Number(process.env.WA_BATCH_SIZE || 20);
const MAX_RETRY     = Number(process.env.WA_MAX_RETRY || 3);
const HOURLY_LIMIT  = Number(process.env.WA_HOURLY_LIMIT || 120);
const MIN_DELAY_MS  = Number(process.env.WA_MIN_DELAY_MS || 4000);
const MAX_DELAY_MS  = Number(process.env.WA_MAX_DELAY_MS || 12000);
const QUIET_START   = Number(process.env.WA_QUIET_START || 21);
const QUIET_END     = Number(process.env.WA_QUIET_END || 7);

const IDLE_POLL_MS     = 15_000;
const PRIORITY_POLL_MS = 3_000;
const HEARTBEAT_MS     = 60_000;

/** Template yang dikirim SEKARANG, apa pun jamnya. */
const PRIORITY_TEMPLATES = ['otp'];

let sentThisHour = 0;
let hourMark = new Date().getHours();
let running = false;
let heartbeatTimer = null;
let qrWatchTimer = null;
// Stempel waktu permintaan QR terakhir yang sudah dilayani, supaya satu
// permintaan tidak memicu reconnect berulang tiap kali timer berdetak.
let lastQrRefreshHandled = 0;

/* ------------------------------------------------------------------ */
/* Status ke database                                                  */
/* ------------------------------------------------------------------ */

async function patchStatus(fields) {
  try {
    await WaStatus.findByIdAndUpdate(
      'wa',
      { $set: { ...fields, heartbeat_at: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    // Status gagal tersimpan bukan alasan menghentikan pengiriman
    console.error('[wa-worker] gagal simpan status:', err.message);
  }
}

/**
 * Terjemahkan event dari adapter WhatsApp jadi perubahan status DB.
 * Alert-nya sendiri dikirim watchdog, bukan di sini — supaya logika
 * "kapan harus berteriak" tinggal di satu tempat.
 */
function handleWaEvent({ event, jid, code, kind, message, qr }) {
  if (event === 'qr') {
    // Disimpan supaya bisa dipindai dari panel. Dibuang lagi begitu
    // tersambung — QR yang sudah terpakai tidak berguna dan tidak perlu
    // tersimpan lebih lama dari yang diperlukan.
    patchStatus({ qr, qr_at: new Date(), connected: false });
    return;
  }

  if (event === 'connected') {
    patchStatus({
      connected: true, banned: false, jid,
      last_connected_at: new Date(), consecutive_failures: 0, last_error: null,
      qr: null, qr_at: null,
    });
    // Nomor yang baru saja memindai QR langsung menjadi nomor CS, tanpa
    // menunggu TTL cache — pesan berikutnya harus sudah memakai nomor ini.
    settings.setFromJid(jid);
    return;
  }

  if (event === 'disconnected') {
    patchStatus({
      connected: false,
      last_disconnect_at: new Date(),
      last_disconnect_code: code || null,
      last_error: message || null,
    });
    return;
  }

  if (event === 'needs_human') {
    patchStatus({
      connected: false,
      banned: true,
      banned_at: new Date(),
      last_disconnect_code: code || null,
      last_error: message || null,
    });

    // Ini satu-satunya alert yang dikirim langsung dari worker: kalau
    // worker mati setelah ini, watchdog tetap akan mendeteksinya dari
    // heartbeat yang basi — tapi lebih cepat memberitahu sekarang.
    alert.send(
      'wa:needs_human',
      'critical',
      `${message}\n\nSeluruh notifikasi WhatsApp berhenti: tagihan, pengingat, ` +
      'pemberitahuan isolir, dan kode login aplikasi pelanggan.\n\n' +
      'Langkah perbaikan ada di panel: Sistem → WhatsApp.',
      { cooldownMinutes: 180 }
    ).catch((e) => console.error('[wa-worker] alert gagal:', e.message));
    return;
  }

  if (event === 'sent') {
    patchStatus({ last_sent_at: new Date() });
  }
}

/* ------------------------------------------------------------------ */
/* Antrian                                                             */
/* ------------------------------------------------------------------ */

function randomDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function isQuietHours() {
  const h = new Date().getHours();
  return QUIET_START > QUIET_END
    ? (h >= QUIET_START || h < QUIET_END)
    : (h >= QUIET_START && h < QUIET_END);
}

function checkHourlyLimit() {
  const h = new Date().getHours();
  if (h !== hourMark) {
    hourMark = h;
    sentThisHour = 0;
  }
  return sentThisHour < HOURLY_LIMIT;
}

async function fetchQueue() {
  const base = { channel: 'whatsapp', status: 'queued', retry_count: { $lt: MAX_RETRY } };

  const priority = await Notification.find({ ...base, template: { $in: PRIORITY_TEMPLATES } })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE);

  if (isQuietHours()) return { items: priority };

  const remaining = BATCH_SIZE - priority.length;
  if (remaining <= 0) return { items: priority };

  const normal = await Notification.find({ ...base, template: { $nin: PRIORITY_TEMPLATES } })
    .sort({ createdAt: 1 })
    .limit(remaining);

  return { items: priority.concat(normal) };
}

async function processBatch() {
  if (!checkHourlyLimit()) return { skipped: 'batas per jam tercapai', sent: 0, failed: 0 };

  const { items } = await fetchQueue();
  if (items.length === 0) return { sent: 0, failed: 0, hadPriority: false };

  const result = { sent: 0, failed: 0, permanent: 0, hadPriority: false };

  for (const notif of items) {
    if (!checkHourlyLimit()) break;

    const isPriority = PRIORITY_TEMPLATES.includes(notif.template);
    if (isPriority) result.hadPriority = true;

    try {
      const customer = await Customer.findById(notif.customer_id).select('name phone');
      if (!customer?.phone) {
        await markPermanentFail(notif, 'Pelanggan tidak punya nomor HP');
        result.permanent++;
        continue;
      }

      const body = render(notif.template, { nama: customer.name, ...notif.payload });
      await wa.sendText(customer.phone, body);

      notif.status  = 'sent';
      // Isi OTP tidak disimpan — kodenya tidak boleh tersisa di database
      notif.body    = isPriority ? '[dirahasiakan]' : body;
      notif.sent_at = new Date();
      if (isPriority) notif.payload = undefined;
      await notif.save();

      sentThisHour++;
      result.sent++;

      await patchStatus({ consecutive_failures: 0 });
      await wa.sleep(isPriority ? 500 : randomDelay());
    } catch (err) {
      if (err.permanent) {
        await markPermanentFail(notif, err.message);
        result.permanent++;
        continue;
      }

      notif.retry_count += 1;
      notif.last_error = err.message;
      if (notif.retry_count >= MAX_RETRY) notif.status = 'failed';
      await notif.save();

      result.failed++;
      console.error(`[wa-worker] gagal kirim ${notif._id}:`, err.message);

      await WaStatus.findByIdAndUpdate(
        'wa',
        { $inc: { consecutive_failures: 1 }, $set: { last_error: err.message, heartbeat_at: new Date() } },
        { upsert: true }
      ).catch(() => {});

      // Masalah koneksi: hentikan batch. Mencoba terus saat session mati
      // hanya menambah percobaan reconnect dan memperbesar risiko blokir.
      if (/koneksi|timeout|connection|diblokir/i.test(err.message)) break;

      await wa.sleep(randomDelay());
    }
  }

  return result;
}

async function markPermanentFail(notif, message) {
  notif.status = 'failed';
  notif.retry_count = MAX_RETRY;
  notif.last_error = message;
  await notif.save();
}

/* ------------------------------------------------------------------ */
/* Loop utama                                                          */
/* ------------------------------------------------------------------ */

async function start() {
  if (running) return;
  running = true;

  // Pulihkan nomor CS dari nomor yang terakhir tertaut, supaya pesan yang
  // dikirim sebelum koneksi WhatsApp terbentuk tidak memakai nomor .env
  // yang mungkin sudah usang.
  await settings.refresh({ force: true });

  // Anggap permintaan QR yang sudah ada sebagai sudah dilayani. Tanpa ini,
  // permintaan lama dari kapan pun akan terputar ulang setiap worker
  // restart dan memutus koneksi yang baru saja terbentuk.
  try {
    const s = await WaStatus.findById('wa').select('qr_refresh_at').lean();
    if (s?.qr_refresh_at) lastQrRefreshHandled = new Date(s.qr_refresh_at).getTime();
  } catch (_) { /* biarkan 0 — paling banter satu reconnect tambahan */ }

  wa.onStatus(handleWaEvent);

  // Heartbeat terpisah dari loop kerja: kalau pengiriman menggantung,
  // heartbeat ikut berhenti dan watchdog tahu ada yang tidak beres.
  heartbeatTimer = setInterval(() => {
    const s = wa.status();
    patchStatus({ connected: s.ready, banned: s.banned, jid: s.jid });
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  // Pantau permintaan "buat ulang QR" dari panel.
  //
  // Intervalnya 5 detik, bukan mengikuti heartbeat yang 60 detik: di ujung
  // sana ada admin yang sedang berdiri sambil memegang HP, dan menunggu
  // semenit setelah menekan tombol akan terasa seperti tombolnya rusak.
  qrWatchTimer = setInterval(async () => {
    try {
      const s = await WaStatus.findById('wa').select('qr_refresh_at').lean();
      const at = s?.qr_refresh_at ? new Date(s.qr_refresh_at).getTime() : 0;
      if (!at || at <= lastQrRefreshHandled) return;

      lastQrRefreshHandled = at;
      console.log('[wa-worker] permintaan QR baru dari panel');
      await wa.forceReconnect().catch((e) =>
        console.error('[wa-worker] gagal buat ulang QR:', e.message));
    } catch (err) {
      console.error('[wa-worker] pantau QR gagal:', err.message);
    }
  }, 5_000);
  qrWatchTimer.unref?.();

  console.log('[wa-worker] menghubungkan ke WhatsApp...');
  try {
    await wa.connect();
    console.log('[wa-worker] siap');
  } catch (err) {
    console.error('[wa-worker] gagal konek:', err.message);
    await patchStatus({ connected: false, last_error: err.message });
  }

  while (running) {
    let fast = false;

    if (wa.status().banned) {
      // Nomor mati. Terus mencoba tidak akan memperbaiki apa pun —
      // yang dibutuhkan adalah manusia mengganti nomor. Heartbeat tetap
      // jalan supaya dashboard menunjukkan kondisi sebenarnya.
      await patchStatus({ connected: false, banned: true });
      await wa.sleep(60_000);
      continue;
    }

    try {
      const result = await processBatch();
      if (result.sent || result.failed) console.log('[wa-worker]', JSON.stringify(result));
      fast = result.hadPriority;
    } catch (err) {
      console.error('[wa-worker] error batch:', err.message);
    }

    await wa.sleep(fast ? PRIORITY_POLL_MS : IDLE_POLL_MS);
  }
}

function stop() {
  running = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (qrWatchTimer) clearInterval(qrWatchTimer);
}

module.exports = { start, stop, processBatch, patchStatus, PRIORITY_TEMPLATES };

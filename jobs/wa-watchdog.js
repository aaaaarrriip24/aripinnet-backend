/**
 * Watchdog WhatsApp.
 *
 * Berjalan di API server (proses berbeda dari worker WhatsApp), setiap
 * beberapa menit. Tugasnya menjawab satu pertanyaan: apakah notifikasi
 * ke pelanggan masih benar-benar terkirim?
 *
 * Kenapa perlu proses terpisah: kalau worker WhatsApp yang mati — bukan
 * sekadar koneksinya yang putus — tidak ada siapa pun di dalam worker
 * yang bisa melapor. Heartbeat basi adalah satu-satunya cara tahu.
 *
 * Empat kondisi yang dipantau, dari yang paling parah:
 *   1. banned      — nomor diblokir/dicabut, harus ganti nomor
 *   2. worker mati — heartbeat tidak diperbarui
 *   3. terputus    — worker hidup tapi tidak tersambung WhatsApp
 *   4. gagal massal— terkirim tapi banyak yang ditolak
 *   5. antrian macet— pesan menumpuk tanpa terkirim
 */

const { WaStatus, Notification } = require('../models');
const alert = require('../services/alert');

const HEARTBEAT_STALE_MIN   = Number(process.env.WA_HEARTBEAT_STALE_MIN || 5);
const DISCONNECT_ALERT_MIN  = Number(process.env.WA_DISCONNECT_ALERT_MIN || 10);
const FAILURE_THRESHOLD     = Number(process.env.WA_FAILURE_THRESHOLD || 5);
const BACKLOG_THRESHOLD     = Number(process.env.WA_BACKLOG_THRESHOLD || 20);
const BACKLOG_AGE_MIN       = Number(process.env.WA_BACKLOG_AGE_MIN || 60);

/**
 * Satu siklus pemeriksaan. Return ringkasan untuk log cron.
 */
async function run() {
  const now = Date.now();
  const status = await WaStatus.findById('wa').lean();

  const result = { checked: true, alerts: [], healthy: true };

  /* ---- 0. Worker belum pernah jalan ---- */
  if (!status) {
    result.healthy = false;
    result.alerts.push('worker belum pernah berjalan');

    await alert.send(
      'wa:never_started',
      'warning',
      'Worker WhatsApp belum pernah berjalan sejak sistem dipasang.\n\n' +
      'Jalankan: pm2 start worker.js --name billing-wa -i 1\n' +
      'Lalu scan QR yang muncul di: pm2 logs billing-wa',
      { cooldownMinutes: 360 }
    );
    return result;
  }

  const heartbeatAge = status.heartbeat_at
    ? (now - new Date(status.heartbeat_at).getTime()) / 60_000
    : Infinity;

  /* ---- 1. Nomor diblokir ---- */
  if (status.banned) {
    result.healthy = false;
    result.alerts.push('banned');

    await alert.send(
      'wa:banned',
      'critical',
      'NOMOR WHATSAPP TIDAK BISA DIPAKAI.\n\n' +
      `Penyebab: ${status.last_error || 'session dicabut'}\n` +
      `Sejak: ${fmt(status.banned_at || status.last_disconnect_at)}\n\n` +
      'Dampak: semua notifikasi berhenti — tagihan, pengingat jatuh tempo, ' +
      'pemberitahuan isolir, dan kode login aplikasi pelanggan.\n\n' +
      'Perbaikan:\n' +
      '1. Siapkan nomor WhatsApp baru (jangan nomor pribadi)\n' +
      '2. pm2 stop billing-wa\n' +
      '3. Hapus folder .wa-session\n' +
      '4. pm2 start billing-wa lalu scan QR dari pm2 logs billing-wa\n' +
      '5. Perbarui CS_PHONE di .env kalau nomornya berubah',
      { cooldownMinutes: 360 }
    );

    // Kondisi 2-5 tidak perlu diperiksa lagi — semuanya akibat dari ini.
    return result;
  }

  /* ---- 2. Worker mati ---- */
  if (heartbeatAge > HEARTBEAT_STALE_MIN) {
    result.healthy = false;
    result.alerts.push('worker mati');

    await alert.send(
      'wa:worker_down',
      'critical',
      'Worker WhatsApp berhenti berjalan.\n\n' +
      `Kabar terakhir: ${fmt(status.heartbeat_at)} (${Math.round(heartbeatAge)} menit lalu)\n\n` +
      'Dampak: tidak ada notifikasi yang terkirim, dan pelanggan tidak bisa ' +
      'login ke aplikasi karena kode OTP tidak sampai.\n\n' +
      'Periksa: pm2 status  dan  pm2 logs billing-wa --lines 50',
      { cooldownMinutes: 60 }
    );
    return result;
  }

  /* ---- 3. Worker hidup tapi tidak tersambung ---- */
  if (!status.connected) {
    const offlineMin = status.last_disconnect_at
      ? (now - new Date(status.last_disconnect_at).getTime()) / 60_000
      : DISCONNECT_ALERT_MIN + 1;

    if (offlineMin > DISCONNECT_ALERT_MIN) {
      result.healthy = false;
      result.alerts.push('terputus');

      await alert.send(
        'wa:disconnected',
        'warning',
        `WhatsApp terputus lebih dari ${Math.round(offlineMin)} menit.\n\n` +
        `Kode: ${status.last_disconnect_code || '-'}\n` +
        `Pesan: ${status.last_error || '-'}\n\n` +
        'Worker masih mencoba menyambung sendiri. Kalau dalam satu jam ' +
        'belum pulih, kemungkinan session bermasalah dan perlu scan ulang.',
        { cooldownMinutes: 60 }
      );
    }
    return result;
  }

  /* ---- 4. Gagal massal ---- */
  const failedLastHour = await Notification.countDocuments({
    status: 'failed',
    updatedAt: { $gte: new Date(now - 60 * 60_000) },
  });

  if (failedLastHour >= FAILURE_THRESHOLD) {
    result.healthy = false;
    result.alerts.push(`${failedLastHour} gagal`);

    await alert.send(
      'wa:mass_failure',
      'warning',
      `${failedLastHour} notifikasi gagal dikirim dalam satu jam terakhir.\n\n` +
      `Error terakhir: ${status.last_error || '-'}\n\n` +
      'Kalau angkanya terus naik, biasanya nomor sedang dibatasi WhatsApp ' +
      'sebelum diblokir penuh. Kurangi WA_HOURLY_LIMIT dan perbesar jeda ' +
      'kirim (WA_MIN_DELAY_MS) untuk sementara.',
      { cooldownMinutes: 120 }
    );
  }

  /* ---- 5. Antrian macet ---- */
  const stuck = await Notification.countDocuments({
    status: 'queued',
    createdAt: { $lt: new Date(now - BACKLOG_AGE_MIN * 60_000) },
  });

  if (stuck >= BACKLOG_THRESHOLD) {
    result.healthy = false;
    result.alerts.push(`${stuck} antre lama`);

    await alert.send(
      'wa:backlog',
      'warning',
      `${stuck} notifikasi masih mengantre lebih dari ${BACKLOG_AGE_MIN} menit.\n\n` +
      'Koneksi WhatsApp terlihat normal, jadi kemungkinan batas kirim per jam ' +
      `tercapai (WA_HOURLY_LIMIT=${process.env.WA_HOURLY_LIMIT || 120}) atau ` +
      'sedang jam tenang. Antrian akan jalan sendiri — periksa lagi nanti.',
      { cooldownMinutes: 180 }
    );
  }

  /* ---- Pulih ---- */
  if (result.healthy) {
    const { AlertLog } = require('../models');
    const openIssue = await AlertLog.findOne({
      key: { $in: ['wa:banned', 'wa:worker_down', 'wa:disconnected', 'wa:mass_failure'] },
      resolved: false,
    });

    if (openIssue) {
      await alert.resolve(
        openIssue.key,
        `WhatsApp kembali normal.\n\nTersambung sebagai ${status.jid || '-'}. ` +
        'Antrian notifikasi yang tertunda akan dikirim bertahap.'
      );
      result.alerts.push('pulih');
    }
  }

  return result;
}

function fmt(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString('id-ID', {
    timeZone: process.env.TZ_APP || 'Asia/Jakarta',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

module.exports = { run };

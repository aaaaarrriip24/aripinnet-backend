/**
 * API status sistem: WhatsApp, alert, dan pemeriksaan kesehatan.
 *
 * Dipasang di /api/admin/system.
 */

const express = require('express');
const QRCode = require('qrcode');
const router = express.Router();

const { WaStatus, AlertLog, Notification, Router: RouterModel } = require('../models');
const alert = require('../services/alert');
const watchdog = require('../jobs/wa-watchdog');
const { requireRole } = require('../middleware/auth');

// QR WhatsApp berganti tiap ~20 detik. Diberi kelonggaran sedikit supaya
// tidak hilang-timbul di layar saat panel melakukan polling.
const QR_MAX_AGE_SEC = 60;

/* ------------------------------------------------------------------ */
/* Status WhatsApp                                                     */
/* ------------------------------------------------------------------ */

router.get('/whatsapp', async (req, res) => {
  try {
    const status = await WaStatus.findById('wa').lean();
    const now = Date.now();

    const heartbeatAge = status?.heartbeat_at
      ? Math.round((now - new Date(status.heartbeat_at).getTime()) / 60_000)
      : null;

    const [queued, failedLastHour, sentLastHour] = await Promise.all([
      Notification.countDocuments({ status: 'queued' }),
      Notification.countDocuments({ status: 'failed', updatedAt: { $gte: new Date(now - 3600_000) } }),
      Notification.countDocuments({ status: 'sent', sent_at: { $gte: new Date(now - 3600_000) } }),
    ]);

    // Satu kata yang menjawab "apakah ini bermasalah?"
    let health = 'ok';
    let reason = null;

    if (!status) {
      health = 'unknown';
      reason = 'Worker WhatsApp belum pernah berjalan';
    } else if (status.banned) {
      health = 'critical';
      reason = status.last_error || 'Nomor diblokir atau session dicabut';
    } else if (heartbeatAge === null || heartbeatAge > 5) {
      health = 'critical';
      reason = `Worker tidak memberi kabar ${heartbeatAge ?? '?'} menit`;
    } else if (!status.connected) {
      health = 'warning';
      reason = 'Sedang terputus, mencoba menyambung ulang';
    } else if (failedLastHour >= 5) {
      health = 'warning';
      reason = `${failedLastHour} pengiriman gagal dalam sejam terakhir`;
    }

    // QR pairing — hanya kalau masih segar. QR WhatsApp berganti tiap
    // ~20 detik; menampilkan yang basi membuat admin memindai berulang
    // kali tanpa hasil dan menyangka sistemnya rusak.
    let qr = null;
    const qrAgeSec = status?.qr_at
      ? Math.round((now - new Date(status.qr_at).getTime()) / 1000)
      : null;

    if (status?.qr && qrAgeSec !== null && qrAgeSec < QR_MAX_AGE_SEC && !status.connected) {
      qr = {
        png: await QRCode.toDataURL(status.qr, { margin: 1, width: 320 }),
        age_sec: qrAgeSec,
      };
    }

    return res.json({
      health,
      reason,
      status: status ? { ...status, qr: undefined } : null,
      heartbeat_age_min: heartbeatAge,
      qr,
      antrian: { queued, failed_1h: failedLastHour, sent_1h: sentLastHour },
      alert_channels: alert.configured(),
    });
  } catch (err) {
    console.error('[system/whatsapp]', err.message);
    return res.status(500).json({ message: 'Gagal memuat status' });
  }
});

/**
 * POST /api/admin/system/whatsapp/reset-banned
 *
 * Dipanggil setelah admin mengganti nomor dan menghapus folder session.
 * Tidak otomatis: selama flag banned menyala, worker berhenti mencoba —
 * itu justru yang mencegah nomor pengganti ikut kena blokir.
 */
router.post('/whatsapp/reset-banned', requireRole('owner', 'admin'), async (req, res) => {
  try {
    await WaStatus.findByIdAndUpdate(
      'wa',
      { $set: { banned: false, banned_at: null, last_error: null, consecutive_failures: 0 } },
      { upsert: true }
    );

    await AlertLog.updateMany(
      { key: { $in: ['wa:banned', 'wa:needs_human'] }, resolved: false },
      { $set: { resolved: true } }
    );

    return res.json({
      message: 'Status direset. Jalankan ulang worker: pm2 restart billing-wa, ' +
               'lalu scan QR dari pm2 logs billing-wa',
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/admin/system/whatsapp/retry-failed
 * Kembalikan notifikasi gagal ke antrian setelah masalah diperbaiki.
 */
router.post('/whatsapp/retry-failed', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const hours = Math.min(168, Number(req.body.hours) || 24);

    const result = await Notification.updateMany(
      {
        status: 'failed',
        updatedAt: { $gte: new Date(Date.now() - hours * 3600_000) },
        // Nomor yang memang tidak terdaftar di WhatsApp jangan diulang —
        // hasilnya akan gagal lagi dan hanya membuang jatah kirim.
        last_error: { $not: /tidak terdaftar|tidak punya nomor/i },
      },
      { $set: { status: 'queued', retry_count: 0, last_error: null } }
    );

    return res.json({
      message: `${result.modifiedCount} notifikasi dikembalikan ke antrian`,
      count: result.modifiedCount,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Alert                                                               */
/* ------------------------------------------------------------------ */

router.get('/alerts', async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const items = await AlertLog.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({ items, channels: alert.configured() });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal memuat alert' });
  }
});

/**
 * POST /api/admin/system/alerts/test
 * Kirim pesan uji. Wajib dijalankan sekali setelah setup — kanal alert
 * yang belum pernah diuji sama saja dengan tidak ada.
 */
router.post('/alerts/test', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const conf = alert.configured();
    if (!conf.any) {
      return res.status(400).json({
        message: 'Belum ada kanal alert. Isi TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID ' +
                 'atau ALERT_WEBHOOK_URL di .env, lalu restart API server.',
      });
    }

    const result = await alert.test();
    return res.json({
      sent: result.sent,
      channels: result.channels,
      message: result.sent
        ? `Pesan uji terkirim lewat: ${result.channels.join(', ')}`
        : 'Gagal mengirim. Periksa token dan chat id di .env, lalu lihat log server.',
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Pemeriksaan manual                                                  */
/* ------------------------------------------------------------------ */

router.post('/healthcheck', async (req, res) => {
  try {
    const wa = await watchdog.run();
    const routers = await RouterModel.find({}).select('name status last_seen_at').lean();

    return res.json({
      whatsapp: wa,
      routers: routers.map((r) => ({
        name: r.name, status: r.status, last_seen_at: r.last_seen_at,
      })),
      offline_routers: routers.filter((r) => r.status !== 'online').map((r) => r.name),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;

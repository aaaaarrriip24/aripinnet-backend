/**
 * Pengiriman alert ke admin.
 *
 * Aturan paling penting di file ini: alert TIDAK BOLEH lewat WhatsApp.
 * Hal yang paling sering perlu dialertkan justru matinya jalur WhatsApp
 * itu sendiri — memakai kanal yang sama berarti alert paling penting
 * adalah alert yang tidak akan pernah terkirim.
 *
 * Kanal yang dipakai, semua opsional dan bisa dinyalakan bersamaan:
 *   - Telegram bot   : TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   - Webhook umum   : ALERT_WEBHOOK_URL (Discord, Slack, n8n, dll)
 *   - Log stdout     : selalu, dibaca lewat `pm2 logs`
 *
 * Telegram disarankan: gratis, tidak butuh nomor kedua, dan tidak
 * bergantung pada infrastruktur yang sedang bermasalah.
 *
 * Tidak ada dependensi tambahan — memakai fetch bawaan Node 18+.
 */

const { AlertLog } = require('../models');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_URL    = process.env.ALERT_WEBHOOK_URL;
const ISP_NAME       = process.env.ISP_NAME || 'RT/RW Net';

const DEFAULT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 60);

const ICON = { info: 'i', warning: '!', critical: '!!' };

/**
 * Kirim alert.
 *
 * @param {string} key    pengenal jenis masalah, mis. 'wa:banned'.
 *                        Dipakai untuk cooldown — masalah yang sama
 *                        tidak dikirim berulang tiap 5 menit.
 * @param {string} level  'info' | 'warning' | 'critical'
 * @param {string} message
 * @param {object} opts   { cooldownMinutes, force }
 */
async function send(key, level, message, opts = {}) {
  const cooldown = opts.cooldownMinutes ?? DEFAULT_COOLDOWN_MIN;

  if (!opts.force && cooldown > 0) {
    const recent = await AlertLog.findOne({
      key,
      createdAt: { $gt: new Date(Date.now() - cooldown * 60_000) },
    });

    if (recent) {
      // Sudah dikirim baru-baru ini. Tetap tercatat di log proses supaya
      // jejaknya ada, tapi tidak mengganggu admin lagi.
      console.log(`[alert] ${key} ditahan (cooldown ${cooldown}m)`);
      return { sent: false, reason: 'cooldown' };
    }
  }

  const text = format(level, message);
  console[level === 'info' ? 'log' : 'error'](`[alert] ${key}: ${message}`);

  const channels = [];
  const results = await Promise.allSettled([sendTelegram(text), sendWebhook(level, key, message)]);

  if (results[0].status === 'fulfilled' && results[0].value) channels.push('telegram');
  if (results[1].status === 'fulfilled' && results[1].value) channels.push('webhook');

  for (const r of results) {
    if (r.status === 'rejected') console.error('[alert] kanal gagal:', r.reason?.message);
  }

  try {
    await AlertLog.create({ key, level, message, channels });
  } catch (err) {
    // Gagal mencatat log jangan sampai menggagalkan alertnya
    console.error('[alert] gagal menyimpan log:', err.message);
  }

  if (channels.length === 0) {
    console.error(
      '[alert] TIDAK ADA KANAL AKTIF. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID ' +
      'atau ALERT_WEBHOOK_URL di .env, kalau tidak alert hanya masuk log.'
    );
  }

  return { sent: channels.length > 0, channels };
}

/**
 * Kabar pulih. Cooldown 0 — kabar baik justru harus selalu sampai,
 * supaya admin tahu tidak perlu datang ke lokasi.
 */
async function resolve(key, message) {
  await AlertLog.updateMany(
    { key, resolved: false },
    { $set: { resolved: true } }
  );
  return send(`${key}:resolved`, 'info', message, { cooldownMinutes: 0 });
}

/* ------------------------------------------------------------------ */
/* Kanal                                                               */
/* ------------------------------------------------------------------ */

function format(level, message) {
  return `[${ICON[level] || '!'}] ${ISP_NAME} — Billing\n\n${message}`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return false;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

async function sendWebhook(level, key, message) {
  if (!WEBHOOK_URL) return false;

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // `content` agar langsung terbaca di Discord; field lain untuk
      // konsumen webhook yang lebih pintar (n8n, Zapier).
      content: format(level, message),
      text: format(level, message),
      level,
      key,
      message,
      source: ISP_NAME,
      at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
  return true;
}

/**
 * Tes kanal dari panel. Mengabaikan cooldown.
 */
async function test() {
  return send(
    'test',
    'info',
    'Ini pesan uji dari sistem billing. Kalau Anda menerimanya, kanal alert sudah aktif.',
    { force: true, cooldownMinutes: 0 }
  );
}

function configured() {
  return {
    telegram: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT),
    webhook: !!WEBHOOK_URL,
    any: !!((TELEGRAM_TOKEN && TELEGRAM_CHAT) || WEBHOOK_URL),
  };
}

module.exports = { send, resolve, test, configured };

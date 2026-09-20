/**
 * Pengaturan yang bisa berubah saat sistem berjalan, tanpa edit .env.
 *
 * Sekarang isinya satu: nomor CS.
 *
 * Kenapa perlu: nomor CS dulu hanya ada di .env, jadi setiap kali nomor
 * WhatsApp bot diganti, admin harus menyunting .env dan merestart dua
 * proses. Yang paling sering terjadi justru dilupakan — pesan ke pelanggan
 * tetap mencantumkan nomor lama yang sudah tidak aktif.
 *
 * Sekarang nomor yang memindai QR otomatis menjadi nomor CS. Itu nomor
 * yang memang sudah dipakai mengirim semua notifikasi, jadi balasan
 * pelanggan mendarat di tempat yang benar.
 *
 * Urutan prioritas:
 *   1. Nomor WhatsApp yang sedang tertaut (dari WaStatus.jid)
 *   2. CS_PHONE di .env — dipakai sebelum ada nomor yang pernah tertaut
 *
 * Cache in-memory dipakai supaya template pesan tetap bisa sinkron
 * (render dipanggil ribuan kali, tidak mungkin query DB tiap kali).
 */

const { WaStatus } = require('../models');

let cache = {
  cs_phone: process.env.CS_PHONE || '',
  from: 'env',
  at: 0,
};

const TTL_MS = 60_000;

/**
 * Ambil nomor telepon dari JID Baileys.
 * "6281216300524:12@s.whatsapp.net" -> "6281216300524"
 */
function phoneFromJid(jid) {
  if (!jid) return '';
  const digits = String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits : '';
}

/** Nomor CS untuk dipakai di template dan API. Sinkron, dari cache. */
function csPhone() {
  return cache.cs_phone;
}

/** Dari mana nilainya berasal — dipakai panel untuk menjelaskan ke admin. */
function csPhoneSource() {
  return cache.from;
}

/**
 * Segarkan cache dari database. Dipanggil berkala oleh worker dan API;
 * `force` melewati TTL (dipakai tepat setelah nomor baru tertaut).
 */
async function refresh({ force = false } = {}) {
  if (!force && Date.now() - cache.at < TTL_MS) return cache.cs_phone;

  try {
    const status = await WaStatus.findById('wa').select('jid connected').lean();
    const linked = phoneFromJid(status?.jid);

    cache = linked
      ? { cs_phone: linked, from: 'whatsapp', at: Date.now() }
      : { cs_phone: process.env.CS_PHONE || '', from: 'env', at: Date.now() };
  } catch (err) {
    // Gagal baca DB bukan alasan menghentikan pengiriman pesan —
    // pakai nilai terakhir yang diketahui.
    console.error('[settings] gagal segarkan:', err.message);
  }

  return cache.cs_phone;
}

/** Dipanggil saat WhatsApp baru tertaut, supaya tidak menunggu TTL. */
function setFromJid(jid) {
  const phone = phoneFromJid(jid);
  if (!phone) return cache.cs_phone;

  cache = { cs_phone: phone, from: 'whatsapp', at: Date.now() };
  console.log('[settings] nomor CS mengikuti WhatsApp yang tertaut:', phone);
  return phone;
}

module.exports = { csPhone, csPhoneSource, refresh, setFromJid, phoneFromJid };

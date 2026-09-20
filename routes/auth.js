/**
 * Route login.
 *
 * Admin  : email + password  → JWT admin
 * Pelanggan: nomor HP + OTP via WhatsApp → JWT customer
 *
 * Kenapa pelanggan pakai OTP, bukan password: pelanggan RT/RW net tidak
 * akan mengingat password, dan reset password lewat email tidak realistis
 * karena banyak yang tidak punya email aktif. Nomor HP sudah ada di sistem
 * dan sudah terhubung WhatsApp untuk notifikasi.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();

const { Admin, Customer, Notification } = require('../models');
const { signAdmin, signCustomer, requireAdmin, requireCustomer } = require('../middleware/auth');

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

router.post('/admin/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const password = String(req.body.password || '');

    const admin = await Admin.findOne({ email }).select('+password_hash');

    // Bandingkan hash dummy kalau admin tidak ada, supaya waktu respons
    // sama saja — jangan biarkan penyerang menebak email mana yang terdaftar
    // dari selisih waktu.
    const hash = admin?.password_hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(password, hash);

    if (!admin || !ok || !admin.is_active) {
      return res.status(401).json({ message: 'Email atau password salah' });
    }

    return res.json({
      token: signAdmin(admin),
      admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role },
    });
  } catch (err) {
    console.error('[auth/admin]', err.message);
    return res.status(500).json({ message: 'Gagal login' });
  }
});

router.get('/admin/me', requireAdmin, (req, res) => {
  res.json({
    admin: {
      id: req.admin._id,
      name: req.admin.name,
      email: req.admin.email,
      role: req.admin.role,
    },
  });
});

/* ------------------------------------------------------------------ */
/* Pelanggan — OTP via WhatsApp                                        */
/* ------------------------------------------------------------------ */

/**
 * OTP disimpan di memori, bukan DB.
 *
 * Alasan: OTP hidup 5 menit dan tidak perlu bertahan setelah restart —
 * pelanggan tinggal minta lagi. Menyimpannya di DB hanya menambah koleksi
 * yang harus dibersihkan.
 *
 * Konsekuensi: kalau nanti API server jalan di PM2 cluster mode, OTP yang
 * dibuat worker A tidak terlihat worker B. Saat itu terjadi, pindahkan ke
 * Redis atau jalankan API dengan -i 1.
 */
const otpStore = new Map(); // phone -> { hash, expires, attempts, lastSent }

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore) if (now > v.expires) otpStore.delete(k);
}, 60_000).unref();

function normalizePhone(input) {
  let n = String(input).replace(/[^0-9]/g, '');
  if (!n) return null;
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('8')) n = '62' + n;
  return n.startsWith('62') && n.length >= 10 ? n : null;
}

router.post('/customer/request-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: 'Nomor HP tidak valid' });

    const existing = otpStore.get(phone);
    if (existing && Date.now() - existing.lastSent < OTP_COOLDOWN_MS) {
      const wait = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - existing.lastSent)) / 1000);
      return res.status(429).json({ message: `Tunggu ${wait} detik sebelum meminta kode lagi` });
    }

    const customer = await Customer.findOne({ phone, status: { $ne: 'blacklist' } });

    // Balas sukses apa pun hasilnya. Kalau tidak, endpoint ini jadi alat
    // untuk mengecek nomor mana yang terdaftar sebagai pelanggan.
    if (!customer) {
      return res.json({ message: 'Kode dikirim ke WhatsApp Anda kalau nomor terdaftar' });
    }

    // crypto.randomInt, bukan Math.random — OTP harus tidak bisa ditebak
    const code = String(crypto.randomInt(100000, 1000000));

    otpStore.set(phone, {
      hash: await bcrypt.hash(code, 8),
      expires: Date.now() + OTP_TTL_MS,
      attempts: 0,
      lastSent: Date.now(),
      customerId: String(customer._id),
    });

    // Lewat outbox, sama seperti notifikasi lain. Worker WhatsApp yang mengirim.
    await Notification.create({
      customer_id: customer._id,
      channel:  'whatsapp',
      template: 'otp',
      payload:  { kode: code },
      status:   'queued',
    });

    return res.json({ message: 'Kode dikirim ke WhatsApp Anda kalau nomor terdaftar' });
  } catch (err) {
    console.error('[auth/otp]', err.message);
    return res.status(500).json({ message: 'Gagal mengirim kode' });
  }
});

router.post('/customer/verify-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();

    if (!phone || !code) return res.status(400).json({ message: 'Nomor HP dan kode wajib diisi' });

    const entry = otpStore.get(phone);
    if (!entry || Date.now() > entry.expires) {
      return res.status(401).json({ message: 'Kode sudah kedaluwarsa, minta kode baru' });
    }

    entry.attempts++;
    if (entry.attempts > OTP_MAX_ATTEMPTS) {
      otpStore.delete(phone);
      return res.status(429).json({ message: 'Terlalu banyak percobaan, minta kode baru' });
    }

    if (!(await bcrypt.compare(code, entry.hash))) {
      return res.status(401).json({ message: 'Kode salah' });
    }

    otpStore.delete(phone); // sekali pakai

    const customer = await Customer.findById(entry.customerId);
    if (!customer || customer.status === 'blacklist') {
      return res.status(401).json({ message: 'Akun tidak aktif' });
    }

    return res.json({
      token: signCustomer(customer),
      customer: { id: customer._id, name: customer.name, code: customer.code },
    });
  } catch (err) {
    console.error('[auth/verify]', err.message);
    return res.status(500).json({ message: 'Gagal verifikasi' });
  }
});

router.get('/customer/me', requireCustomer, (req, res) => {
  res.json({
    customer: {
      id: req.customer._id,
      name: req.customer.name,
      code: req.customer.code,
      phone: req.customer.phone,
      address: req.customer.address,
    },
  });
});

module.exports = router;

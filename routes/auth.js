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

const { Admin, Customer, Notification, OtpCode } = require('../models');
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
 * OTP disimpan di database (koleksi OtpCode), bukan di memori proses.
 *
 * Versi sebelumnya memakai Map in-memory. Akibatnya setiap restart API —
 * deploy, crash, atau `node --watch` saat pengembangan — membuang semua
 * kode yang sedang berjalan, dan pelanggan yang baru menerima kodenya
 * mendapat "Kode sudah kedaluwarsa" tanpa penjelasan apa pun.
 *
 * MongoDB menghapus dokumen kedaluwarsa sendiri lewat TTL index, jadi
 * tidak ada yang perlu dibersihkan manual.
 */
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

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

    const existing = await OtpCode.findById(phone).lean();
    if (existing && Date.now() - new Date(existing.last_sent_at).getTime() < OTP_COOLDOWN_MS) {
      const wait = Math.ceil(
        (OTP_COOLDOWN_MS - (Date.now() - new Date(existing.last_sent_at).getTime())) / 1000
      );
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

    // upsert — permintaan baru menggantikan kode lama untuk nomor yang sama
    await OtpCode.findByIdAndUpdate(
      phone,
      {
        $set: {
          hash: await bcrypt.hash(code, 8),
          customer_id: customer._id,
          attempts: 0,
          last_sent_at: new Date(),
          expires_at: new Date(Date.now() + OTP_TTL_MS),
        },
      },
      { upsert: true }
    );

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

    // Hitung percobaan secara atomik — dua permintaan bersamaan tidak
    // boleh sama-sama lolos batas.
    const entry = await OtpCode.findByIdAndUpdate(
      phone,
      { $inc: { attempts: 1 } },
      { new: true }
    );

    if (!entry || Date.now() > new Date(entry.expires_at).getTime()) {
      return res.status(401).json({ message: 'Kode sudah kedaluwarsa, minta kode baru' });
    }

    if (entry.attempts > OTP_MAX_ATTEMPTS) {
      await OtpCode.findByIdAndDelete(phone);
      return res.status(429).json({ message: 'Terlalu banyak percobaan, minta kode baru' });
    }

    if (!(await bcrypt.compare(code, entry.hash))) {
      return res.status(401).json({ message: 'Kode salah' });
    }

    await OtpCode.findByIdAndDelete(phone); // sekali pakai

    const customer = await Customer.findById(entry.customer_id);
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

/**
 * Endpoint publik untuk halaman walled garden isolir.
 *
 * TIDAK ADA AUTH di sini — halaman ini diakses pelanggan yang internetnya
 * sedang mati. Karena itu semua endpoint di file ini:
 *   - Rate-limited ketat
 *   - Hanya mengembalikan data minimal (jangan bocorkan alamat, NIK, dll)
 *   - Tidak bisa dipakai untuk enumerasi pelanggan
 *
 * Pasang di app.js:
 *   app.use('/api/public', require('./routes/public'));
 *   app.use('/isolir', express.static('public/isolir'));
 */

const express = require('express');
const router = express.Router();

const { Customer, Service, Invoice, Payment } = require('../models');
const midtrans = require('../services/midtrans');

/* ------------------------------------------------------------------ */
/* Rate limit sederhana per IP (tanpa dependensi)                      */
/* ------------------------------------------------------------------ */

const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_HITS = 15;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + WINDOW_MS };

  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + WINDOW_MS;
  }

  entry.count++;
  hits.set(ip, entry);

  if (entry.count > MAX_HITS) {
    return res.status(429).json({ message: 'Terlalu banyak permintaan, coba lagi sebentar' });
  }
  next();
}

// Bersihkan map tiap 5 menit supaya tidak bocor memori
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now > e.reset) hits.delete(ip);
}, 5 * 60_000).unref();

/* ------------------------------------------------------------------ */
/* Lookup tagihan                                                      */
/* ------------------------------------------------------------------ */

/**
 * POST /api/public/lookup
 * body: { key: "PLG-0001" atau "08123456789" }
 *
 * Catatan desain: idealnya pelanggan dikenali otomatis dari IP sumber.
 * Itu tidak andal di praktik — pelanggan di belakang NAT router sendiri,
 * dan IP pool isolir bisa berubah. Meminta kode pelanggan jauh lebih
 * sederhana dan tidak pernah salah orang.
 */
router.post('/lookup', rateLimit, async (req, res) => {
  try {
    const key = String(req.body.key || '').trim();
    if (key.length < 4) {
      return res.status(400).json({ message: 'Masukkan kode pelanggan atau nomor HP' });
    }

    const phone = normalizePhone(key);
    const customer = await Customer.findOne({
      $or: [
        { code: key.toUpperCase() },
        ...(phone ? [{ phone }] : []),
      ],
    }).select('name code status');

    // Pesan error yang sama untuk "tidak ketemu" dan "blacklist" —
    // jangan beri tahu penyerang bahwa suatu kode itu valid.
    if (!customer || customer.status === 'blacklist') {
      return res.status(404).json({ message: 'Data tidak ditemukan. Periksa kembali kode pelanggan Anda.' });
    }

    const services = await Service.find({ customer_id: customer._id }).select('_id status type');
    const serviceIds = services.map((s) => s._id);

    const invoices = await Invoice.find({
      service_id: { $in: serviceIds },
      status: 'unpaid',
    })
      .sort({ due_date: 1 })
      .select('number period total_idr due_date')
      .limit(12);

    return res.json({
      customer: { name: maskName(customer.name), code: customer.code },
      isolated: services.some((s) => s.status === 'isolated'),
      invoices: invoices.map((i) => ({
        id: i._id,
        number: i.number,
        period: i.period,
        total: i.total_idr,
        due_date: i.due_date,
      })),
      total_tagihan: invoices.reduce((sum, i) => sum + i.total_idr, 0),
    });
  } catch (err) {
    console.error('[public/lookup]', err.message);
    return res.status(500).json({ message: 'Terjadi kesalahan, coba lagi' });
  }
});

/**
 * POST /api/public/invoices/:id/qris
 * Buat QRIS tanpa login. Aman karena id invoice tidak bisa ditebak
 * (ObjectId) dan pembayaran hanya bisa menguntungkan pemilik tagihan.
 */
router.post('/invoices/:id/qris', rateLimit, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });
    if (invoice.status !== 'unpaid') {
      return res.status(409).json({ message: 'Tagihan ini sudah tidak aktif' });
    }

    const pending = await Payment.findOne({
      invoice_id: invoice._id,
      method: 'qris',
      status: 'pending',
      createdAt: { $gt: new Date(Date.now() - 55 * 60 * 1000) },
    });

    if (pending?.raw_payload?.actions) {
      return res.json({
        order_id: pending.gateway_ref,
        qr_url: findQr(pending.raw_payload),
        amount: pending.amount_idr,
      });
    }

    const orderId = midtrans.buildOrderId(invoice);
    const payment = await Payment.create({
      invoice_id:  invoice._id,
      amount_idr:  invoice.total_idr,
      method:      'qris',
      gateway:     'midtrans',
      gateway_ref: orderId,
      status:      'pending',
    });

    const charge = await midtrans.chargeQris(orderId, invoice.total_idr, {
      customerName: 'Pelanggan',
      expiryMinutes: 60,
    });

    payment.raw_payload = charge;
    payment.channel = charge.payment_type;
    await payment.save();

    return res.status(201).json({
      order_id: orderId,
      qr_url: findQr(charge),
      amount: invoice.total_idr,
      expiry: charge.expiry_time,
    });
  } catch (err) {
    console.error('[public/qris]', err.message);
    return res.status(500).json({ message: 'Gagal membuat QRIS' });
  }
});

/**
 * GET /api/public/payments/:orderId/status
 * Dipolling halaman isolir supaya pelanggan tahu kapan internetnya nyala.
 */
router.get('/payments/:orderId/status', rateLimit, async (req, res) => {
  try {
    const payment = await Payment.findOne({ gateway_ref: req.params.orderId })
      .select('status settled_at invoice_id');
    if (!payment) return res.status(404).json({ message: 'Tidak ditemukan' });

    const invoice = await Invoice.findById(payment.invoice_id).select('service_id');
    const service = invoice ? await Service.findById(invoice.service_id).select('status') : null;

    return res.json({
      status: payment.status,
      service_status: service?.status || null,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal cek status' });
  }
});

/* ------------------------------------------------------------------ */

function normalizePhone(input) {
  let n = String(input).replace(/[^0-9]/g, '');
  if (!n) return null;
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('8')) n = '62' + n;
  return n.startsWith('62') && n.length >= 10 ? n : null;
}

/** Budi Santoso → Budi S. — cukup untuk konfirmasi, tidak membocorkan identitas */
function maskName(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts.slice(1).map((p) => p[0].toUpperCase() + '.').join(' ');
}

function findQr(charge) {
  return charge?.actions?.find((a) => a.name === 'generate-qr-code')?.url || null;
}

module.exports = router;

/**
 * API untuk app pelanggan (Capacitor).
 *
 * Semua route di belakang requireCustomer. Aturan penting: setiap query
 * SELALU difilter dengan req.customer._id. Jangan pernah percaya id yang
 * dikirim dari app — pelanggan A tidak boleh bisa membuka tagihan B hanya
 * dengan mengganti id di URL.
 */

const express = require('express');
const router = express.Router();

const { Service, Invoice, Payment, ServiceEvent } = require('../models');
const midtrans = require('../services/midtrans');
const settlement = require('../services/settlement');
const isolation = require('../jobs/isolation');

/* ------------------------------------------------------------------ */
/* Ringkasan layar utama                                               */
/* ------------------------------------------------------------------ */

router.get('/summary', async (req, res) => {
  try {
    const services = await Service.find({ customer_id: req.customer._id })
      .populate('plan_id', 'name price_idr rate_limit')
      .select('type status username plan_id next_due_date')
      .lean();

    const serviceIds = services.map((s) => s._id);

    const unpaid = await Invoice.find({
      service_id: { $in: serviceIds },
      status: 'unpaid',
    })
      .sort({ due_date: 1 })
      .lean();

    return res.json({
      customer: { name: req.customer.name, code: req.customer.code },
      services: services.map((s) => ({
        id: s._id,
        type: s.type,
        status: s.status,
        username: s.username,
        plan: s.plan_id ? { name: s.plan_id.name, rate_limit: s.plan_id.rate_limit } : null,
        next_due_date: s.next_due_date,
      })),
      tagihan: unpaid.map(toInvoiceView),
      total_tagihan: unpaid.reduce((sum, i) => sum + i.total_idr, 0),
      terisolir: services.some((s) => s.status === 'isolated'),
    });
  } catch (err) {
    console.error('[customer/summary]', err.message);
    return res.status(500).json({ message: 'Gagal memuat data' });
  }
});

/* ------------------------------------------------------------------ */
/* Riwayat tagihan                                                     */
/* ------------------------------------------------------------------ */

router.get('/invoices', async (req, res) => {
  try {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Number(req.query.limit) || 12);

    const filter = { customer_id: req.customer._id };
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      Invoice.find(filter).sort({ issued_at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Invoice.countDocuments(filter),
    ]);

    return res.json({ items: items.map(toInvoiceView), total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal memuat riwayat' });
  }
});

/* ------------------------------------------------------------------ */
/* Pembayaran                                                          */
/* ------------------------------------------------------------------ */

/**
 * POST /api/customer/invoices/:id/pay
 * body: { method: 'qris' | 'va', bank?: 'bca' }
 */
router.post('/invoices/:id/pay', async (req, res) => {
  try {
    const { method = 'qris', bank } = req.body;

    // Filter customer_id — ini yang mencegah akses tagihan orang lain
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      customer_id: req.customer._id,
    });

    if (!invoice) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });
    if (invoice.status !== 'unpaid') {
      return res.status(409).json({ message: 'Tagihan ini sudah tidak aktif' });
    }

    // Pakai ulang transaksi pending yang masih hidup
    const pending = await Payment.findOne({
      invoice_id: invoice._id,
      method: method === 'va' ? 'va' : 'qris',
      status: 'pending',
      createdAt: { $gt: new Date(Date.now() - 55 * 60 * 1000) },
    });

    if (pending?.raw_payload) {
      return res.json({ reused: true, ...chargeView(pending.gateway_ref, pending.raw_payload, pending.amount_idr) });
    }

    const orderId = midtrans.buildOrderId(invoice);

    const payment = await Payment.create({
      invoice_id:  invoice._id,
      amount_idr:  invoice.total_idr,
      method:      method === 'va' ? 'va' : 'qris',
      gateway:     'midtrans',
      gateway_ref: orderId,
      status:      'pending',
    });

    let charge;
    try {
      charge = method === 'va'
        ? await midtrans.chargeVa(orderId, invoice.total_idr, bank || 'bca', { customerName: req.customer.name })
        : await midtrans.chargeQris(orderId, invoice.total_idr, { customerName: req.customer.name });
    } catch (err) {
      payment.status = 'failed';
      payment.last_error = err.message;
      await payment.save();
      return res.status(502).json({ message: 'Gagal menghubungi penyedia pembayaran' });
    }

    if (!['201', '200'].includes(String(charge.status_code))) {
      payment.status = 'failed';
      payment.raw_payload = charge;
      await payment.save();
      return res.status(502).json({ message: charge.status_message || 'Pembayaran ditolak' });
    }

    payment.channel = charge.payment_type;
    payment.raw_payload = charge;
    await payment.save();

    return res.status(201).json({ reused: false, ...chargeView(orderId, charge, invoice.total_idr) });
  } catch (err) {
    console.error('[customer/pay]', err.message);
    return res.status(500).json({ message: 'Gagal membuat pembayaran' });
  }
});

/**
 * GET /api/customer/payments/:orderId/status
 *
 * Dipolling app selama layar QRIS terbuka. Sekaligus jaring pengaman
 * kalau webhook Midtrans tidak sampai.
 */
router.get('/payments/:orderId/status', async (req, res) => {
  try {
    const payment = await Payment.findOne({ gateway_ref: req.params.orderId });
    if (!payment) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });

    // Pastikan transaksi ini memang milik pelanggan yang login
    const invoice = await Invoice.findOne({
      _id: payment.invoice_id,
      customer_id: req.customer._id,
    });
    if (!invoice) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });

    if (payment.status === 'pending') {
      const status = await midtrans.getStatus(payment.gateway_ref);
      const result = await settlement.applyPayment(payment, status);

      if (result.applied && result.status === 'settled' && result.serviceId) {
        const service = await Service.findById(result.serviceId);
        if (service) {
          await isolation.restoreService(service, { trigger: 'webhook' }).catch(() => {});
        }
      }
    }

    const service = await Service.findById(invoice.service_id).select('status');

    return res.json({
      status: payment.status,
      settled_at: payment.settled_at,
      service_status: service?.status || null,
    });
  } catch (err) {
    console.error('[customer/status]', err.message);
    return res.status(500).json({ message: 'Gagal cek status' });
  }
});

/* ------------------------------------------------------------------ */
/* Riwayat layanan — untuk pelanggan yang komplain "kok mati?"         */
/* ------------------------------------------------------------------ */

router.get('/services/:id/events', async (req, res) => {
  try {
    const service = await Service.findOne({
      _id: req.params.id,
      customer_id: req.customer._id,
    });
    if (!service) return res.status(404).json({ message: 'Layanan tidak ditemukan' });

    const events = await ServiceEvent.find({
      service_id: service._id,
      action: { $in: ['isolate', 'restore'] },
      success: true,
    })
      .sort({ created_at: -1 })
      .limit(20)
      .select('action created_at')
      .lean();

    // router_response sengaja tidak dikirim — itu detail internal
    return res.json({
      events: events.map((e) => ({
        action: e.action === 'isolate' ? 'Layanan dinonaktifkan' : 'Layanan diaktifkan',
        at: e.created_at,
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal memuat riwayat' });
  }
});

/* ------------------------------------------------------------------ */

function toInvoiceView(i) {
  return {
    id: i._id,
    number: i.number,
    period: i.period,
    amount: i.amount_idr,
    unique_code: i.unique_code,
    total: i.total_idr,
    due_date: i.due_date,
    status: i.status,
    paid_at: i.paid_at,
  };
}

function chargeView(orderId, charge, amount) {
  return {
    order_id: orderId,
    amount,
    qr_url: charge?.actions?.find((a) => a.name === 'generate-qr-code')?.url || null,
    va: charge?.va_numbers?.[0] ||
        (charge?.permata_va_number ? { bank: 'permata', va_number: charge.permata_va_number } : null),
    expiry: charge?.expiry_time || null,
  };
}

module.exports = router;

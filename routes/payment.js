/**
 * Route pembayaran: buat transaksi + terima webhook Midtrans.
 *
 * Pasang di app.js:
 *   app.use(express.json());
 *   app.use('/api/payment', require('./routes/payment'));
 *
 * URL webhook yang didaftarkan di dashboard Midtrans:
 *   https://<domain-kamu>/api/payment/webhook/midtrans
 *
 * AUTH: router ini dipasang di app.js SEBELUM requireAdmin supaya webhook
 * Midtrans bisa masuk tanpa token. Konsekuensinya requireAdmin harus
 * dipasang per-route di sini — hanya webhook yang boleh terbuka.
 */

const express = require('express');
const router = express.Router();

const { Invoice, Payment, Customer } = require('../models');
const { requireAdmin } = require('../middleware/auth');
const midtrans = require('../services/midtrans');
const settlement = require('../services/settlement');

/* ------------------------------------------------------------------ */
/* Webhook — TIDAK boleh pakai middleware auth                         */
/* ------------------------------------------------------------------ */

router.post('/webhook/midtrans', async (req, res) => {
  try {
    const result = await settlement.handleNotification(req.body);
    return res.status(result.code).json({ message: result.message });
  } catch (err) {
    console.error('[webhook] error:', err.message, req.body?.order_id);

    // Balas 500 supaya Midtrans mengirim ulang. Ini disengaja: kalau DB kita
    // sedang down, kita MAU notifikasinya diulang, bukan hilang.
    return res.status(500).json({ message: 'gagal diproses, kirim ulang' });
  }
});

/* ------------------------------------------------------------------ */
/* Buat transaksi pembayaran                                           */
/* ------------------------------------------------------------------ */

/**
 * POST /api/payment/invoices/:id/charge
 * body: { method: 'qris' | 'va', bank?: 'bca' }
 */
router.post('/invoices/:id/charge', requireAdmin, async (req, res) => {
  try {
    const { method = 'qris', bank } = req.body;

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice tidak ditemukan' });
    if (invoice.status === 'paid') return res.status(409).json({ message: 'Invoice sudah lunas' });
    if (invoice.status === 'void') return res.status(409).json({ message: 'Invoice dibatalkan' });

    // Pakai ulang transaksi pending yang masih hidup — jangan bikin baru
    // tiap kali pelanggan membuka halaman bayar.
    const pending = await Payment.findOne({
      invoice_id: invoice._id,
      status: 'pending',
      method,
      createdAt: { $gt: new Date(Date.now() - 55 * 60 * 1000) },
    });

    if (pending) {
      return res.json({ reused: true, payment: toPaymentView(pending) });
    }

    const customer = await Customer.findById(invoice.customer_id).select('name');
    const orderId = midtrans.buildOrderId(invoice);

    // Catat payment SEBELUM memanggil Midtrans. Kalau urutannya dibalik dan
    // proses mati setelah charge sukses, kita punya transaksi di Midtrans
    // yang tidak bisa dipetakan ke invoice manapun saat webhook masuk.
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
        ? await midtrans.chargeVa(orderId, invoice.total_idr, bank || 'bca', { customerName: customer?.name })
        : await midtrans.chargeQris(orderId, invoice.total_idr, { customerName: customer?.name });
    } catch (err) {
      payment.status = 'failed';
      payment.last_error = err.message;
      await payment.save();
      throw err;
    }

    if (!['201', '200'].includes(String(charge.status_code))) {
      payment.status = 'failed';
      payment.raw_payload = charge;
      await payment.save();
      return res.status(502).json({ message: charge.status_message || 'Charge ditolak' });
    }

    payment.channel = charge.payment_type;
    payment.raw_payload = charge;
    await payment.save();

    return res.status(201).json({
      reused: false,
      payment: toPaymentView(payment),
      qr_url:  charge.actions?.find((a) => a.name === 'generate-qr-code')?.url || null,
      va:      charge.va_numbers?.[0] || (charge.permata_va_number
                 ? { bank: 'permata', va_number: charge.permata_va_number }
                 : null),
      expiry:  charge.expiry_time || null,
    });
  } catch (err) {
    console.error('[charge] error:', err.message);
    return res.status(500).json({ message: 'Gagal membuat transaksi' });
  }
});

/**
 * GET /api/payment/:orderId/status
 * Polling dari app Capacitor selagi pelanggan scan QRIS.
 * Sekaligus jaring pengaman kalau webhook tidak sampai.
 */
router.get('/:orderId/status', requireAdmin, async (req, res) => {
  try {
    const payment = await Payment.findOne({ gateway_ref: req.params.orderId });
    if (!payment) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });

    if (payment.status === 'pending') {
      const status = await midtrans.getStatus(payment.gateway_ref);
      const result = await settlement.applyPayment(payment, status);

      if (result.applied && result.status === 'settled' && result.serviceId) {
        const { Service } = require('../models');
        const isolation = require('../jobs/isolation');
        const service = await Service.findById(result.serviceId);
        if (service) {
          await isolation.restoreService(service, { trigger: 'webhook' }).catch(() => {});
        }
      }
    }

    return res.json({ status: payment.status, settled_at: payment.settled_at });
  } catch (err) {
    console.error('[status] error:', err.message);
    return res.status(500).json({ message: 'Gagal cek status' });
  }
});

/**
 * POST /api/payment/invoices/:id/cash — pembayaran tunai oleh admin.
 */
router.post('/invoices/:id/cash', requireAdmin, async (req, res) => {
  try {
    const payment = await settlement.recordCashPayment(req.params.id, req.admin?._id);
    return res.status(201).json({ payment: toPaymentView(payment) });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

function toPaymentView(p) {
  return {
    id: p._id,
    order_id: p.gateway_ref,
    amount: p.amount_idr,
    method: p.method,
    status: p.status,
  };
}

module.exports = router;

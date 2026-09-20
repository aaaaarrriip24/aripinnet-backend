/**
 * Settlement pembayaran.
 *
 * Aturan yang tidak boleh dilanggar:
 * 1. Semua perubahan DB dalam satu transaksi. Butuh replica set —
 *    MongoDB Atlas sudah otomatis. Kalau standalone, jalankan
 *    `rs.initiate()` di mongod lokal.
 * 2. Aksi ke RouterOS TIDAK boleh di dalam transaksi. Router timeout
 *    akan me-rollback pembayaran yang uangnya sudah masuk.
 * 3. Idempoten. Midtrans mengirim notifikasi yang sama berkali-kali.
 */

const mongoose = require('mongoose');
const { Invoice, Payment, Service, Notification } = require('../models');
const midtrans = require('./midtrans');
const isolation = require('../jobs/isolation');

/**
 * Terapkan hasil pembayaran ke database.
 *
 * @param {Object} payment  dokumen Payment yang sudah ada (dicari via gateway_ref)
 * @param {Object} status   respons /v2/{order_id}/status dari Midtrans
 * @returns {Promise<{applied:boolean, reason?:string, serviceId?:string}>}
 */
async function applyPayment(payment, status) {
  const newStatus = midtrans.mapStatus(status);

  // Sudah final dan tidak berubah — tidak ada yang perlu dikerjakan.
  if (payment.status === newStatus && payment.status !== 'pending') {
    return { applied: false, reason: 'sudah diproses' };
  }

  const grossAmount = Math.round(Number(status.gross_amount));
  const session = await mongoose.startSession();
  let serviceId = null;

  try {
    await session.withTransaction(async () => {
      const invoice = await Invoice.findById(payment.invoice_id).session(session);
      if (!invoice) throw new Error(`Invoice ${payment.invoice_id} hilang`);

      // Jangan percaya nominal dari payload. Kalau tidak cocok, catat dan
      // hentikan — ini bisa berarti serangan atau bug di sisi kita.
      if (newStatus === 'settled' && grossAmount !== invoice.total_idr) {
        throw new Error(
          `Nominal tidak cocok: dibayar ${grossAmount}, tagihan ${invoice.total_idr}`
        );
      }

      payment.status      = newStatus;
      payment.amount_idr  = grossAmount;
      payment.channel     = status.payment_type;
      payment.raw_payload = status;
      payment.settled_at  = newStatus === 'settled' ? new Date(status.settlement_time || Date.now()) : null;
      await payment.save({ session });

      if (newStatus !== 'settled') return;

      // Invoice sudah lunas dari jalur lain (bayar tunai, transfer manual).
      // Pembayaran ini tetap dicatat, tapi invoice tidak diubah dua kali.
      if (invoice.status === 'paid') return;

      invoice.status  = 'paid';
      invoice.paid_at = payment.settled_at;
      await invoice.save({ session });

      const service = await Service.findById(invoice.service_id).session(session);
      if (service && service.status === 'isolated') {
        serviceId = String(service._id);
      }
    });
  } finally {
    await session.endSession();
  }

  return { applied: true, status: newStatus, serviceId };
}

/**
 * Proses notifikasi Midtrans dari awal sampai akhir.
 * Dipanggil oleh route webhook dan juga oleh job rekonsiliasi.
 */
async function handleNotification(payload) {
  if (!midtrans.verifySignature(payload)) {
    return { ok: false, code: 403, message: 'Signature tidak valid' };
  }

  const payment = await Payment.findOne({ gateway_ref: payload.order_id });
  if (!payment) {
    // Bukan error di sisi Midtrans — balas 200 supaya dia berhenti retry,
    // tapi catat karena ini menandakan ada yang tidak beres di sisi kita.
    console.warn('[midtrans] order_id tidak dikenal:', payload.order_id);
    return { ok: true, code: 200, message: 'order tidak dikenal, diabaikan' };
  }

  // Ambil status langsung dari Midtrans, bukan dari payload.
  const status = await midtrans.getStatus(payload.order_id);
  const result = await applyPayment(payment, status);

  // ---- Di luar transaksi: efek samping ----
  if (result.applied && result.status === 'settled') {
    await queuePaidNotification(payment);

    if (result.serviceId) {
      // Kalau ini gagal, biarkan. Job reconcile tiap 15 menit akan mengulang.
      const service = await Service.findById(result.serviceId);
      if (service) {
        await isolation
          .restoreService(service, { trigger: 'webhook' })
          .catch((err) => console.error('[midtrans] restore gagal:', err.message));
      }
    }
  }

  return { ok: true, code: 200, message: result.reason || result.status };
}

async function queuePaidNotification(payment) {
  const invoice = await Invoice.findById(payment.invoice_id);
  if (!invoice) return;

  try {
    await Notification.create({
      customer_id: invoice.customer_id,
      invoice_id:  invoice._id,
      channel:  'whatsapp',
      template: 'lunas',
      payload: {
        nomor:  invoice.number,
        total:  invoice.total_idr,
        metode: payment.channel,
      },
      status: 'queued',
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
}

/**
 * Pembayaran tunai yang diterima langsung oleh admin/kolektor.
 * Jalur terpisah dari gateway, tapi efek akhirnya sama.
 */
async function recordCashPayment(invoiceId, adminId) {
  const session = await mongoose.startSession();
  let serviceId = null;
  let payment = null;

  try {
    await session.withTransaction(async () => {
      const invoice = await Invoice.findById(invoiceId).session(session);
      if (!invoice) throw new Error('Invoice tidak ditemukan');
      if (invoice.status === 'paid') throw new Error('Invoice sudah lunas');
      if (invoice.status === 'void') throw new Error('Invoice sudah dibatalkan');

      [payment] = await Payment.create([{
        invoice_id:  invoice._id,
        amount_idr:  invoice.total_idr,
        method:      'cash',
        gateway:     'manual',
        status:      'settled',
        received_by: adminId,
        settled_at:  new Date(),
      }], { session });

      invoice.status  = 'paid';
      invoice.paid_at = new Date();
      await invoice.save({ session });

      const service = await Service.findById(invoice.service_id).session(session);
      if (service && service.status === 'isolated') serviceId = String(service._id);
    });
  } finally {
    await session.endSession();
  }

  if (serviceId) {
    const service = await Service.findById(serviceId);
    await isolation
      .restoreService(service, { trigger: 'manual', adminId })
      .catch((err) => console.error('[cash] restore gagal:', err.message));
  }

  await queuePaidNotification(payment);
  return payment;
}

module.exports = { handleNotification, applyPayment, recordCashPayment };

/**
 * Klien Midtrans Core API.
 *
 * Tidak butuh dependensi tambahan — pakai fetch bawaan Node 18+.
 *
 * Env:
 *   MIDTRANS_SERVER_KEY=SB-Mid-server-xxxx
 *   MIDTRANS_IS_PRODUCTION=false
 *
 * Catatan: pakai Core API (bukan Snap) karena kamu butuh kontrol penuh atas
 * order_id dan mau menampilkan QRIS langsung di app Capacitor tanpa redirect
 * ke halaman Midtrans.
 */

const crypto = require('crypto');

const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';

const BASE_URL = IS_PRODUCTION
  ? 'https://api.midtrans.com'
  : 'https://api.sandbox.midtrans.com';

if (!SERVER_KEY) throw new Error('MIDTRANS_SERVER_KEY belum diset');

const authHeader = 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64');

async function request(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json().catch(() => ({}));

  // Midtrans pakai status_code di body, bukan HTTP status, untuk error bisnis
  if (!res.ok && !json.status_code) {
    throw new Error(`Midtrans HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Buat order_id yang unik selamanya untuk satu merchant.
 *
 * PENTING: order_id tidak boleh dipakai ulang, bahkan untuk invoice yang sama
 * setelah transaksi sebelumnya expired. Karena itu ada suffix waktu.
 * Pemetaan kembali ke invoice dilakukan lewat collection payments
 * (field gateway_ref), bukan dengan mem-parsing order_id.
 */
function buildOrderId(invoice) {
  const suffix = Date.now().toString(36).toUpperCase();
  return `INV-${invoice._id}-${suffix}`;
}

/**
 * Charge QRIS. Berlaku untuk semua e-wallet (Gopay, OVO, Dana, ShopeePay)
 * lewat satu QR — tidak perlu integrasi terpisah per e-wallet.
 */
async function chargeQris(orderId, amount, { customerName, expiryMinutes = 60 } = {}) {
  return request('/v2/charge', {
    body: {
      payment_type: 'qris',
      transaction_details: { order_id: orderId, gross_amount: amount },
      qris: { acquirer: 'gopay' },
      customer_details: { first_name: customerName },
      custom_expiry: { expiry_duration: expiryMinutes, unit: 'minute' },
    },
  });
}

/**
 * Charge Virtual Account.
 * @param {string} bank bca | bni | bri | permata | cimb
 */
async function chargeVa(orderId, amount, bank, { customerName, expiryHours = 24 } = {}) {
  const body = {
    payment_type: 'bank_transfer',
    transaction_details: { order_id: orderId, gross_amount: amount },
    bank_transfer: { bank },
    customer_details: { first_name: customerName },
    custom_expiry: { expiry_duration: expiryHours, unit: 'hour' },
  };
  return request('/v2/charge', { body });
}

/**
 * Sumber kebenaran status transaksi.
 *
 * SELALU panggil ini di webhook. Payload notifikasi bisa dipalsukan siapa pun
 * yang tahu URL webhook-mu; verifikasi signature membantu, tapi memanggil
 * API status secara langsung menghilangkan seluruh kelas serangan itu.
 */
async function getStatus(orderId) {
  return request(`/v2/${encodeURIComponent(orderId)}/status`, { method: 'GET' });
}

async function cancel(orderId) {
  return request(`/v2/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
}

/**
 * Verifikasi signature_key notifikasi.
 * sha512(order_id + status_code + gross_amount + server_key)
 */
function verifySignature({ order_id, status_code, gross_amount, signature_key }) {
  if (!signature_key) return false;

  const expected = crypto
    .createHash('sha512')
    .update(`${order_id}${status_code}${gross_amount}${SERVER_KEY}`)
    .digest('hex');

  // timingSafeEqual butuh panjang sama
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature_key), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Terjemahkan status Midtrans ke status internal payments.
 */
function mapStatus(payload) {
  const { transaction_status: t, fraud_status: f } = payload;

  if (t === 'capture') return f === 'accept' ? 'settled' : 'pending';
  if (t === 'settlement') return 'settled';
  if (t === 'pending') return 'pending';
  if (t === 'deny') return 'failed';
  if (t === 'cancel' || t === 'expire') return 'expired';
  if (t === 'refund' || t === 'partial_refund') return 'refunded';
  return 'pending';
}

module.exports = {
  chargeQris,
  chargeVa,
  getStatus,
  cancel,
  verifySignature,
  mapStatus,
  buildOrderId,
};

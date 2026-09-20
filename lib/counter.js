/**
 * Penomoran invoice & alokasi kode unik yang aman dari race condition.
 *
 * JANGAN pakai Invoice.countDocuments() + 1 — dua request bersamaan akan
 * menghasilkan nomor yang sama dan salah satunya gagal di unique index.
 */

const { Counter, Invoice } = require('../models');

/**
 * Ambil nomor urut berikutnya secara atomik.
 * @param {string} key contoh: "invoice:2026-09"
 */
async function nextSeq(key, session = null) {
  const doc = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session }
  );
  return doc.seq;
}

/**
 * Nomor invoice berurutan per bulan: INV/2026/09/0001
 */
async function nextInvoiceNumber(period, session = null) {
  const [year, month] = period.split('-');
  const seq = await nextSeq(`invoice:${period}`, session);
  return `INV/${year}/${month}/${String(seq).padStart(4, '0')}`;
}

/**
 * Alokasikan kode unik nominal (1-999) yang belum dipakai invoice unpaid.
 *
 * Ini best-effort: unique partial index di models.js yang jadi penjamin
 * akhirnya. Kalau tetap bentrok, caller harus retry.
 *
 * Kalau pelanggan aktif sudah mendekati 999 tagihan unpaid sekaligus,
 * pendekatan kode unik harus diganti dengan VA per pelanggan.
 */
async function allocateUniqueCode() {
  const used = await Invoice.distinct('unique_code', {
    status: 'unpaid',
    unique_code: { $gt: 0 },
  });

  const usedSet = new Set(used);
  if (usedSet.size >= 999) {
    throw new Error('Kode unik habis — terlalu banyak invoice unpaid bersamaan');
  }

  // Acak, bukan berurutan: kode berurutan bikin pelanggan sering salah transfer
  // karena nominalnya mirip-mirip.
  let code;
  do {
    code = Math.floor(Math.random() * 999) + 1;
  } while (usedSet.has(code));

  return code;
}

module.exports = { nextSeq, nextInvoiceNumber, allocateUniqueCode };

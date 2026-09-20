/**
 * Template pesan WhatsApp.
 *
 * VERSI DIPERBARUI — menambah template `otp` (login app pelanggan) dan
 * link halaman isolir di template `isolir`. Menggantikan file sebelumnya.
 *
 * Simpan di file, bukan di database, supaya masuk version control dan
 * perubahan kalimatnya bisa di-review. Yang dinamis cuma variabelnya.
 *
 * Catatan nada: pesan isolir dan penagihan adalah titik paling sensitif
 * dalam hubungan dengan pelanggan. Jangan bernada ancaman, dan selalu
 * sertakan jalan keluar (nomor yang bisa dihubungi).
 */

// Nomor CS sengaja TIDAK dibaca sekali di sini. Ia mengikuti nomor
// WhatsApp yang sedang tertaut, dan itu bisa berubah saat sistem jalan —
// lihat lib/settings.js. Kalau dibekukan jadi const, pesan ke pelanggan
// akan mencantumkan nomor lama sampai proses direstart.
const { csPhone } = require('../lib/settings');

const ISP_NAME   = process.env.ISP_NAME || 'Jaringan RT/RW Net';
const ISOLIR_URL = process.env.ISOLIR_URL || '';

const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

const templates = {
  invoice_baru: (p) => `Halo ${p.nama},

Tagihan internet ${ISP_NAME} untuk periode ${p.periode} sudah terbit.

No. tagihan : ${p.nomor}
Jumlah      : *${rupiah(p.total)}*
Jatuh tempo : ${p.jatuh_tempo}

Mohon dibayar sesuai nominal di atas, termasuk 3 angka terakhirnya, agar pembayaran otomatis terbaca sistem.

Terima kasih 🙏`,

  h2_jatuh_tempo: (p) => `Halo ${p.nama},

Pengingat: tagihan ${p.nomor} sebesar *${rupiah(p.total)}* jatuh tempo pada ${p.jatuh_tempo}.

Kalau sudah dibayar, abaikan pesan ini. Ada kendala pembayaran? Balas pesan ini saja.`,

  isolir: (p) => `Halo ${p.nama},

Layanan internet Anda kami nonaktifkan sementara karena tagihan belum terbayar.
${ISOLIR_URL ? `
Bayar sekarang: ${ISOLIR_URL}
` : ''}
Layanan aktif kembali otomatis dalam beberapa menit setelah pembayaran masuk.

Kalau sudah membayar tapi internet belum menyala, hubungi ${csPhone()} agar kami cek manual.`,

  lunas: (p) => `Pembayaran diterima ✅

No. tagihan : ${p.nomor}
Jumlah      : ${rupiah(p.total)}
Metode      : ${p.metode || '-'}

Terima kasih. Layanan internet Anda aktif normal.`,

  /**
   * OTP login app pelanggan.
   *
   * Pesan sengaja pendek dan tanpa basa-basi: makin sedikit teks, makin
   * kecil kemungkinan WhatsApp menandainya sebagai spam. Peringatan
   * "jangan bagikan" wajib ada — penipuan minta kode OTP sangat umum di sini.
   */
  otp: (p) => `*${p.kode}* adalah kode masuk aplikasi ${ISP_NAME}.

Berlaku 5 menit. JANGAN berikan kode ini ke siapa pun, termasuk yang mengaku admin.`,

  gangguan: (p) => `Info ${ISP_NAME}

${p.pesan}

Mohon maaf atas ketidaknyamanannya.`,
};

/**
 * Render template jadi teks siap kirim.
 * @throws kalau nama template tidak dikenal — lebih baik gagal keras
 *         daripada mengirim pesan kosong ke pelanggan.
 */
function render(name, payload = {}) {
  const fn = templates[name];
  if (!fn) throw new Error(`Template "${name}" tidak dikenal`);
  return fn(payload).trim();
}

module.exports = { render, templates };

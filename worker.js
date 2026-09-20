/**
 * Entrypoint worker WhatsApp.
 *
 * Jalankan TERPISAH dari API server:
 *   pm2 start worker.js --name billing-wa -i 1
 *
 * Wajib -i 1 (bukan cluster mode). Session Baileys tidak bisa dipakai
 * dua proses sekaligus — keduanya akan saling menendang dan berakhir
 * dengan session tercabut.
 *
 * Pertama kali jalan, QR akan muncul di log. Scan dengan WhatsApp nomor
 * billing (bukan nomor pribadimu), lalu session tersimpan di .wa-session/
 * dan tidak perlu scan ulang kecuali dicabut dari HP.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const worker = require('./jobs/notification-worker');
const wa = require('./services/whatsapp');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[worker] MongoDB terhubung');

  await worker.start();
}

async function shutdown(signal) {
  console.log(`[worker] ${signal} diterima, menutup...`);
  worker.stop();
  await mongoose.connection.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Jangan biarkan promise rejection diam-diam mematikan worker
process.on('unhandledRejection', (err) => {
  console.error('[worker] unhandled rejection:', err);
});

main().catch((err) => {
  console.error('[worker] gagal start:', err);
  process.exit(1);
});

/**
 * API server.
 *
 * Jalankan: pm2 start app.js --name billing-api
 *
 * CATATAN CLUSTER MODE: kalau nanti dijalankan dengan -i > 1, pindahkan
 * penyimpanan OTP di routes/auth.js ke Redis lebih dulu. Selain itu,
 * cukup pastikan hanya SATU instance yang memanggil scheduler.start().
 */

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const { requireAdmin, requireCustomer } = require('./middleware/auth');
const scheduler = require('./jobs/scheduler');
const routeros = require('./services/routeros');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/* ------------------------------------------------------------------ */
/* Middleware dasar                                                    */
/* ------------------------------------------------------------------ */

// Wajib kalau di belakang Nginx — tanpa ini req.ip selalu 127.0.0.1
// dan rate limiter jadi tidak berguna.
app.set('trust proxy', 1);

app.use(helmet({
  // Halaman isolir pakai inline style & script (disengaja — tidak boleh
  // ada file eksternal). CSP default helmet akan memblokirnya.
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
  credentials: false,
}));

app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

app.get('/health', (req, res) => {
  res.json({
    ok: mongoose.connection.readyState === 1,
    uptime: Math.round(process.uptime()),
  });
});

app.use('/api/auth', require('./routes/auth'));

// Publik — tanpa auth, sudah rate-limited di dalamnya
app.use('/api/public', require('./routes/public'));

// Webhook Midtrans ada di dalam routes/payment.js dan TIDAK boleh
// kena middleware auth. Karena itu payment dipasang sebelum requireAdmin.
app.use('/api/payment', require('./routes/payment'));

// Urutan penting: router yang lebih spesifik dipasang lebih dulu.
// routes/admin.js masih punya handler /plans lama — karena admin-plans
// dipasang di atasnya, handler lama itu tidak pernah terpakai dan
// sebaiknya dihapus dari routes/admin.js.
app.use('/api/admin/plans',   requireAdmin, require('./routes/admin-plans'));
app.use('/api/admin/reports', requireAdmin, require('./routes/admin-reports'));
app.use('/api/admin/system',  requireAdmin, require('./routes/admin-system'));
app.use('/api/admin', requireAdmin, require('./routes/admin'));

app.use('/api/customer', requireCustomer, require('./routes/customer'));

// Dokumentasi API. Opt-in lewat ENABLE_DOCS — server ini terbuka ke
// internet, dan daftar lengkap endpoint tidak perlu ikut dipublikasikan.
if (process.env.ENABLE_DOCS === 'true') {
  const swaggerUi = require('swagger-ui-express');
  const openapi = require('./docs/openapi');

  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, {
    customSiteTitle: `API Billing — ${process.env.ISP_NAME || 'RT/RW Net'}`,
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none' },
  }));
  app.get('/api/docs.json', (req, res) => res.json(openapi));

  console.log('[app] dokumentasi API aktif di /api/docs');
}

// Halaman walled garden isolir
app.use('/isolir', express.static(path.join(__dirname, 'public/isolir')));

// Panel admin hasil build Vue (opsional — biasanya dilayani Nginx langsung)
if (process.env.SERVE_ADMIN === 'true') {
  const adminDist = path.join(__dirname, 'admin/dist');
  app.use('/admin', express.static(adminDist));
  app.get('/admin/*', (req, res) => res.sendFile(path.join(adminDist, 'index.html')));
}

app.use((req, res) => res.status(404).json({ message: 'Endpoint tidak ditemukan' }));

// Error handler terakhir — jangan bocorkan stack trace ke klien
app.use((err, req, res, next) => {
  console.error('[app]', err.message, err.stack);
  res.status(500).json({ message: 'Terjadi kesalahan pada server' });
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[app] MongoDB terhubung');

  // Pastikan semua index (termasuk yang unique) benar-benar terbuat.
  // Tanpa ini, proteksi anti-dobel invoice dan idempotensi webhook tidak
  // aktif dan kamu baru tahu saat ada pembayaran dobel.
  await Promise.all(
    Object.values(require('./models')).map((m) => m.syncIndexes?.().catch((e) =>
      console.warn('[app] syncIndexes gagal:', m.modelName, e.message)
    ))
  );
  console.log('[app] index tersinkron');

  const server = app.listen(PORT, () => console.log(`[app] listening on :${PORT}`));

  if (process.env.ENABLE_CRON !== 'false') {
    scheduler.start();
  }

  const shutdown = async (signal) => {
    console.log(`[app] ${signal} diterima, menutup...`);
    server.close();
    scheduler.stop();
    routeros.closeAll();
    await mongoose.connection.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => console.error('[app] unhandled rejection:', err));

main().catch((err) => {
  console.error('[app] gagal start:', err);
  process.exit(1);
});

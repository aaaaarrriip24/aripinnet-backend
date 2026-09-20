/**
 * Bandingkan route yang benar-benar terpasang dengan isi docs/openapi.js.
 *
 * Spesifikasi OpenAPI ditulis manual di satu file, jadi ia tidak ikut
 * berubah saat route ditambah. Skrip ini yang mengingatkan.
 *
 *   node scripts/check-docs.js
 *
 * Keluar dengan kode 1 kalau ada yang tidak cocok — aman dipakai di CI
 * atau pre-commit hook.
 */

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

// Prefix tempat tiap file dipasang di app.js.
const MOUNTS = {
  'auth.js': '/api/auth',
  'public.js': '/api/public',
  'payment.js': '/api/payment',
  'customer.js': '/api/customer',
  'admin-plans.js': '/api/admin/plans',
  'admin-reports.js': '/api/admin/reports',
  'admin-system.js': '/api/admin/system',
  'admin.js': '/api/admin',
};

// Route yang sengaja tidak didokumentasikan dengan path aslinya.
// admin.js punya handler /plans lama yang tidak pernah terpakai karena
// admin-plans.js dipasang lebih dulu di app.js.
const SHADOWED = new Set([
  'GET /api/admin/plans',
  'POST /api/admin/plans',
]);

// Ada di app.js langsung, bukan di folder routes/.
const EXTRA = ['GET /health'];

/* ------------------------------------------------------------------ */

function routesFromFile(file) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  const mount = MOUNTS[file];
  const found = [];

  const re = /^router\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm;
  let m;
  while ((m = re.exec(src))) {
    const method = m[1].toUpperCase();
    const sub = m[2] === '/' ? '' : m[2];
    // :id  ->  {id}   supaya cocok dengan gaya penulisan OpenAPI
    const full = (mount + sub).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    found.push(`${method} ${full}`);
  }
  return found;
}

function documented() {
  const spec = require('../docs/openapi');
  const out = new Set();
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        out.add(`${method.toUpperCase()} ${p}`);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */

const actual = new Set(EXTRA);
for (const file of Object.keys(MOUNTS)) {
  for (const r of routesFromFile(file)) actual.add(r);
}

const docs = documented();

const missing = [...actual].filter((r) => !docs.has(r) && !SHADOWED.has(r));
const extra = [...docs].filter((r) => !actual.has(r) && !r.includes('_legacy'));

if (missing.length) {
  console.log(`\nBelum didokumentasikan (${missing.length}):`);
  for (const r of missing.sort()) console.log('  -', r);
}

if (extra.length) {
  console.log(`\nAda di dokumentasi tapi route-nya tidak ada (${extra.length}):`);
  for (const r of extra.sort()) console.log('  -', r);
}

if (!missing.length && !extra.length) {
  console.log(`OK — ${actual.size} endpoint, semuanya terdokumentasi.`);
  process.exit(0);
}

process.exit(1);

/**
 * Pemetaan paket → PPP profile per router.
 *
 * Sejak versi 2, satu paket bisa memakai nama profile berbeda di tiap
 * MikroTik. Semua kode yang butuh nama profile harus lewat sini, jangan
 * membaca `plan.ppp_profile` langsung — itu hanya fallback data lama.
 */

/**
 * Cari nama PPP profile untuk kombinasi paket + router.
 *
 * Urutan: profiles[] → ppp_profile lama → slug dari nama paket.
 *
 * Fallback terakhir sengaja TIDAK memakai 'default'. Profile `default`
 * di RouterOS tidak punya rate-limit, jadi pelanggan yang jatuh ke sana
 * akan dapat kecepatan penuh tanpa batas — salah diam-diam, dan baru
 * ketahuan saat tagihan bandwidth membengkak.
 */
function resolveProfile(plan, routerId) {
  if (!plan) return null;

  const entry = (plan.profiles || []).find(
    (p) => String(p.router_id?._id || p.router_id) === String(routerId)
  );
  if (entry?.ppp_profile) return entry.ppp_profile;

  if (plan.ppp_profile) return plan.ppp_profile;

  return slugProfile(plan.name);
}

/**
 * Versi ketat: melempar error kalau pemetaan belum ada.
 *
 * Dipakai di jalur yang menyentuh router sungguhan (provision, restore).
 * Lebih baik gagal dengan pesan jelas daripada memasang profile yang
 * salah ke sambungan pelanggan.
 */
function requireProfile(plan, routerId, routerName = '') {
  const entry = (plan?.profiles || []).find(
    (p) => String(p.router_id?._id || p.router_id) === String(routerId)
  );

  if (entry?.ppp_profile) return entry.ppp_profile;
  if (plan?.ppp_profile) return plan.ppp_profile;

  throw new Error(
    `Paket "${plan?.name}" belum dipetakan ke profile di router ${routerName || routerId}. ` +
    'Buka Paket → pilih paket → Sinkronkan ke router.'
  );
}

/** "Home 10 Mbps" → "home-10-mbps" */
function slugProfile(name) {
  return String(name || 'paket')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

/** Apakah paket sudah dipetakan di router ini? */
function hasProfile(plan, routerId) {
  return (plan?.profiles || []).some(
    (p) => String(p.router_id?._id || p.router_id) === String(routerId)
  ) || !!plan?.ppp_profile;
}

/**
 * Validasi format rate-limit RouterOS.
 *
 * Bentuk yang diterima: "10M/10M", "512k/1M", dan varian burst penuh
 * seperti "10M/10M 20M/20M 15M/15M 10/10 8 10M/10M".
 * Nilai salah format akan ditolak router saat sinkronisasi, jadi lebih
 * baik dicegat di sini dengan pesan yang bisa dimengerti.
 */
function isValidRateLimit(value) {
  if (!value) return false;
  const speed = '\\d+(?:\\.\\d+)?[kKmMgG]?';
  const pair = `${speed}\\/${speed}`;
  const re = new RegExp(`^${pair}(?:\\s+\\S+)*$`);
  return re.test(String(value).trim());
}

module.exports = { resolveProfile, requireProfile, slugProfile, hasProfile, isValidRateLimit };

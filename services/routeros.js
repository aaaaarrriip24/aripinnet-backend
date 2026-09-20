/**
 * Modul RouterOS.
 *
 * VERSI 2 — perubahan:
 * - Nama PPP profile kini di-resolve per router lewat lib/plan-profile.js
 * - Tambah syncProfile / listProfiles / verifyProfile untuk kelola paket
 *
 * Dependensi: npm i node-routeros
 *
 * Prinsip desain:
 * 1. IDEMPOTEN — isolate() pada service yang sudah terisolir = no-op sukses.
 * 2. TIDAK PERNAH THROW ke caller. Semua hasil dikembalikan sebagai
 *    { success, message, raw } supaya cron tidak mati gara-gara satu router.
 * 3. Koneksi di-pool per router dan ditutup saat idle.
 */

const { RouterOSAPI } = require('node-routeros');
const { decrypt } = require('../lib/crypto');
const { requireProfile } = require('../lib/plan-profile');

const PROFILE_ISOLIR = process.env.RB_PROFILE_ISOLIR || 'isolir';
const ADDRESS_LIST_ISOLIR = process.env.RB_LIST_ISOLIR || 'isolir';
const IDLE_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_S = 10;

/* ------------------------------------------------------------------ */
/* Connection pool                                                     */
/* ------------------------------------------------------------------ */

const pool = new Map(); // routerId -> { conn, timer }

async function getConnection(router) {
  const key = String(router._id);
  const cached = pool.get(key);

  if (cached && cached.conn.connected) {
    resetIdleTimer(key);
    return cached.conn;
  }

  const conn = new RouterOSAPI({
    host: router.host,
    user: router.username,
    password: decrypt(router.secret_enc),
    port: router.api_port || (router.use_tls ? 8729 : 8728),
    tls: router.use_tls ? {} : undefined,
    timeout: CONNECT_TIMEOUT_S,
  });

  await conn.connect();
  pool.set(key, { conn, timer: null });
  resetIdleTimer(key);
  return conn;
}

function resetIdleTimer(key) {
  const entry = pool.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => closeConnection(key), IDLE_TIMEOUT_MS);
  entry.timer.unref?.();
}

function closeConnection(key) {
  const entry = pool.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try { entry.conn.close(); } catch (_) { /* sudah tertutup */ }
  pool.delete(key);
}

function closeAll() {
  for (const key of [...pool.keys()]) closeConnection(key);
}

async function withRouter(router, fn) {
  try {
    const conn = await getConnection(router);
    const raw = await fn(conn);
    return { success: true, message: 'ok', raw };
  } catch (err) {
    closeConnection(String(router._id));
    return {
      success: false,
      message: err?.message || String(err),
      raw: err?.errno ? { errno: err.errno } : null,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helper PPP                                                          */
/* ------------------------------------------------------------------ */

async function findSecret(conn, username) {
  const rows = await conn.write('/ppp/secret/print', [`?name=${username}`]);
  return rows[0] || null;
}

async function findProfile(conn, name) {
  const rows = await conn.write('/ppp/profile/print', [`?name=${name}`]);
  return rows[0] || null;
}

async function kickActive(conn, username) {
  // Ganti profile saja tidak memutus sesi yang sedang berjalan.
  // Sesi harus di-drop supaya pelanggan dial ulang dan kena profile baru.
  const actives = await conn.write('/ppp/active/print', [`?name=${username}`]);
  for (const a of actives) {
    await conn.write('/ppp/active/remove', [`=.id=${a['.id']}`]);
  }
  return actives.length;
}

async function findAddressListEntry(conn, ip) {
  const rows = await conn.write('/ip/firewall/address-list/print', [
    `?list=${ADDRESS_LIST_ISOLIR}`,
    `?address=${ip}`,
  ]);
  return rows[0] || null;
}

/* ------------------------------------------------------------------ */
/* Kelola PPP profile (paket)                                          */
/* ------------------------------------------------------------------ */

/**
 * Baca semua PPP profile di router. Dipakai panel saat memetakan paket
 * ke profile yang sudah ada.
 */
async function listProfiles(router) {
  return withRouter(router, async (conn) => {
    const rows = await conn.write('/ppp/profile/print');
    return rows.map((p) => ({
      id: p['.id'],
      name: p.name,
      rate_limit: p['rate-limit'] || '',
      local_address: p['local-address'] || '',
      remote_address: p['remote-address'] || '',
      is_default: p.default === 'true',
    }));
  });
}

/**
 * Buat atau perbarui PPP profile agar cocok dengan rate_limit paket.
 *
 * Perilaku yang disengaja: kalau profile sudah ada tapi rate-limit-nya
 * berbeda, profile TIDAK langsung ditimpa kecuali `force` — profile yang
 * sudah dipakai puluhan pelanggan bisa saja sengaja dibedakan, dan
 * menimpanya tanpa bertanya adalah cara cepat mengubah kecepatan semua
 * orang tanpa sadar.
 */
async function syncProfile(router, profileName, rateLimit, { force = false } = {}) {
  return withRouter(router, async (conn) => {
    const existing = await findProfile(conn, profileName);

    if (!existing) {
      await conn.write('/ppp/profile/add', [
        `=name=${profileName}`,
        `=rate-limit=${rateLimit}`,
        '=only-one=yes',    // cegah satu akun dipakai dua sambungan sekaligus
      ]);
      return { created: true, profile: profileName, rate_limit: rateLimit };
    }

    const current = existing['rate-limit'] || '';
    if (current === rateLimit) {
      return { created: false, changed: false, profile: profileName, rate_limit: current };
    }

    if (!force) {
      return {
        created: false,
        changed: false,
        conflict: true,
        profile: profileName,
        rate_limit: current,
        expected: rateLimit,
      };
    }

    await conn.write('/ppp/profile/set', [
      `=.id=${existing['.id']}`,
      `=rate-limit=${rateLimit}`,
    ]);
    return { created: false, changed: true, profile: profileName, from: current, rate_limit: rateLimit };
  });
}

/**
 * Cek apakah profile di router masih cocok dengan paket.
 * Tidak mengubah apa pun — hanya membaca.
 */
async function verifyProfile(router, profileName, rateLimit) {
  return withRouter(router, async (conn) => {
    const existing = await findProfile(conn, profileName);
    if (!existing) return { exists: false, in_sync: false, profile: profileName };

    const current = existing['rate-limit'] || '';
    return {
      exists: true,
      in_sync: current === rateLimit,
      profile: profileName,
      rate_limit: current,
      expected: rateLimit,
    };
  });
}

/**
 * Hitung berapa PPP secret yang memakai sebuah profile di router ini.
 * Dipakai panel sebelum mengizinkan perubahan yang berdampak luas.
 */
async function countSecretsByProfile(router, profileName) {
  return withRouter(router, async (conn) => {
    const rows = await conn.write('/ppp/secret/print', [`?profile=${profileName}`]);
    return { count: rows.length };
  });
}

/* ------------------------------------------------------------------ */
/* Isolir / restore                                                    */
/* ------------------------------------------------------------------ */

async function isolate(router, service) {
  return withRouter(router, async (conn) => {
    if (service.type === 'pppoe') {
      const secret = await findSecret(conn, service.username);
      if (!secret) throw new Error(`PPP secret "${service.username}" tidak ada di router`);

      if (secret.profile === PROFILE_ISOLIR) {
        await kickActive(conn, service.username);
        return { skipped: true, reason: 'sudah terisolir' };
      }

      await conn.write('/ppp/secret/set', [
        `=.id=${secret['.id']}`,
        `=profile=${PROFILE_ISOLIR}`,
      ]);
      const dropped = await kickActive(conn, service.username);
      return { previous_profile: secret.profile, sessions_dropped: dropped };
    }

    if (service.type === 'static') {
      if (!service.static_ip) throw new Error('static_ip kosong');

      const existing = await findAddressListEntry(conn, service.static_ip);
      if (existing) return { skipped: true, reason: 'sudah di address-list isolir' };

      await conn.write('/ip/firewall/address-list/add', [
        `=list=${ADDRESS_LIST_ISOLIR}`,
        `=address=${service.static_ip}`,
        `=comment=svc:${service._id}`,
      ]);
      return { added: service.static_ip };
    }

    throw new Error(`Tipe service "${service.type}" belum didukung`);
  });
}

/**
 * Buka isolir — kembalikan ke profile sesuai paket DI ROUTER INI.
 *
 * requireProfile melempar kalau pemetaan belum ada. Itu disengaja:
 * mengembalikan pelanggan ke profile yang salah lebih buruk daripada
 * gagal dengan pesan jelas, karena job reconcile akan mencoba lagi dan
 * admin melihat errornya di riwayat layanan.
 */
async function restore(router, service, plan) {
  return withRouter(router, async (conn) => {
    if (service.type === 'pppoe') {
      const target = requireProfile(plan, router._id, router.name);

      const secret = await findSecret(conn, service.username);
      if (!secret) throw new Error(`PPP secret "${service.username}" tidak ada di router`);

      // Pastikan profile tujuan benar-benar ada sebelum memindahkan.
      // Kalau tidak, RouterOS menolak dan pelanggan tetap terisolir.
      const profile = await findProfile(conn, target);
      if (!profile) {
        throw new Error(
          `Profile "${target}" tidak ada di router ${router.name}. ` +
          'Sinkronkan paket ke router ini lebih dulu.'
        );
      }

      if (secret.profile === target) {
        return { skipped: true, reason: 'profile sudah benar' };
      }

      await conn.write('/ppp/secret/set', [
        `=.id=${secret['.id']}`,
        `=profile=${target}`,
      ]);
      const dropped = await kickActive(conn, service.username);
      return { profile: target, sessions_dropped: dropped };
    }

    if (service.type === 'static') {
      const existing = await findAddressListEntry(conn, service.static_ip);
      if (!existing) return { skipped: true, reason: 'tidak ada di address-list' };

      await conn.write('/ip/firewall/address-list/remove', [`=.id=${existing['.id']}`]);
      return { removed: service.static_ip };
    }

    throw new Error(`Tipe service "${service.type}" belum didukung`);
  });
}

/**
 * Buat PPP secret baru untuk pelanggan baru.
 */
async function provision(router, service, plan, secretPlain) {
  return withRouter(router, async (conn) => {
    const target = requireProfile(plan, router._id, router.name);

    const profile = await findProfile(conn, target);
    if (!profile) {
      throw new Error(
        `Profile "${target}" tidak ada di router ${router.name}. ` +
        'Sinkronkan paket ke router ini lebih dulu.'
      );
    }

    const existing = await findSecret(conn, service.username);
    if (existing) return { skipped: true, reason: 'secret sudah ada', id: existing['.id'] };

    const res = await conn.write('/ppp/secret/add', [
      `=name=${service.username}`,
      `=password=${secretPlain}`,
      '=service=pppoe',
      `=profile=${target}`,
      `=comment=svc:${service._id}`,
    ]);
    return { created: res, profile: target };
  });
}

/**
 * Pindahkan layanan ke paket lain (ganti profile).
 * Dipakai saat pelanggan upgrade/downgrade.
 */
async function changePlan(router, service, newPlan) {
  return withRouter(router, async (conn) => {
    const target = requireProfile(newPlan, router._id, router.name);

    const profile = await findProfile(conn, target);
    if (!profile) throw new Error(`Profile "${target}" tidak ada di router ${router.name}`);

    const secret = await findSecret(conn, service.username);
    if (!secret) throw new Error(`PPP secret "${service.username}" tidak ada di router`);

    // Layanan yang sedang terisolir jangan dikembalikan diam-diam —
    // simpan paket barunya di DB, biarkan alur restore yang memasang.
    if (secret.profile === PROFILE_ISOLIR) {
      return { skipped: true, reason: 'sedang terisolir, profile dipasang saat isolir dibuka' };
    }

    await conn.write('/ppp/secret/set', [`=.id=${secret['.id']}`, `=profile=${target}`]);
    const dropped = await kickActive(conn, service.username);
    return { profile: target, sessions_dropped: dropped };
  });
}

/* ------------------------------------------------------------------ */
/* Monitoring                                                          */
/* ------------------------------------------------------------------ */

async function ping(router) {
  return withRouter(router, async (conn) => {
    const res = await conn.write('/system/identity/print');
    return res[0] || {};
  });
}

async function listActive(router) {
  return withRouter(router, async (conn) => conn.write('/ppp/active/print'));
}

module.exports = {
  isolate,
  restore,
  provision,
  changePlan,
  listProfiles,
  syncProfile,
  verifyProfile,
  countSecretsByProfile,
  ping,
  listActive,
  closeAll,
  PROFILE_ISOLIR,
  ADDRESS_LIST_ISOLIR,
};

/* ==================================================================
 * KONFIGURASI YANG HARUS ADA DI ROUTEROS
 * ==================================================================
 *
 * Profile paket (paket-10m dan seterusnya) kini bisa dibuat otomatis
 * dari panel: Paket → pilih paket → Sinkronkan ke router. Yang di bawah
 * ini tetap harus dipasang manual sekali per router.
 *
 * 1. Profile isolir — arahkan ke walled garden:
 *
 *    /ip pool add name=isolir-pool ranges=10.99.99.10-10.99.99.254
 *    /ppp profile add name=isolir local-address=10.99.99.1 \
 *      remote-address=isolir-pool rate-limit=1M/1M
 *
 *    /ip firewall nat add chain=dstnat protocol=tcp dst-port=80 \
 *      src-address=10.99.99.0/24 action=dst-nat \
 *      to-addresses=<IP_SERVER_WEB_ISOLIR> to-ports=80
 *
 *    /ip firewall filter add chain=forward src-address=10.99.99.0/24 \
 *      action=drop
 *
 * 2. Address-list isolir (pelanggan static IP):
 *
 *    /ip firewall nat add chain=dstnat protocol=tcp dst-port=80 \
 *      src-address-list=isolir action=dst-nat \
 *      to-addresses=<IP_SERVER_WEB_ISOLIR> to-ports=80
 *    /ip firewall filter add chain=forward src-address-list=isolir \
 *      action=drop
 *
 * 3. User API khusus (jangan pakai admin):
 *
 *    /user group add name=billing policy=api,read,write,test
 *    /user add name=billing group=billing password=<kuat> \
 *      address=<IP_VPN_SERVER>/32
 *
 *    Batasi `address=` ke IP server billing saja. Ini pertahanan utama
 *    kalau kredensial bocor.
 * ================================================================== */

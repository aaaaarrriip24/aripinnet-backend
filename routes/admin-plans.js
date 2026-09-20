/**
 * API kelola paket & pemetaan profile per MikroTik.
 *
 * Dipasang SEBELUM routes/admin.js di app.js supaya menangani /plans
 * lebih dulu. Dua handler /plans lama di routes/admin.js jadi tidak
 * terpakai dan sebaiknya dihapus.
 *
 * Inti fitur: satu paket ("Home 10 Mbps") bisa memakai nama PPP profile
 * berbeda di tiap router, karena profile hidup di dalam masing-masing
 * MikroTik dan sering sudah ada sebelum sistem ini dipasang.
 */

const express = require('express');
const router = express.Router();

const { Plan, Router: RouterModel, Service } = require('../models');
const routeros = require('../services/routeros');
const { requireRole } = require('../middleware/auth');
const { slugProfile, isValidRateLimit } = require('../lib/plan-profile');

/* ------------------------------------------------------------------ */
/* Daftar paket + status pemetaan tiap router                          */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/plans
 *
 * Mengembalikan matriks paket × router: untuk setiap paket, status
 * pemetaannya di setiap router (belum dipetakan / terpetakan / beda
 * rate-limit), plus jumlah layanan yang memakainya.
 */
router.get('/', async (req, res) => {
  try {
    const [plans, routers, usage] = await Promise.all([
      Plan.find({}).sort({ price_idr: 1 }).lean(),
      RouterModel.find({}).select('name site status').sort({ name: 1 }).lean(),
      Service.aggregate([
        { $match: { status: { $ne: 'terminated' } } },
        { $group: { _id: { plan: '$plan_id', router: '$router_id' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Peta "planId:routerId" -> jumlah layanan
    const usageMap = new Map();
    for (const u of usage) {
      usageMap.set(`${u._id.plan}:${u._id.router}`, u.count);
    }

    const items = plans.map((plan) => {
      const byRouter = routers.map((r) => {
        const entry = (plan.profiles || []).find(
          (p) => String(p.router_id) === String(r._id)
        );
        return {
          router_id: r._id,
          router_name: r.name,
          router_status: r.status,
          ppp_profile: entry?.ppp_profile || null,
          in_sync: entry?.in_sync || false,
          synced_at: entry?.synced_at || null,
          last_error: entry?.last_error || null,
          services: usageMap.get(`${plan._id}:${r._id}`) || 0,
          mapped: !!entry,
        };
      });

      return {
        ...plan,
        routers: byRouter,
        total_services: byRouter.reduce((s, r) => s + r.services, 0),
        // Paket yang belum dipetakan di router mana pun tidak bisa dipakai
        unmapped_count: byRouter.filter((r) => !r.mapped).length,
      };
    });

    return res.json({ plans: items, routers });
  } catch (err) {
    console.error('[plans/list]', err.message);
    return res.status(500).json({ message: 'Gagal memuat paket' });
  }
});

/* ------------------------------------------------------------------ */
/* CRUD paket                                                          */
/* ------------------------------------------------------------------ */

router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name, price_idr, rate_limit, cycle_days, tax_percent } = req.body;

    if (!name || price_idr == null || !rate_limit) {
      return res.status(400).json({ message: 'Nama, harga, dan rate limit wajib diisi' });
    }

    if (!isValidRateLimit(rate_limit)) {
      return res.status(400).json({
        message: 'Format rate limit salah. Contoh yang benar: 10M/10M atau 512k/2M',
      });
    }

    const plan = await Plan.create({
      name,
      price_idr: Math.round(Number(price_idr)),
      rate_limit: String(rate_limit).trim(),
      cycle_days: Number(cycle_days) || 30,
      tax_percent: Number(tax_percent) || 0,
      profiles: [],
    });

    return res.status(201).json({
      plan,
      // Beri tahu langsung: paket tanpa pemetaan belum bisa dipakai
      next: 'Petakan paket ini ke router sebelum memakainya untuk layanan baru.',
      suggested_profile: slugProfile(name),
    });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/**
 * PATCH /api/admin/plans/:id
 *
 * Mengubah harga aman. Mengubah rate_limit TIDAK otomatis mengubah
 * router — profile di router harus disinkronkan ulang secara sadar,
 * karena itu menyentuh kecepatan pelanggan yang sedang berjalan.
 */
router.patch('/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return res.status(404).json({ message: 'Paket tidak ditemukan' });

    const { name, price_idr, rate_limit, cycle_days, tax_percent, is_active } = req.body;

    if (rate_limit && !isValidRateLimit(rate_limit)) {
      return res.status(400).json({
        message: 'Format rate limit salah. Contoh yang benar: 10M/10M atau 512k/2M',
      });
    }

    const rateChanged = rate_limit && rate_limit !== plan.rate_limit;

    if (name != null) plan.name = name;
    if (price_idr != null) plan.price_idr = Math.round(Number(price_idr));
    if (rate_limit != null) plan.rate_limit = String(rate_limit).trim();
    if (cycle_days != null) plan.cycle_days = Number(cycle_days);
    if (tax_percent != null) plan.tax_percent = Number(tax_percent);
    if (is_active != null) plan.is_active = !!is_active;

    // Rate-limit berubah → semua pemetaan jadi tidak sinkron sampai
    // admin menekan Sinkronkan. Jangan diam-diam menandainya aman.
    if (rateChanged) {
      plan.profiles.forEach((p) => { p.in_sync = false; });
    }

    await plan.save();

    return res.json({
      plan,
      warning: rateChanged
        ? 'Rate limit berubah. Sinkronkan ulang ke setiap router agar kecepatan pelanggan ikut berubah.'
        : null,
    });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/**
 * DELETE /api/admin/plans/:id
 *
 * Ditolak kalau masih dipakai layanan. Menghapus paket yang dipakai akan
 * membuat invoice lama kehilangan acuan harga dan restore gagal total.
 */
router.delete('/:id', requireRole('owner'), async (req, res) => {
  try {
    const used = await Service.countDocuments({
      plan_id: req.params.id,
      status: { $ne: 'terminated' },
    });

    if (used > 0) {
      return res.status(409).json({
        message: `Paket masih dipakai ${used} layanan. Nonaktifkan saja agar tidak muncul di pilihan baru.`,
      });
    }

    await Plan.findByIdAndDelete(req.params.id);
    return res.json({ message: 'Paket dihapus' });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Pemetaan profile per router                                         */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/plans/routers/:routerId/profiles
 * Baca daftar PPP profile yang sudah ada di router, untuk dipilih admin.
 */
router.get('/routers/:routerId/profiles', async (req, res) => {
  try {
    const routerDoc = await RouterModel.findById(req.params.routerId).select('+secret_enc');
    if (!routerDoc) return res.status(404).json({ message: 'Router tidak ditemukan' });

    const result = await routeros.listProfiles(routerDoc);
    if (!result.success) {
      return res.status(502).json({ message: `Router tidak terjangkau: ${result.message}` });
    }

    return res.json({ profiles: result.raw });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/**
 * PUT /api/admin/plans/:id/routers/:routerId
 * body: { ppp_profile, sync: boolean, force: boolean }
 *
 * Memetakan paket ke nama profile di satu router. Kalau `sync` true,
 * profile dibuat/diperbarui di router sekaligus.
 */
router.put('/:id/routers/:routerId', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { ppp_profile, sync = true, force = false } = req.body;

    const [plan, routerDoc] = await Promise.all([
      Plan.findById(req.params.id),
      RouterModel.findById(req.params.routerId).select('+secret_enc'),
    ]);

    if (!plan) return res.status(404).json({ message: 'Paket tidak ditemukan' });
    if (!routerDoc) return res.status(404).json({ message: 'Router tidak ditemukan' });

    const profileName = String(ppp_profile || slugProfile(plan.name)).trim();
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(profileName)) {
      return res.status(400).json({
        message: 'Nama profile hanya boleh huruf, angka, titik, garis bawah, dan strip (maks 32 karakter)',
      });
    }

    let syncResult = null;

    if (sync) {
      syncResult = await routeros.syncProfile(routerDoc, profileName, plan.rate_limit, { force });

      if (!syncResult.success) {
        // Simpan pemetaannya tetap, tapi tandai tidak sinkron — admin
        // bisa mencoba lagi nanti tanpa mengisi ulang formulir.
        upsertProfile(plan, routerDoc._id, profileName, false, syncResult.message);
        await plan.save();

        return res.status(502).json({
          message: `Router tidak terjangkau: ${syncResult.message}`,
          plan,
        });
      }

      // Profile sudah ada tapi rate-limit berbeda, dan force belum dipakai
      if (syncResult.raw?.conflict) {
        const used = await routeros.countSecretsByProfile(routerDoc, profileName);

        upsertProfile(plan, routerDoc._id, profileName, false, 'rate-limit berbeda');
        await plan.save();

        return res.status(409).json({
          conflict: true,
          message:
            `Profile "${profileName}" sudah ada di ${routerDoc.name} dengan rate-limit ` +
            `${syncResult.raw.rate_limit}, sedangkan paket ini ${plan.rate_limit}.`,
          detail: {
            current: syncResult.raw.rate_limit,
            expected: plan.rate_limit,
            affected_secrets: used.success ? used.raw.count : null,
          },
          hint: used.success && used.raw.count > 0
            ? `Menimpa akan mengubah kecepatan ${used.raw.count} sambungan yang memakai profile ini.`
            : 'Tidak ada sambungan yang memakai profile ini, aman untuk ditimpa.',
        });
      }
    }

    upsertProfile(plan, routerDoc._id, profileName, sync ? true : false, null);
    await plan.save();

    return res.json({
      plan,
      sync: syncResult?.raw || null,
      message: syncResult?.raw?.created
        ? `Profile "${profileName}" dibuat di ${routerDoc.name}.`
        : syncResult?.raw?.changed
          ? `Profile "${profileName}" diperbarui ke ${plan.rate_limit}.`
          : `Paket dipetakan ke "${profileName}" di ${routerDoc.name}.`,
    });
  } catch (err) {
    console.error('[plans/map]', err.message);
    return res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /api/admin/plans/:id/routers/:routerId
 * Lepas pemetaan. Profile di router TIDAK dihapus — mungkin masih
 * dipakai hal lain, dan menghapusnya bisa memutus sambungan.
 */
router.delete('/:id/routers/:routerId', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return res.status(404).json({ message: 'Paket tidak ditemukan' });

    const inUse = await Service.countDocuments({
      plan_id: plan._id,
      router_id: req.params.routerId,
      status: { $ne: 'terminated' },
    });

    if (inUse > 0) {
      return res.status(409).json({
        message: `${inUse} layanan di router ini memakai paket tersebut. Pindahkan dulu ke paket lain.`,
      });
    }

    plan.profiles = plan.profiles.filter(
      (p) => String(p.router_id) !== String(req.params.routerId)
    );
    await plan.save();

    return res.json({ plan, message: 'Pemetaan dilepas. Profile di router tidak diubah.' });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/**
 * POST /api/admin/plans/verify
 *
 * Periksa semua pemetaan terhadap kondisi router sebenarnya, lalu
 * perbarui flag in_sync. Ini yang dijalankan cron harian dan tombol
 * "Periksa semua" di panel.
 */
router.post('/verify', async (req, res) => {
  try {
    const result = await verifyAll();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */

function upsertProfile(plan, routerId, profileName, inSync, error) {
  const entry = plan.profiles.find((p) => String(p.router_id) === String(routerId));

  if (entry) {
    entry.ppp_profile = profileName;
    entry.in_sync = inSync;
    entry.synced_at = inSync ? new Date() : entry.synced_at;
    entry.last_error = error || undefined;
  } else {
    plan.profiles.push({
      router_id: routerId,
      ppp_profile: profileName,
      in_sync: inSync,
      synced_at: inSync ? new Date() : undefined,
      last_error: error || undefined,
    });
  }
}

/**
 * Verifikasi seluruh pemetaan. Dipakai route di atas dan cron.
 * Diekspor supaya scheduler bisa memanggilnya langsung.
 */
async function verifyAll() {
  const plans = await Plan.find({ is_active: true });
  const routers = await RouterModel.find({}).select('+secret_enc');
  const routerMap = new Map(routers.map((r) => [String(r._id), r]));

  const result = { checked: 0, in_sync: 0, out_of_sync: 0, missing: 0, unreachable: 0, issues: [] };

  for (const plan of plans) {
    let dirty = false;

    for (const entry of plan.profiles) {
      const routerDoc = routerMap.get(String(entry.router_id));
      if (!routerDoc) continue;

      result.checked++;
      const check = await routeros.verifyProfile(routerDoc, entry.ppp_profile, plan.rate_limit);

      if (!check.success) {
        result.unreachable++;
        entry.last_error = check.message;
        dirty = true;
        continue;
      }

      const wasInSync = entry.in_sync;
      entry.in_sync = check.raw.in_sync;
      entry.last_error = undefined;
      if (check.raw.in_sync) entry.synced_at = new Date();
      if (wasInSync !== entry.in_sync) dirty = true;

      if (!check.raw.exists) {
        result.missing++;
        result.issues.push({
          plan: plan.name, router: routerDoc.name, profile: entry.ppp_profile,
          problem: 'profile tidak ada di router',
        });
        dirty = true;
      } else if (!check.raw.in_sync) {
        result.out_of_sync++;
        result.issues.push({
          plan: plan.name, router: routerDoc.name, profile: entry.ppp_profile,
          problem: `rate-limit router ${check.raw.rate_limit}, paket ${plan.rate_limit}`,
        });
        dirty = true;
      } else {
        result.in_sync++;
      }
    }

    if (dirty) await plan.save();
  }

  return result;
}

module.exports = router;
module.exports.verifyAll = verifyAll;

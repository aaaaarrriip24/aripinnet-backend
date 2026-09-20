/**
 * API panel admin.
 *
 * Semua route di file ini sudah di belakang requireAdmin (dipasang di app.js).
 *
 * Prinsip:
 * - Aksi yang menyentuh router (isolir/restore/provision) selalu lewat
 *   jobs/isolation.js, bukan memanggil routeros.js langsung — supaya
 *   service_events selalu tercatat.
 * - Daftar besar selalu dipaginasi. Jangan pernah kirim seluruh koleksi.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const {
  Customer, Service, Plan, Router: RouterModel,
  Invoice, Payment, ServiceEvent, Notification,
} = require('../models');

const isolation = require('../jobs/isolation');
const routeros = require('../services/routeros');
const invoiceGenerator = require('../jobs/invoice-generator');
const { requireRole } = require('../middleware/auth');
const { encrypt } = require('../lib/crypto');

const TZ = process.env.TZ_APP || 'Asia/Jakarta';

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

router.get('/dashboard', async (req, res) => {
  try {
    const startOfMonth = dayjs().tz(TZ).startOf('month').toDate();
    const startOfDay   = dayjs().tz(TZ).startOf('day').toDate();

    const [
      totalCustomers, activeServices, isolatedServices,
      unpaidAgg, paidThisMonthAgg, paidTodayAgg,
      routers, failedNotifs,
    ] = await Promise.all([
      Customer.countDocuments({ status: 'active' }),
      Service.countDocuments({ status: 'active' }),
      Service.countDocuments({ status: 'isolated' }),
      Invoice.aggregate([
        { $match: { status: 'unpaid' } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total_idr' } } },
      ]),
      Payment.aggregate([
        { $match: { status: 'settled', settled_at: { $gte: startOfMonth } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount_idr' } } },
      ]),
      Payment.aggregate([
        { $match: { status: 'settled', settled_at: { $gte: startOfDay } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount_idr' } } },
      ]),
      RouterModel.find({}).select('name status last_seen_at site'),
      // Lonjakan notifikasi gagal biasanya berarti nomor WhatsApp kena banned
      Notification.countDocuments({
        status: 'failed',
        updatedAt: { $gte: dayjs().subtract(1, 'hour').toDate() },
      }),
    ]);

    return res.json({
      customers:  { active: totalCustomers },
      services:   { active: activeServices, isolated: isolatedServices },
      piutang:    { count: unpaidAgg[0]?.count || 0, total: unpaidAgg[0]?.total || 0 },
      bulan_ini:  { count: paidThisMonthAgg[0]?.count || 0, total: paidThisMonthAgg[0]?.total || 0 },
      hari_ini:   { count: paidTodayAgg[0]?.count || 0, total: paidTodayAgg[0]?.total || 0 },
      routers:    routers.map((r) => ({
        id: r._id, name: r.name, site: r.site,
        status: r.status, last_seen_at: r.last_seen_at,
      })),
      alert_wa: failedNotifs > 5
        ? `${failedNotifs} notifikasi gagal dalam 1 jam terakhir — cek status WhatsApp`
        : null,
    });
  } catch (err) {
    console.error('[admin/dashboard]', err.message);
    return res.status(500).json({ message: 'Gagal memuat dashboard' });
  }
});

/* ------------------------------------------------------------------ */
/* Pelanggan                                                           */
/* ------------------------------------------------------------------ */

router.get('/customers', async (req, res) => {
  try {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 25);
    const q      = String(req.query.q || '').trim();
    const status = req.query.status;

    const filter = {};
    if (status) filter.status = status;
    if (q) {
      filter.$or = [
        { code:  new RegExp(escapeRegex(q), 'i') },
        { name:  new RegExp(escapeRegex(q), 'i') },
        { phone: new RegExp(escapeRegex(q.replace(/^0/, '62')), 'i') },
      ];
    }

    const [items, total] = await Promise.all([
      Customer.find(filter).sort({ code: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Customer.countDocuments(filter),
    ]);

    // Ambil ringkasan layanan sekaligus, hindari N+1 query
    const ids = items.map((c) => c._id);
    const services = await Service.find({ customer_id: { $in: ids } })
      .select('customer_id status type username')
      .lean();

    const byCustomer = new Map();
    for (const s of services) {
      const k = String(s.customer_id);
      if (!byCustomer.has(k)) byCustomer.set(k, []);
      byCustomer.get(k).push({ id: s._id, status: s.status, type: s.type, username: s.username });
    }

    return res.json({
      items: items.map((c) => ({
        id: c._id, code: c.code, name: c.name, phone: c.phone,
        address: c.address, status: c.status,
        services: byCustomer.get(String(c._id)) || [],
      })),
      total, page, limit,
    });
  } catch (err) {
    console.error('[admin/customers]', err.message);
    return res.status(500).json({ message: 'Gagal memuat pelanggan' });
  }
});

router.get('/customers/:id', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id).lean();
    if (!customer) return res.status(404).json({ message: 'Pelanggan tidak ditemukan' });

    const services = await Service.find({ customer_id: customer._id })
      .populate('plan_id', 'name price_idr rate_limit')
      .populate('router_id', 'name status')
      .lean();

    const invoices = await Invoice.find({ customer_id: customer._id })
      .sort({ issued_at: -1 })
      .limit(24)
      .lean();

    return res.json({ customer, services, invoices });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal memuat detail' });
  }
});

router.post('/customers', async (req, res) => {
  try {
    const { name, phone, address, email, note, lat, lng } = req.body;
    if (!name || !phone) return res.status(400).json({ message: 'Nama dan nomor HP wajib diisi' });

    const code = await nextCustomerCode();

    const customer = await Customer.create({
      code, name,
      phone: normalizePhone(phone),
      address, email, note,
      location: (lat && lng) ? { lat: Number(lat), lng: Number(lng) } : undefined,
    });

    return res.status(201).json({ customer });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Kode pelanggan sudah dipakai, coba lagi' });
    return res.status(400).json({ message: err.message });
  }
});

router.patch('/customers/:id', async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'address', 'email', 'note', 'status'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    if (update.phone) update.phone = normalizePhone(update.phone);

    const customer = await Customer.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!customer) return res.status(404).json({ message: 'Pelanggan tidak ditemukan' });

    return res.json({ customer });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Layanan                                                             */
/* ------------------------------------------------------------------ */

router.post('/services', async (req, res) => {
  try {
    const { customer_id, plan_id, router_id, type, username, secret, static_ip, due_day } = req.body;

    if (!customer_id || !plan_id || !router_id || !username) {
      return res.status(400).json({ message: 'Pelanggan, paket, router, dan username wajib diisi' });
    }

    const plan = await Plan.findById(plan_id);
    if (!plan) return res.status(400).json({ message: 'Paket tidak ditemukan' });

    const day = Number(due_day) || 5;
    const secretPlain = secret || crypto.randomBytes(5).toString('hex');

    const service = await Service.create({
      customer_id, plan_id, router_id,
      type: type || 'pppoe',
      username,
      secret: secretPlain,
      static_ip,
      due_day: day,
      // Jatuh tempo pertama: tanggal due_day di bulan berikutnya
      next_due_date: dayjs().tz(TZ).add(1, 'month').date(day).startOf('day').toDate(),
      status: 'active',
    });

    // Buat PPP secret di router. Kalau gagal, layanan tetap tercatat di DB
    // dengan status active — admin bisa menekan "Sinkronkan" belakangan.
    let provisionResult = { success: false, message: 'Bukan tipe PPPoE' };
    if (service.type === 'pppoe') {
      const routerDoc = await RouterModel.findById(router_id).select('+secret_enc');
      provisionResult = await routeros.provision(routerDoc, service, plan, secretPlain);

      await ServiceEvent.create({
        service_id: service._id,
        admin_id: req.admin._id,
        action: 'create',
        trigger: 'manual',
        success: provisionResult.success,
        router_response: String(provisionResult.success
          ? JSON.stringify(provisionResult.raw) : provisionResult.message).slice(0, 1000),
      });
    }

    return res.status(201).json({
      service,
      secret: secretPlain, // ditampilkan sekali saja di UI
      provision: { success: provisionResult.success, message: provisionResult.message },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Username sudah dipakai di router tersebut' });
    }
    return res.status(400).json({ message: err.message });
  }
});

router.post('/services/:id/isolate', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ message: 'Layanan tidak ditemukan' });

    const result = await isolation.isolateService(service, {
      trigger: 'manual',
      adminId: req.admin._id,
    });

    return res.status(result.success ? 200 : 502).json({
      success: result.success,
      message: result.success ? 'Layanan diisolir' : result.message,
      status: service.status,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.post('/services/:id/restore', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ message: 'Layanan tidak ditemukan' });

    const result = await isolation.restoreService(service, {
      trigger: 'manual',
      adminId: req.admin._id,
    });

    return res.status(result.success ? 200 : 502).json({
      success: result.success,
      message: result.success ? 'Isolir dibuka' : result.message,
      status: service.status,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get('/services/:id/events', async (req, res) => {
  try {
    const events = await ServiceEvent.find({ service_id: req.params.id })
      .populate('admin_id', 'name')
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    return res.json({ events });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal memuat riwayat' });
  }
});

/* ------------------------------------------------------------------ */
/* Tagihan & pembayaran                                                */
/* ------------------------------------------------------------------ */

router.get('/invoices', async (req, res) => {
  try {
    const page   = Math.max(1, Number(req.query.page) || 1);
    const limit  = Math.min(100, Number(req.query.limit) || 25);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.period) filter.period = req.query.period;
    if (req.query.overdue === 'true') {
      filter.status = 'unpaid';
      filter.due_date = { $lt: new Date() };
    }

    const [items, total, sumAgg] = await Promise.all([
      Invoice.find(filter)
        .populate('customer_id', 'name code phone')
        .sort({ issued_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Invoice.countDocuments(filter),
      Invoice.aggregate([
        { $match: filter },
        { $group: { _id: null, total: { $sum: '$total_idr' } } },
      ]),
    ]);

    return res.json({ items, total, page, limit, sum: sumAgg[0]?.total || 0 });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal memuat tagihan' });
  }
});

/**
 * Batalkan tagihan. Tidak pernah dihapus — nomor invoice harus tetap
 * berurutan tanpa lubang.
 */
router.post('/invoices/:id/void', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });
    if (invoice.status === 'paid') return res.status(409).json({ message: 'Tagihan sudah lunas' });

    invoice.status = 'void';
    await invoice.save();

    return res.json({ invoice });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 25);

    const filter = { status: 'settled' };
    if (req.query.from || req.query.to) {
      filter.settled_at = {};
      if (req.query.from) filter.settled_at.$gte = dayjs(req.query.from).tz(TZ).startOf('day').toDate();
      if (req.query.to)   filter.settled_at.$lte = dayjs(req.query.to).tz(TZ).endOf('day').toDate();
    }

    const [items, total, sumAgg] = await Promise.all([
      Payment.find(filter)
        .populate({ path: 'invoice_id', select: 'number customer_id', populate: { path: 'customer_id', select: 'name code' } })
        .populate('received_by', 'name')
        .sort({ settled_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Payment.countDocuments(filter),
      Payment.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount_idr' } } }]),
    ]);

    return res.json({ items, total, page, limit, sum: sumAgg[0]?.total || 0 });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal memuat pembayaran' });
  }
});

/* ------------------------------------------------------------------ */
/* Paket & router                                                      */
/* ------------------------------------------------------------------ */

router.get('/plans', async (req, res) => {
  const plans = await Plan.find({}).sort({ price_idr: 1 }).lean();
  res.json({ plans });
});

router.post('/plans', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const plan = await Plan.create(req.body);
    res.status(201).json({ plan });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get('/routers', async (req, res) => {
  // secret_enc tidak ikut (select: false di schema) — jangan pernah kirim ke UI
  const routers = await RouterModel.find({}).lean();
  res.json({ routers });
});

router.post('/routers', requireRole('owner'), async (req, res) => {
  try {
    const { name, host, username, password, api_port, use_tls, site } = req.body;
    if (!name || !host || !username || !password) {
      return res.status(400).json({ message: 'Nama, host, username, dan password wajib diisi' });
    }

    const doc = await RouterModel.create({
      name, host, username, site,
      api_port: Number(api_port) || (use_tls ? 8729 : 8728),
      use_tls: !!use_tls,
      secret_enc: encrypt(password),
    });

    // Langsung tes koneksi — jangan biarkan admin baru tahu kredensialnya
    // salah saat isolir otomatis gagal tengah malam.
    const fresh = await RouterModel.findById(doc._id).select('+secret_enc');
    const ping = await routeros.ping(fresh);

    await RouterModel.updateOne(
      { _id: doc._id },
      { $set: { status: ping.success ? 'online' : 'offline' } }
    );

    return res.status(201).json({
      router: { id: doc._id, name: doc.name, host: doc.host },
      test: { success: ping.success, message: ping.message, identity: ping.raw?.name },
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Nama router sudah dipakai' });
    return res.status(400).json({ message: err.message });
  }
});

router.get('/routers/:id/active', async (req, res) => {
  try {
    const routerDoc = await RouterModel.findById(req.params.id).select('+secret_enc');
    if (!routerDoc) return res.status(404).json({ message: 'Router tidak ditemukan' });

    const result = await routeros.listActive(routerDoc);
    if (!result.success) return res.status(502).json({ message: result.message });

    return res.json({
      active: result.raw.map((a) => ({
        name: a.name, address: a.address, uptime: a.uptime, service: a.service,
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Aksi manual                                                         */
/* ------------------------------------------------------------------ */

/** Jalankan generator invoice sekarang, tanpa menunggu cron. */
router.post('/jobs/generate-invoices', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await invoiceGenerator.run();
    return res.json({ result });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */

async function nextCustomerCode() {
  const { Counter } = require('../models');
  const doc = await Counter.findByIdAndUpdate(
    'customer',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return 'PLG-' + String(doc.seq).padStart(4, '0');
}

function normalizePhone(input) {
  let n = String(input).replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('8')) n = '62' + n;
  return n;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;

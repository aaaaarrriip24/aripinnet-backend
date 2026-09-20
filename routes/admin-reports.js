/**
 * Laporan bulanan.
 *
 * Semua agregasi dikerjakan MongoDB, bukan di Node. Menarik seluruh
 * invoice lalu menjumlahkannya dengan reduce akan baik-baik saja di 50
 * pelanggan dan mulai berat di 500 — dan saat itu terjadi, laporan
 * adalah halaman yang paling sering dibuka.
 *
 * Catatan soal periode: `invoices.period` adalah periode TAGIHAN
 * ("2026-09"), sedangkan pembayaran dikelompokkan berdasarkan
 * `settled_at` (kapan uangnya masuk). Keduanya sengaja dibedakan —
 * tagihan September bisa saja dibayar Oktober, dan laporan kas harus
 * mencatatnya di Oktober.
 */

const express = require('express');
const router = express.Router();

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const mongoose = require('mongoose');
const { Invoice, Payment, Customer, Service, Router: RouterModel } = require('../models');

const TZ = process.env.TZ_APP || 'Asia/Jakarta';

/* ------------------------------------------------------------------ */
/* Daftar periode yang tersedia                                        */
/* ------------------------------------------------------------------ */

router.get('/periods', async (req, res) => {
  try {
    const periods = await Invoice.distinct('period');
    periods.sort().reverse();
    return res.json({ periods });
  } catch (err) {
    return res.status(500).json({ message: 'Gagal memuat periode' });
  }
});

/* ------------------------------------------------------------------ */
/* Laporan bulanan                                                     */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/reports/monthly?period=2026-09
 */
router.get('/monthly', async (req, res) => {
  try {
    const period = String(req.query.period || dayjs().tz(TZ).format('YYYY-MM'));
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ message: 'Format periode harus YYYY-MM' });
    }

    const start = dayjs.tz(`${period}-01`, TZ).startOf('month');
    const end   = start.endOf('month');
    const startDate = start.toDate();
    const endDate   = end.toDate();

    const [
      tagihan, kasPerMetode, kasHarian, perRouter,
      pelangganBaru, statusLayanan, piutangLama,
    ] = await Promise.all([
      // Tagihan yang TERBIT untuk periode ini
      Invoice.aggregate([
        { $match: { period } },
        { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total_idr' } } },
      ]),

      // Uang yang MASUK di bulan ini, per metode
      Payment.aggregate([
        { $match: { status: 'settled', settled_at: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: '$method', count: { $sum: 1 }, total: { $sum: '$amount_idr' } } },
        { $sort: { total: -1 } },
      ]),

      // Uang masuk per hari — untuk grafik
      Payment.aggregate([
        { $match: { status: 'settled', settled_at: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$settled_at', timezone: TZ } },
            count: { $sum: 1 },
            total: { $sum: '$amount_idr' },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Rincian per router: ditagih vs tertagih
      Invoice.aggregate([
        { $match: { period } },
        {
          $lookup: {
            from: 'services', localField: 'service_id', foreignField: '_id', as: 'svc',
          },
        },
        { $unwind: '$svc' },
        {
          $group: {
            _id: '$svc.router_id',
            ditagih_count: { $sum: 1 },
            ditagih_total: { $sum: '$total_idr' },
            lunas_count: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
            lunas_total: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$total_idr', 0] } },
          },
        },
      ]),

      Customer.countDocuments({ joined_at: { $gte: startDate, $lte: endDate } }),

      Service.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      // Tunggakan dari periode SEBELUM ini yang masih belum lunas.
      // Angka ini yang sering terlupakan — piutang menumpuk diam-diam.
      Invoice.aggregate([
        { $match: { status: 'unpaid', period: { $lt: period } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total_idr' } } },
      ]),
    ]);

    const routers = await RouterModel.find({}).select('name site').lean();
    const routerMap = new Map(routers.map((r) => [String(r._id), r]));

    // ---- Susun hasil ----
    const byStatus = (s) => tagihan.find((t) => t._id === s) || { count: 0, total: 0 };
    const terbit = byStatus('unpaid');
    const lunas  = byStatus('paid');
    const batal  = byStatus('void');

    const ditagihCount = terbit.count + lunas.count;
    const ditagihTotal = terbit.total + lunas.total;
    const kasTotal = kasPerMetode.reduce((s, m) => s + m.total, 0);

    return res.json({
      period,
      label: start.format('MMMM YYYY'),

      tagihan: {
        terbit_count: ditagihCount,
        terbit_total: ditagihTotal,
        lunas_count:  lunas.count,
        lunas_total:  lunas.total,
        belum_count:  terbit.count,
        belum_total:  terbit.total,
        batal_count:  batal.count,
        batal_total:  batal.total,
        // Persentase tagihan periode ini yang sudah tertagih
        collection_rate: ditagihTotal > 0
          ? Math.round((lunas.total / ditagihTotal) * 1000) / 10
          : 0,
      },

      kas: {
        total: kasTotal,
        count: kasPerMetode.reduce((s, m) => s + m.count, 0),
        per_metode: kasPerMetode.map((m) => ({
          metode: m._id,
          count: m.count,
          total: m.total,
          persen: kasTotal > 0 ? Math.round((m.total / kasTotal) * 1000) / 10 : 0,
        })),
        harian: kasHarian.map((d) => ({ tanggal: d._id, count: d.count, total: d.total })),
      },

      per_router: perRouter
        .map((r) => ({
          router_id: r._id,
          router: routerMap.get(String(r._id))?.name || 'tidak diketahui',
          site: routerMap.get(String(r._id))?.site || null,
          ditagih_count: r.ditagih_count,
          ditagih_total: r.ditagih_total,
          lunas_count: r.lunas_count,
          lunas_total: r.lunas_total,
          collection_rate: r.ditagih_total > 0
            ? Math.round((r.lunas_total / r.ditagih_total) * 1000) / 10
            : 0,
        }))
        .sort((a, b) => b.ditagih_total - a.ditagih_total),

      pelanggan: {
        baru: pelangganBaru,
        layanan_aktif:  statusLayanan.find((s) => s._id === 'active')?.count || 0,
        layanan_isolir: statusLayanan.find((s) => s._id === 'isolated')?.count || 0,
        layanan_berhenti: statusLayanan.find((s) => s._id === 'terminated')?.count || 0,
      },

      tunggakan_lama: {
        count: piutangLama[0]?.count || 0,
        total: piutangLama[0]?.total || 0,
      },
    });
  } catch (err) {
    console.error('[reports/monthly]', err.message);
    return res.status(500).json({ message: 'Gagal menyusun laporan' });
  }
});

/* ------------------------------------------------------------------ */
/* Rincian untuk ekspor                                                */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/reports/monthly/detail?period=2026-09&type=tagihan|kas
 *
 * Mengembalikan baris mentah untuk diekspor jadi CSV di sisi panel.
 * Dibatasi 2000 baris — di atas itu, laporan sebaiknya per router.
 */
router.get('/monthly/detail', async (req, res) => {
  try {
    const period = String(req.query.period || dayjs().tz(TZ).format('YYYY-MM'));
    const type = req.query.type === 'kas' ? 'kas' : 'tagihan';

    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ message: 'Format periode harus YYYY-MM' });
    }

    if (type === 'tagihan') {
      const rows = await Invoice.find({ period })
        .populate('customer_id', 'name code phone')
        .populate({ path: 'service_id', select: 'username router_id', populate: { path: 'router_id', select: 'name' } })
        .sort({ number: 1 })
        .limit(2000)
        .lean();

      return res.json({
        type,
        period,
        rows: rows.map((i) => ({
          nomor: i.number,
          kode: i.customer_id?.code || '',
          pelanggan: i.customer_id?.name || '',
          layanan: i.service_id?.username || '',
          router: i.service_id?.router_id?.name || '',
          jumlah: i.total_idr,
          jatuh_tempo: i.due_date,
          status: i.status,
          dibayar: i.paid_at || null,
        })),
      });
    }

    const start = dayjs.tz(`${period}-01`, TZ).startOf('month').toDate();
    const end   = dayjs.tz(`${period}-01`, TZ).endOf('month').toDate();

    const rows = await Payment.find({ status: 'settled', settled_at: { $gte: start, $lte: end } })
      .populate({
        path: 'invoice_id',
        select: 'number customer_id',
        populate: { path: 'customer_id', select: 'name code' },
      })
      .populate('received_by', 'name')
      .sort({ settled_at: 1 })
      .limit(2000)
      .lean();

    return res.json({
      type,
      period,
      rows: rows.map((p) => ({
        waktu: p.settled_at,
        nomor: p.invoice_id?.number || '',
        kode: p.invoice_id?.customer_id?.code || '',
        pelanggan: p.invoice_id?.customer_id?.name || '',
        metode: p.method,
        channel: p.channel || '',
        diterima_oleh: p.received_by?.name || '',
        jumlah: p.amount_idr,
      })),
    });
  } catch (err) {
    console.error('[reports/detail]', err.message);
    return res.status(500).json({ message: 'Gagal memuat rincian' });
  }
});

/* ------------------------------------------------------------------ */
/* Tren beberapa bulan                                                 */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/reports/trend?months=6
 *
 * Membandingkan beberapa bulan terakhir. Yang dilihat di sini bukan
 * nominalnya, tapi arahnya: collection rate yang turun tiga bulan
 * berturut-turut adalah masalah penagihan, bukan masalah harga.
 */
router.get('/trend', async (req, res) => {
  try {
    const months = Math.min(24, Math.max(2, Number(req.query.months) || 6));
    const periods = [];
    for (let i = months - 1; i >= 0; i--) {
      periods.push(dayjs().tz(TZ).subtract(i, 'month').format('YYYY-MM'));
    }

    const tagihan = await Invoice.aggregate([
      { $match: { period: { $in: periods } } },
      {
        $group: {
          _id: '$period',
          ditagih: { $sum: { $cond: [{ $ne: ['$status', 'void'] }, '$total_idr', 0] } },
          lunas:   { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$total_idr', 0] } },
          count:   { $sum: { $cond: [{ $ne: ['$status', 'void'] }, 1, 0] } },
        },
      },
    ]);

    const map = new Map(tagihan.map((t) => [t._id, t]));

    return res.json({
      trend: periods.map((p) => {
        const t = map.get(p) || { ditagih: 0, lunas: 0, count: 0 };
        return {
          period: p,
          label: dayjs.tz(`${p}-01`, TZ).format('MMM YY'),
          ditagih: t.ditagih,
          lunas: t.lunas,
          count: t.count,
          collection_rate: t.ditagih > 0 ? Math.round((t.lunas / t.ditagih) * 1000) / 10 : 0,
        };
      }),
    });
  } catch (err) {
    console.error('[reports/trend]', err.message);
    return res.status(500).json({ message: 'Gagal memuat tren' });
  }
});

module.exports = router;

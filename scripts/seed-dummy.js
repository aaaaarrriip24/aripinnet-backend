/**
 * Data pelanggan dummy untuk menguji panel dan app.
 *
 *   node scripts/seed-dummy.js            # buat 12 pelanggan
 *   node scripts/seed-dummy.js 30         # buat 30 pelanggan
 *   node scripts/seed-dummy.js --clean    # hapus SEMUA data dummy
 *
 * Semua dokumen yang dibuat di sini ditandai note='DUMMY' pada pelanggan,
 * dan itu satu-satunya penanda yang dipakai saat menghapus. Data asli
 * tidak akan tersentuh selama Anda tidak menulis 'DUMMY' di catatan
 * pelanggan sungguhan.
 *
 * Kondisi yang sengaja dibuat beragam, supaya panel tidak cuma menampilkan
 * baris yang seragam:
 *   - lunas          : sudah dibayar, ada catatan kas
 *   - belum bayar    : jatuh tempo masih di depan
 *   - jatuh tempo    : lewat tanggal, layanan masih aktif (dalam masa tenggang)
 *   - terisolir      : lewat tenggang, layanan dimatikan
 *
 * CATATAN: skrip ini menulis langsung ke database, TIDAK menyentuh
 * RouterOS. Jadi 'terisolir' di sini hanya status di DB — tidak ada PPP
 * secret sungguhan yang dipindahkan ke profile isolir.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const dayjs = require('dayjs');

const {
  Customer, Service, Invoice, Payment, Plan, Router: RouterModel, Counter, ServiceEvent,
} = require('../models');
const { nextInvoiceNumber } = require('../lib/counter');

const TANDA = 'DUMMY';

const NAMA_DEPAN = [
  'Budi', 'Siti', 'Agus', 'Dewi', 'Eko', 'Rina', 'Joko', 'Ani',
  'Hendra', 'Lia', 'Bambang', 'Nur', 'Dedi', 'Wati', 'Rudi', 'Yuni',
  'Slamet', 'Endang', 'Tono', 'Sri',
];
const NAMA_BELAKANG = [
  'Santoso', 'Wijaya', 'Kusuma', 'Pratama', 'Lestari', 'Hidayat',
  'Saputra', 'Rahayu', 'Nugroho', 'Maulana', 'Setiawan', 'Anggraini',
];
const JALAN = [
  'Jl. Melati', 'Jl. Kenanga', 'Jl. Mawar', 'Jl. Anggrek', 'Jl. Dahlia',
  'Gg. Masjid', 'Gg. Sawo', 'Jl. Veteran', 'Jl. Gaduk', 'Jl. Merpati',
];

const acak = (arr) => arr[Math.floor(Math.random() * arr.length)];
const angka = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function nextCustomerCode() {
  const doc = await Counter.findByIdAndUpdate(
    'customer', { $inc: { seq: 1 } }, { new: true, upsert: true }
  );
  return 'PLG-' + String(doc.seq).padStart(4, '0');
}

/* ------------------------------------------------------------------ */

async function bersihkan() {
  const customers = await Customer.find({ note: TANDA }).select('_id').lean();
  if (!customers.length) {
    console.log('Tidak ada data dummy.');
    return;
  }

  const ids = customers.map((c) => c._id);
  const services = await Service.find({ customer_id: { $in: ids } }).select('_id').lean();
  const serviceIds = services.map((s) => s._id);
  const invoices = await Invoice.find({ customer_id: { $in: ids } }).select('_id').lean();
  const invoiceIds = invoices.map((i) => i._id);

  const hasil = {
    payments: (await Payment.deleteMany({ invoice_id: { $in: invoiceIds } })).deletedCount,
    events:   (await ServiceEvent.deleteMany({ service_id: { $in: serviceIds } })).deletedCount,
    invoices: (await Invoice.deleteMany({ _id: { $in: invoiceIds } })).deletedCount,
    services: (await Service.deleteMany({ _id: { $in: serviceIds } })).deletedCount,
    customers:(await Customer.deleteMany({ _id: { $in: ids } })).deletedCount,
  };

  console.log('Dihapus:', hasil);
}

async function buat(jumlah) {
  const plans = await Plan.find({ is_active: true }).lean();
  if (!plans.length) {
    console.error('Belum ada paket. Jalankan `node scripts/seed.js` dulu.');
    process.exit(1);
  }

  const routers = await RouterModel.find().lean();
  if (!routers.length) {
    console.error('Belum ada router. Tambahkan satu lewat panel dulu.');
    process.exit(1);
  }

  const now = dayjs();
  const ringkasan = { lunas: 0, belum_bayar: 0, jatuh_tempo: 0, terisolir: 0 };

  for (let i = 0; i < jumlah; i++) {
    // Sebaran kondisi: 40% lunas, 30% belum bayar, 15% jatuh tempo, 15% terisolir
    const r = Math.random();
    const kondisi = r < 0.40 ? 'lunas'
                  : r < 0.70 ? 'belum_bayar'
                  : r < 0.85 ? 'jatuh_tempo'
                  : 'terisolir';

    const plan = acak(plans);
    const routerDoc = acak(routers);
    const nama = `${acak(NAMA_DEPAN)} ${acak(NAMA_BELAKANG)}`;
    const code = await nextCustomerCode();

    const customer = await Customer.create({
      code,
      name: nama,
      // 62800-xxxxxxx: +62 800 BUKAN prefiks seluler yang dialokasikan di
      // Indonesia (seluler ada di 62811-62899), jadi nomor ini tidak mungkin
      // terdaftar di WhatsApp.
      //
      // Ini penting, bukan kosmetik: begitu worker.js hidup, sistem benar-
      // benar mengirim WhatsApp ke nomor yang ada di database. Data uji
      // berisi nomor acak yang valid akan membuat orang asing menerima
      // tagihan internet yang tidak pernah mereka langgan.
      phone: '62800' + String(angka(1000000, 9999999)),
      address: `${acak(JALAN)} No.${angka(1, 120)}, RT ${angka(1, 12)}/RW ${angka(1, 8)}`,
      status: 'active',
      note: TANDA,
      joined_at: now.subtract(angka(1, 400), 'day').toDate(),
    });

    const dueDay = angka(1, 28);
    const terisolir = kondisi === 'terisolir';

    // Jatuh tempo: di depan kalau belum bayar/lunas, di belakang kalau nunggak
    const nextDue = kondisi === 'jatuh_tempo' ? now.subtract(angka(1, 3), 'day')
                  : terisolir                 ? now.subtract(angka(4, 20), 'day')
                  : now.add(angka(3, 25), 'day');

    const tipe = Math.random() < 0.85 ? 'pppoe' : 'static';

    const service = await Service.create({
      customer_id: customer._id,
      plan_id: plan._id,
      router_id: routerDoc._id,
      type: tipe,
      username: code.toLowerCase().replace('-', ''),
      secret: Math.random().toString(36).slice(2, 12),
      static_ip: tipe === 'static' ? `10.10.${angka(1, 254)}.${angka(2, 254)}` : undefined,
      due_day: dueDay,
      next_due_date: nextDue.toDate(),
      installed_at: customer.joined_at,
      status: terisolir ? 'isolated' : 'active',
      isolated_at: terisolir ? now.subtract(angka(1, 10), 'day').toDate() : undefined,
    });

    // ---- Tagihan ----
    const period = nextDue.format('YYYY-MM');
    const uniqueCode = process.env.USE_UNIQUE_CODE === 'false' ? 0 : angka(1, 999);
    const total = plan.price_idr + uniqueCode;
    const lunas = kondisi === 'lunas';

    const invoice = await Invoice.create({
      service_id: service._id,
      customer_id: customer._id,
      number: await nextInvoiceNumber(period),
      period,
      amount_idr: plan.price_idr,
      unique_code: uniqueCode,
      total_idr: total,
      issued_at: nextDue.subtract(7, 'day').toDate(),
      due_date: nextDue.endOf('day').toDate(),
      status: lunas ? 'paid' : 'unpaid',
      paid_at: lunas ? nextDue.subtract(angka(0, 5), 'day').toDate() : undefined,
    });

    if (lunas) {
      const metode = acak(['qris', 'va', 'cash']);
      await Payment.create({
        invoice_id: invoice._id,
        amount_idr: total,
        method: metode,
        gateway: metode === 'cash' ? 'manual' : 'midtrans',
        gateway_ref: metode === 'cash' ? undefined : `DUMMY-${invoice.number.replace(/\//g, '')}`,
        status: 'settled',
        settled_at: invoice.paid_at,
      });
    }

    if (terisolir) {
      await ServiceEvent.create({
        service_id: service._id,
        action: 'isolate',
        trigger: 'auto',
        success: true,
        router_response: 'DUMMY — tidak menyentuh router',
      });
    }

    ringkasan[kondisi]++;
  }

  console.log(`${jumlah} pelanggan dummy dibuat:`);
  console.log('  lunas       :', ringkasan.lunas);
  console.log('  belum bayar :', ringkasan.belum_bayar);
  console.log('  jatuh tempo :', ringkasan.jatuh_tempo);
  console.log('  terisolir   :', ringkasan.terisolir);
  console.log('\nHapus lagi dengan: node scripts/seed-dummy.js --clean');
}

/* ------------------------------------------------------------------ */

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  if (process.argv.includes('--clean')) {
    await bersihkan();
  } else {
    const jumlah = Number(process.argv[2]) || 12;
    await buat(jumlah);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Gagal:', err.message);
  process.exit(1);
});

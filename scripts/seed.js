/**
 * Seed data awal: satu admin owner dan beberapa paket.
 *
 * Jalankan sekali setelah database kosong:
 *   node scripts/seed.js
 *
 * Password admin dibuat acak dan ditampilkan sekali di terminal —
 * jangan hardcode password default, itu selalu berakhir tidak diganti.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { Admin, Plan } = require('../models');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB terhubung\n');

  // ---- Admin ----
  const email = process.argv[2] || 'admin@namaisp.net';
  const existing = await Admin.findOne({ email });

  if (existing) {
    console.log(`Admin ${email} sudah ada, dilewati.`);
  } else {
    const password = crypto.randomBytes(9).toString('base64url');
    await Admin.create({
      name: 'Owner',
      email,
      password_hash: await bcrypt.hash(password, 10),
      role: 'owner',
    });

    console.log('Admin dibuat:');
    console.log('  Email    :', email);
    console.log('  Password :', password);
    console.log('  >> Catat sekarang. Tidak ditampilkan lagi.\n');
  }

  // ---- Paket contoh ----
  const count = await Plan.countDocuments();
  if (count === 0) {
    await Plan.insertMany([
      { name: 'Home 5 Mbps',  price_idr: 100000, rate_limit: '5M/5M',   ppp_profile: 'paket-5m' },
      { name: 'Home 10 Mbps', price_idr: 150000, rate_limit: '10M/10M', ppp_profile: 'paket-10m' },
      { name: 'Home 20 Mbps', price_idr: 200000, rate_limit: '20M/20M', ppp_profile: 'paket-20m' },
    ]);
    console.log('3 paket contoh dibuat.');
    console.log('>> Pastikan ppp_profile di atas benar-benar ada di RouterOS:');
    console.log('   /ppp profile add name=paket-10m rate-limit=10M/10M\n');
  } else {
    console.log(`${count} paket sudah ada, dilewati.`);
  }

  // Pastikan semua unique index terbuat sebelum data masuk
  await Promise.all(Object.values(require('../models')).map((m) => m.syncIndexes?.()));
  console.log('Index tersinkron.');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed gagal:', err.message);
  process.exit(1);
});

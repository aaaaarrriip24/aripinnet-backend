# Backend — Billing RT/RW Net

API server, job terjadwal, dan worker WhatsApp untuk sistem billing
RT/RW Net berbasis MikroTik.

## Yang dikerjakan

- Menerbitkan tagihan bulanan otomatis
- Isolir dan buka isolir lewat RouterOS API (PPPoE & static IP)
- Pembayaran QRIS / Virtual Account lewat Midtrans
- Notifikasi WhatsApp (Baileys) dengan pola outbox
- Halaman walled garden untuk pelanggan yang terisolir
- Watchdog + alert Telegram kalau ada yang mati

## Kebutuhan

- Node.js 18 atau lebih baru
- MongoDB dengan replica set (MongoDB Atlas sudah otomatis) — dibutuhkan
  untuk transaksi multi-dokumen di alur settlement pembayaran
- Akses jaringan ke MikroTik, sebaiknya lewat VPN (WireGuard/ZeroTier)
- Akun Midtrans
- Satu nomor WhatsApp khusus, bukan nomor pribadi

## Pemasangan

```bash
npm install
cp .env.example .env
```

Isi tiga secret di `.env`, masing-masing berbeda:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Lalu buat admin pertama dan paket contoh:

```bash
node scripts/seed.js admin@domainanda.net
```

Password admin ditampilkan sekali di terminal. Catat sekarang.

## Menjalankan

```bash
pm2 start app.js    --name billing-api
pm2 start worker.js --name billing-wa -i 1
```

`-i 1` pada worker wajib. Session Baileys tidak bisa dipakai dua proses
sekaligus; keduanya akan saling menendang sampai session rusak dan nomor
berisiko diblokir.

Pertama kali jalan, QR akan muncul di log:

```bash
pm2 logs billing-wa
```

Scan dengan nomor WhatsApp khusus tadi.

## Urutan setup yang disarankan

1. **Tes alert lebih dulu.** Sistem yang bisa melapor tapi tidak punya
   tujuan kirim sama saja dengan sistem yang diam.
   ```bash
   node -e "require('dotenv').config(); \
     require('mongoose').connect(process.env.MONGO_URI).then(async () => { \
       console.log(await require('./services/alert').test()); process.exit(0); })"
   ```
2. Tambahkan router lewat panel. Tombol simpan sekaligus menguji koneksi.
3. Buat paket, lalu **petakan ke tiap router** (Paket → Sinkronkan).
   Paket yang belum dipetakan tidak bisa dipakai, dan layanannya tidak
   akan bisa dibuka isolirnya.
4. Tambahkan pelanggan dan layanan.
5. Jalankan generator invoice manual sekali dari panel untuk memastikan
   tagihan terbit dengan benar.

## Konfigurasi RouterOS

Per router, sekali saja. Profile paket dibuat otomatis dari panel;
yang di bawah ini harus manual.

```
# Pool dan profile isolir
/ip pool add name=isolir-pool ranges=10.99.99.10-10.99.99.254
/ppp profile add name=isolir local-address=10.99.99.1 \
  remote-address=isolir-pool rate-limit=1M/1M

# User API khusus — jangan pakai admin
/user group add name=billing policy=api,read,write,test
/user add name=billing group=billing password=<kuat> \
  address=<IP_VPN_SERVER>/32
```

Aturan firewall walled garden ada di komentar bawah
`public/isolir/index.html`, termasuk yang sering terlewat: host Midtrans
harus diizinkan, kalau tidak gambar QR tidak muncul dan pelanggan
terjebak di halaman isolir.

## Struktur

```
app.js                    API server + pemasangan route
worker.js                 Entrypoint worker WhatsApp (proses terpisah)
models.js                 Seluruh skema Mongoose

lib/
  crypto.js               Enkripsi kredensial router (AES-256-GCM)
  counter.js              Nomor invoice & kode unik yang atomik
  plan-profile.js         Pemetaan paket ke PPP profile per router

services/
  routeros.js             Semua interaksi MikroTik
  midtrans.js             Klien Core API
  settlement.js           Penerapan pembayaran (transaksi DB)
  whatsapp.js             Adapter Baileys + deteksi banned
  alert.js                Kirim alert ke Telegram/webhook

jobs/
  scheduler.js            Semua jadwal cron + lock
  invoice-generator.js    Terbitkan tagihan bulanan
  isolation.js            Isolir/restore + pengingat
  notification-worker.js  Pengirim antrian WhatsApp
  wa-watchdog.js          Pantau kesehatan WhatsApp

routes/
  auth.js                 Login admin + OTP pelanggan
  admin.js                Pelanggan, layanan, tagihan, router
  admin-plans.js          Paket & pemetaan per MikroTik
  admin-reports.js        Laporan bulanan
  admin-system.js         Status WhatsApp & alert
  customer.js             API app pelanggan
  payment.js              Charge + webhook Midtrans
  public.js               Endpoint halaman isolir (tanpa auth)

public/isolir/            Halaman walled garden (satu file, tanpa CDN)
```

## Hal yang mudah salah

**Webhook Midtrans tidak boleh di belakang auth.** Sudah dipasang
sebelum middleware admin di `app.js`.

**Jangan panggil restore router di dalam transaksi database.** Kalau
router timeout, transaksi rollback dan pembayaran hilang padahal uang
sudah masuk. Urutannya: commit DB dulu, baru sentuh router. Job
`reconcile` tiap 15 menit yang membereskan sisanya.

**Isolir dijadwalkan jam 9 pagi, bukan tengah malam.** Kalau ada yang
salah isolir, admin masih bangun dan bisa segera membuka.

**Nomor WhatsApp bisa diblokir.** Baileys tidak resmi. Jeda acak, batas
kirim per jam, dan jam tenang sudah dipasang sebagai mitigasi. Di atas
~300 pelanggan, pertimbangkan pindah ke WhatsApp Cloud API resmi.

## Lisensi

MIT

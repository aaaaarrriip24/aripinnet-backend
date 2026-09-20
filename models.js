/**
 * Skema database billing RT/RW Net — Mongoose
 *
 * VERSI 2 — perubahan dari versi sebelumnya:
 * - plans.profiles[]  : nama PPP profile per router (paket per MikroTik)
 * - WaStatus          : status koneksi WhatsApp untuk watchdog
 * - AlertLog          : catatan alert terkirim, untuk cooldown anti-spam
 *
 * Catatan penting:
 * - Semua nilai uang disimpan sebagai Integer rupiah (bukan float/Decimal).
 * - Invoice tidak pernah dihapus; gunakan status 'void'.
 * - Butuh replica set (MongoDB Atlas sudah otomatis) untuk transaksi
 *   multi-dokumen di alur settlement pembayaran.
 */

const mongoose = require('mongoose');
const { Schema, model } = mongoose;

const opts = { timestamps: true };

/* ------------------------------------------------------------------ */
/* ADMINS — operator panel                                             */
/* ------------------------------------------------------------------ */
const adminSchema = new Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true, select: false },
  role:          { type: String, enum: ['owner', 'admin', 'teknisi', 'kasir'], default: 'admin' },
  is_active:     { type: Boolean, default: true },
}, opts);

adminSchema.index({ email: 1 }, { unique: true });

/* ------------------------------------------------------------------ */
/* ROUTERS — MikroTik yang dikelola                                    */
/* ------------------------------------------------------------------ */
const routerSchema = new Schema({
  name:        { type: String, required: true },   // veteran3, gadukan, gang9
  host:        { type: String, required: true },   // IP VPN (WireGuard/ZeroTier)
  api_port:    { type: Number, default: 8728 },    // 8729 kalau api-ssl
  use_tls:     { type: Boolean, default: false },
  username:    { type: String, required: true },
  secret_enc:  { type: String, required: true, select: false }, // AES-256-GCM, kunci di env
  site:        { type: String },                   // lokasi fisik / RT
  status:      { type: String, enum: ['online', 'offline', 'unknown'], default: 'unknown' },
  last_seen_at:{ type: Date },
}, opts);

routerSchema.index({ name: 1 }, { unique: true });

/* ------------------------------------------------------------------ */
/* PLANS — paket layanan                                               */
/* ------------------------------------------------------------------ */

/**
 * Nama PPP profile untuk satu router tertentu.
 *
 * Kenapa per router: profile PPP hidup di dalam masing-masing MikroTik.
 * Router "veteran3" bisa saja sudah punya profile bernama `paket-10m`
 * sementara `gadukan` memakai `10mbps` karena dibuat orang berbeda
 * bertahun lalu. Memaksa satu nama global berarti harus mengedit router
 * yang sudah berjalan — cara paling cepat membuat pelanggan terputus.
 *
 * in_sync menandai apakah isi profile di router sudah cocok dengan
 * rate_limit paket. Diisi saat sinkronisasi/verifikasi, bukan ditebak.
 */
const planProfileSchema = new Schema({
  router_id:   { type: Schema.Types.ObjectId, ref: 'Router', required: true },
  ppp_profile: { type: String, required: true },
  in_sync:     { type: Boolean, default: false },
  synced_at:   { type: Date },
  last_error:  { type: String },
}, { _id: false });

const planSchema = new Schema({
  name:        { type: String, required: true },   // "Home 10 Mbps"
  price_idr:   { type: Number, required: true, min: 0 },
  rate_limit:  { type: String, required: true },   // "10M/10M" — Mikrotik-Rate-Limit
  cycle_days:  { type: Number, default: 30 },      // 30 = bulanan
  tax_percent: { type: Number, default: 0 },       // PPN kalau nanti berbadan usaha
  is_active:   { type: Boolean, default: true },

  // Profile per router. Ini sumber kebenaran sejak versi 2.
  profiles:    { type: [planProfileSchema], default: [] },

  // Fallback lama. Dipakai hanya kalau router tidak ada di profiles[].
  // Jangan dihapus — data lama masih memakainya.
  ppp_profile: { type: String },
}, opts);

planSchema.index({ is_active: 1, price_idr: 1 });
planSchema.index({ 'profiles.router_id': 1 });

/* ------------------------------------------------------------------ */
/* CUSTOMERS — identitas pelanggan (bukan layanannya)                  */
/* ------------------------------------------------------------------ */
const customerSchema = new Schema({
  code:       { type: String, required: true },    // PLG-0001, dipakai di WA & invoice
  name:       { type: String, required: true },
  phone:      { type: String, required: true },    // format E.164: 628xxx (untuk WA)
  email:      { type: String, lowercase: true, trim: true },
  address:    { type: String },
  location:   {
    lat: { type: Number },
    lng: { type: Number },
  },
  id_number:  { type: String, select: false },     // NIK, jangan ikut di query default
  status:     { type: String, enum: ['active', 'inactive', 'blacklist'], default: 'active' },
  joined_at:  { type: Date, default: Date.now },
  note:       { type: String },
}, opts);

customerSchema.index({ code: 1 }, { unique: true });
customerSchema.index({ phone: 1 });
customerSchema.index({ joined_at: 1 });   // laporan pelanggan baru per bulan

/* ------------------------------------------------------------------ */
/* SERVICES — satu sambungan internet. Inti dari sistem.               */
/* ------------------------------------------------------------------ */
const serviceSchema = new Schema({
  customer_id: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  plan_id:     { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
  router_id:   { type: Schema.Types.ObjectId, ref: 'Router', required: true },

  type:        { type: String, enum: ['pppoe', 'hotspot', 'static'], default: 'pppoe' },
  username:    { type: String, required: true },   // = nama PPP secret di RouterOS
  secret:      { type: String, required: true, select: false },
  static_ip:   { type: String },
  mac_address: { type: String },

  due_day:      { type: Number, min: 1, max: 28, default: 5 },
  next_due_date:{ type: Date, required: true },
  installed_at: { type: Date, default: Date.now },

  status:      {
    type: String,
    enum: ['active', 'isolated', 'suspended', 'terminated'],
    default: 'active',
  },
  isolated_at: { type: Date },
}, opts);

serviceSchema.index({ router_id: 1, username: 1 }, { unique: true });
serviceSchema.index({ customer_id: 1 });
serviceSchema.index({ next_due_date: 1, status: 1 });
serviceSchema.index({ plan_id: 1, router_id: 1 });  // berapa layanan per paket per router

/* ------------------------------------------------------------------ */
/* INVOICES                                                            */
/* ------------------------------------------------------------------ */
const invoiceSchema = new Schema({
  service_id:  { type: Schema.Types.ObjectId, ref: 'Service', required: true },
  customer_id: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  number:      { type: String, required: true },   // INV/2026/09/0001
  period:      { type: String, required: true },   // "2026-09" — kunci anti-dobel

  amount_idr:  { type: Number, required: true, min: 0 },
  tax_idr:     { type: Number, default: 0 },
  unique_code: { type: Number, default: 0, min: 0, max: 999 },
  total_idr:   { type: Number, required: true, min: 0 },

  issued_at:   { type: Date, default: Date.now },
  due_date:    { type: Date, required: true },
  status:      { type: String, enum: ['unpaid', 'paid', 'void'], default: 'unpaid' },
  paid_at:     { type: Date },
}, opts);

invoiceSchema.index({ number: 1 }, { unique: true });
invoiceSchema.index({ service_id: 1, period: 1 }, { unique: true });
invoiceSchema.index(
  { unique_code: 1 },
  { unique: true, partialFilterExpression: { status: 'unpaid', unique_code: { $gt: 0 } } }
);
invoiceSchema.index({ status: 1, due_date: 1 });
invoiceSchema.index({ period: 1, status: 1 });   // laporan bulanan
invoiceSchema.index({ customer_id: 1, issued_at: -1 });

/* ------------------------------------------------------------------ */
/* PAYMENTS                                                            */
/* ------------------------------------------------------------------ */
const paymentSchema = new Schema({
  invoice_id:  { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
  amount_idr:  { type: Number, required: true, min: 0 },
  method:      {
    type: String,
    enum: ['qris', 'va', 'retail', 'ewallet', 'transfer', 'cash'],
    required: true,
  },
  channel:     { type: String },
  gateway:     { type: String, enum: ['midtrans', 'xendit', 'manual'], default: 'manual' },
  gateway_ref: { type: String },
  status:      {
    type: String,
    enum: ['pending', 'settled', 'expired', 'failed', 'refunded'],
    default: 'pending',
  },
  raw_payload: { type: Schema.Types.Mixed },
  received_by: { type: Schema.Types.ObjectId, ref: 'Admin' },
  last_error:  { type: String },
  settled_at:  { type: Date },
}, opts);

paymentSchema.index(
  { gateway_ref: 1 },
  { unique: true, partialFilterExpression: { gateway_ref: { $type: 'string' } } }
);
paymentSchema.index({ invoice_id: 1 });
paymentSchema.index({ status: 1, settled_at: -1 });  // laporan kas

/* ------------------------------------------------------------------ */
/* SERVICE_EVENTS — audit trail isolir/restore                         */
/* ------------------------------------------------------------------ */
const serviceEventSchema = new Schema({
  service_id: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
  admin_id:   { type: Schema.Types.ObjectId, ref: 'Admin' },
  action:     {
    type: String,
    enum: ['create', 'isolate', 'restore', 'suspend', 'terminate', 'change_plan', 'sync'],
    required: true,
  },
  trigger:    { type: String, enum: ['auto', 'manual', 'webhook'], default: 'manual' },
  success:    { type: Boolean, required: true },
  router_response: { type: String },
  meta:       { type: Schema.Types.Mixed },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

serviceEventSchema.index({ service_id: 1, created_at: -1 });
serviceEventSchema.index({ created_at: -1 });

/* ------------------------------------------------------------------ */
/* NOTIFICATIONS — outbox WhatsApp/email                               */
/* ------------------------------------------------------------------ */
const notificationSchema = new Schema({
  customer_id: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  invoice_id:  { type: Schema.Types.ObjectId, ref: 'Invoice' },
  channel:     { type: String, enum: ['whatsapp', 'email', 'push'], default: 'whatsapp' },
  template:    { type: String, required: true },
  payload:     { type: Schema.Types.Mixed },
  body:        { type: String },
  status:      { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
  retry_count: { type: Number, default: 0 },
  last_error:  { type: String },
  sent_at:     { type: Date },
}, opts);

notificationSchema.index({ status: 1, createdAt: 1 });
notificationSchema.index({ customer_id: 1, createdAt: -1 });
notificationSchema.index({ status: 1, updatedAt: -1 });  // watchdog: lonjakan gagal
notificationSchema.index(
  { invoice_id: 1, template: 1 },
  { unique: true, partialFilterExpression: { invoice_id: { $type: 'objectId' } } }
);

/* ------------------------------------------------------------------ */
/* WA_STATUS — kondisi koneksi WhatsApp (dokumen tunggal)              */
/* ------------------------------------------------------------------ */

/**
 * Dokumen tunggal dengan _id 'wa'.
 *
 * Ditulis worker WhatsApp, dibaca watchdog dan dashboard. Perlu di DB
 * (bukan variabel di memori) justru karena worker dan API server adalah
 * proses berbeda — API server tidak punya cara lain untuk tahu apakah
 * worker masih hidup.
 */
const waStatusSchema = new Schema({
  _id:                  { type: String, default: 'wa' },
  connected:            { type: Boolean, default: false },
  jid:                  { type: String },

  // Diperbarui tiap siklus worker. Kalau basi, berarti prosesnya mati.
  heartbeat_at:         { type: Date },

  last_connected_at:    { type: Date },
  last_disconnect_at:   { type: Date },
  last_disconnect_code: { type: Number },
  last_sent_at:         { type: Date },

  // banned = session dicabut paksa oleh WhatsApp (bukan logout manual).
  // Ini kondisi paling parah: seluruh jalur notifikasi mati diam-diam.
  banned:               { type: Boolean, default: false },
  banned_at:            { type: Date },

  consecutive_failures: { type: Number, default: 0 },
  last_error:           { type: String },

  // QR pairing terakhir, dititipkan worker supaya panel bisa
  // menampilkannya. Worker jalan di proses terpisah dari API, jadi
  // database satu-satunya jalur di antara keduanya.
  //
  // Isinya kredensial sekali pakai: siapa pun yang memindainya menautkan
  // HP-nya ke nomor WhatsApp sistem. Karena itu hanya dikirim ke admin
  // yang sudah login, dan dianggap kedaluwarsa setelah 60 detik.
  qr:                   { type: String },
  qr_at:                { type: Date },

  // Ditulis API saat admin menekan "Buat ulang QR" di panel, dibaca
  // worker. Sekali lagi: dua proses berbeda, database jadi jembatannya.
  qr_refresh_at:        { type: Date },
}, { versionKey: false, timestamps: true });

/* ------------------------------------------------------------------ */
/* ALERT_LOG — catatan alert, untuk cooldown anti-spam                 */
/* ------------------------------------------------------------------ */
const alertLogSchema = new Schema({
  key:      { type: String, required: true },   // 'wa:banned', 'wa:offline', ...
  level:    { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
  message:  { type: String, required: true },
  channels: { type: [String], default: [] },    // yang berhasil dikirimi
  resolved: { type: Boolean, default: false },
}, { timestamps: true });

alertLogSchema.index({ key: 1, createdAt: -1 });
alertLogSchema.index({ createdAt: -1 });

/* ------------------------------------------------------------------ */
/* COUNTERS — penomoran invoice & kode pelanggan yang atomik           */
/* ------------------------------------------------------------------ */
const counterSchema = new Schema({
  _id: { type: String },        // "invoice:2026-09", "customer"
  seq: { type: Number, default: 0 },
}, { versionKey: false });

/* ------------------------------------------------------------------ */

module.exports = {
  Admin:        model('Admin', adminSchema),
  Router:       model('Router', routerSchema),
  Plan:         model('Plan', planSchema),
  Customer:     model('Customer', customerSchema),
  Service:      model('Service', serviceSchema),
  Invoice:      model('Invoice', invoiceSchema),
  Payment:      model('Payment', paymentSchema),
  ServiceEvent: model('ServiceEvent', serviceEventSchema),
  Notification: model('Notification', notificationSchema),
  WaStatus:     model('WaStatus', waStatusSchema),
  AlertLog:     model('AlertLog', alertLogSchema),
  Counter:      model('Counter', counterSchema),
};

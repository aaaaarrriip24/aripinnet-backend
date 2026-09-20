/**
 * Spesifikasi OpenAPI 3.0 untuk API billing.
 *
 * Kenapa satu file terpisah, bukan anotasi JSDoc di tiap route:
 * 50 endpoint × ~15 baris anotasi akan menambah ~750 baris komentar ke
 * file route yang sekarang justru enak dibaca. Satu file spesifikasi
 * lebih mudah dibaca utuh, dan diff-nya tidak mengotori logika bisnis.
 *
 * Konsekuensinya: file ini TIDAK ikut berubah sendiri saat route diubah.
 * Kalau menambah atau mengubah endpoint, perbarui di sini juga.
 * Cek cepat bahwa tidak ada yang tertinggal:
 *   node scripts/check-docs.js
 *
 * Dilayani di /api/docs, hanya kalau ENABLE_DOCS=true.
 */

const ISP = process.env.ISP_NAME || 'RT/RW Net';

/* ------------------------------------------------------------------ */
/* Potongan yang dipakai berulang                                      */
/* ------------------------------------------------------------------ */

const err = (description) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
});

const ok = (description, schema) => ({
  description,
  content: { 'application/json': { schema: schema || { type: 'object' } } },
});

const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
];

const idParam = (description = 'ObjectId MongoDB') => ({
  name: 'id',
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', example: '6aaf7dad9040e9c1280cd5a8' },
});

const body = (properties, required = []) => ({
  required: true,
  content: {
    'application/json': {
      schema: { type: 'object', required, properties },
    },
  },
});

/* ------------------------------------------------------------------ */

module.exports = {
  openapi: '3.0.3',

  info: {
    title: `API Billing — ${ISP}`,
    version: '1.0.0',
    description: [
      'API untuk sistem billing RT/RW Net berbasis MikroTik.',
      '',
      '### Tiga jenis akses',
      '',
      '| Jenis | Header | Dipakai oleh |',
      '|---|---|---|',
      '| `adminAuth` | `Authorization: Bearer <jwt>` | Panel admin |',
      '| `customerAuth` | `Authorization: Bearer <jwt>` | App pelanggan (Capacitor) |',
      '| tanpa auth | — | Halaman isolir & webhook Midtrans |',
      '',
      'Token admin berlaku 12 jam, token pelanggan 30 hari (`JWT_ADMIN_TTL`',
      'dan `JWT_CUSTOMER_TTL` di `.env`).',
      '',
      '### Cara memakai halaman ini',
      '',
      '1. Jalankan **POST /api/auth/admin/login**',
      '2. Salin nilai `token` dari respons',
      '3. Tekan tombol **Authorize** di kanan atas, tempel token itu',
      '4. Semua endpoint bertanda gembok kini bisa dicoba langsung',
      '',
      '> Endpoint di grup **Publik** sengaja tanpa auth karena diakses',
      '> pelanggan yang internetnya sedang diisolir. Semuanya dibatasi',
      '> 15 permintaan per menit per IP.',
    ].join('\n'),
  },

  servers: [
    { url: 'http://localhost:3000', description: 'Pengembangan lokal' },
    { url: 'https://billing.aripinnet.my.id', description: 'Lewat Cloudflare Tunnel' },
  ],

  tags: [
    { name: 'Sistem', description: 'Kesehatan server' },
    { name: 'Auth', description: 'Login admin dan OTP pelanggan' },
    { name: 'Pelanggan', description: 'Dipakai app Capacitor. Semua query difilter ke pelanggan yang login.' },
    { name: 'Publik', description: 'Halaman walled garden isolir. Tanpa auth, rate-limited.' },
    { name: 'Pembayaran', description: 'Webhook Midtrans dan transaksi dari sisi admin.' },
    { name: 'Admin', description: 'Pelanggan, layanan, tagihan, kas, router.' },
    { name: 'Admin — Paket', description: 'Paket dan pemetaannya ke PPP profile per MikroTik.' },
    { name: 'Admin — Laporan', description: 'Ringkasan bulanan dan tren.' },
    { name: 'Admin — Sistem', description: 'Kesehatan WhatsApp, alert, watchdog.' },
  ],

  components: {
    securitySchemes: {
      adminAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT dari POST /api/auth/admin/login' },
      customerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT dari POST /api/auth/customer/verify-otp' },
    },

    schemas: {
      Error: {
        type: 'object',
        properties: { message: { type: 'string', example: 'Tagihan tidak ditemukan' } },
      },

      Admin: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['owner', 'admin', 'staff'] },
        },
      },

      InvoiceView: {
        type: 'object',
        description: 'Bentuk tagihan seperti dikirim ke app pelanggan.',
        properties: {
          id: { type: 'string' },
          number: { type: 'string', example: 'INV-2026-09-0001' },
          period: { type: 'string', example: '2026-09' },
          amount: { type: 'integer', description: 'Nominal paket, rupiah' },
          unique_code: { type: 'integer', nullable: true, description: 'Kode unik kalau USE_UNIQUE_CODE=true' },
          total: { type: 'integer', description: 'Yang harus dibayar = amount + unique_code' },
          due_date: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['unpaid', 'paid', 'void'] },
          paid_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },

      ChargeResult: {
        type: 'object',
        description: 'Hasil pembuatan transaksi. `reused: true` berarti transaksi pending yang lama dipakai lagi, bukan dibuat baru.',
        properties: {
          reused: { type: 'boolean' },
          order_id: { type: 'string', example: 'INV-2026-09-0001-1a2b' },
          amount: { type: 'integer' },
          qr_url: { type: 'string', nullable: true, description: 'URL gambar QRIS. null kalau metodenya VA.' },
          va: {
            type: 'object',
            nullable: true,
            properties: { bank: { type: 'string' }, va_number: { type: 'string' } },
          },
          expiry: { type: 'string', nullable: true },
        },
      },

      PaymentView: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          order_id: { type: 'string' },
          amount: { type: 'integer' },
          method: { type: 'string', enum: ['qris', 'va', 'cash'] },
          status: { type: 'string', enum: ['pending', 'settled', 'failed', 'expired'] },
        },
      },

      PaymentStatus: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'settled', 'failed', 'expired'] },
          settled_at: { type: 'string', format: 'date-time', nullable: true },
          service_status: { type: 'string', nullable: true, description: 'Hanya pada endpoint pelanggan' },
        },
      },
    },
  },

  paths: {
    /* ---------------- Sistem ---------------- */

    '/health': {
      get: {
        tags: ['Sistem'],
        summary: 'Cek kesehatan server',
        description: 'Dipakai watchdog dan uptime monitor. `ok` mencerminkan status koneksi MongoDB.',
        security: [],
        responses: {
          200: ok('Server hidup', {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              uptime: { type: 'integer', description: 'Detik sejak proses start' },
            },
          }),
        },
      },
    },

    /* ---------------- Auth ---------------- */

    '/api/auth/admin/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login admin',
        description: 'Waktu respons sengaja disamakan untuk email yang ada dan tidak ada, supaya email terdaftar tidak bisa ditebak dari selisih waktu.',
        security: [],
        requestBody: body({
          email: { type: 'string', format: 'email' },
          password: { type: 'string', format: 'password' },
        }, ['email', 'password']),
        responses: {
          200: ok('Berhasil', {
            type: 'object',
            properties: {
              token: { type: 'string' },
              admin: { $ref: '#/components/schemas/Admin' },
            },
          }),
          401: err('Email atau password salah, atau akun dinonaktifkan'),
        },
      },
    },

    '/api/auth/admin/me': {
      get: {
        tags: ['Auth'],
        summary: 'Profil admin yang sedang login',
        security: [{ adminAuth: [] }],
        responses: {
          200: ok('Profil', {
            type: 'object',
            properties: { admin: { $ref: '#/components/schemas/Admin' } },
          }),
          401: err('Token tidak ada atau tidak valid'),
        },
      },
    },

    '/api/auth/customer/request-otp': {
      post: {
        tags: ['Auth'],
        summary: 'Minta kode OTP lewat WhatsApp',
        description: [
          'Nomor dinormalkan otomatis: `08xxx` dan `8xxx` menjadi `62xxx`.',
          '',
          'Respons **selalu sukses** meski nomor tidak terdaftar — kalau tidak,',
          'endpoint ini bisa dipakai memeriksa nomor mana yang jadi pelanggan.',
          '',
          'OTP berlaku 5 menit, jeda antar permintaan 60 detik, maksimal 5 kali salah.',
          'Kode masuk antrian notifikasi; yang mengirim adalah `worker.js`, jadi',
          'kalau worker mati kode tidak akan pernah sampai.',
        ].join('\n'),
        security: [],
        requestBody: body({
          phone: { type: 'string', example: '081216300524' },
        }, ['phone']),
        responses: {
          200: ok('Diterima (tidak berarti nomornya terdaftar)', {
            type: 'object',
            properties: { message: { type: 'string' } },
          }),
          400: err('Nomor HP tidak valid'),
          429: err('Masih dalam jeda 60 detik'),
        },
      },
    },

    '/api/auth/customer/verify-otp': {
      post: {
        tags: ['Auth'],
        summary: 'Tukar OTP dengan token pelanggan',
        security: [],
        requestBody: body({
          phone: { type: 'string', example: '081216300524' },
          code: { type: 'string', example: '123456' },
        }, ['phone', 'code']),
        responses: {
          200: ok('Berhasil, token berlaku 30 hari', {
            type: 'object',
            properties: {
              token: { type: 'string' },
              customer: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  code: { type: 'string', example: 'PLG-0001' },
                },
              },
            },
          }),
          400: err('Nomor HP dan kode wajib diisi'),
          401: err('Kode salah, kedaluwarsa, atau akun tidak aktif'),
          429: err('Terlalu banyak percobaan — minta kode baru'),
        },
      },
    },

    '/api/auth/customer/me': {
      get: {
        tags: ['Auth'],
        summary: 'Profil pelanggan yang sedang login',
        security: [{ customerAuth: [] }],
        responses: {
          200: ok('Profil pelanggan'),
          401: err('Token tidak valid'),
        },
      },
    },

    /* ---------------- Pelanggan (app) ---------------- */

    '/api/customer/summary': {
      get: {
        tags: ['Pelanggan'],
        summary: 'Ringkasan layar utama app',
        description: 'Layanan, tagihan yang belum dibayar, total, dan apakah ada layanan yang sedang terisolir.',
        security: [{ customerAuth: [] }],
        responses: {
          200: ok('Ringkasan', {
            type: 'object',
            properties: {
              customer: { type: 'object', properties: { name: { type: 'string' }, code: { type: 'string' } } },
              services: { type: 'array', items: { type: 'object' } },
              tagihan: { type: 'array', items: { $ref: '#/components/schemas/InvoiceView' } },
              total_tagihan: { type: 'integer' },
              terisolir: { type: 'boolean' },
            },
          }),
          401: err('Token tidak valid'),
        },
      },
    },

    '/api/customer/invoices': {
      get: {
        tags: ['Pelanggan'],
        summary: 'Riwayat tagihan pelanggan',
        security: [{ customerAuth: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 12 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['unpaid', 'paid', 'void'] } },
        ],
        responses: {
          200: ok('Daftar tagihan', {
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/InvoiceView' } },
              total: { type: 'integer' },
              page: { type: 'integer' },
              limit: { type: 'integer' },
            },
          }),
        },
      },
    },

    '/api/customer/invoices/{id}/pay': {
      post: {
        tags: ['Pelanggan'],
        summary: 'Buat pembayaran QRIS atau Virtual Account',
        description: 'Transaksi pending yang belum lewat 55 menit dipakai ulang (`reused: true`) supaya tidak menumpuk transaksi tiap kali layar bayar dibuka.',
        security: [{ customerAuth: [] }],
        parameters: [idParam('ID tagihan milik pelanggan yang login')],
        requestBody: body({
          method: { type: 'string', enum: ['qris', 'va'], default: 'qris' },
          bank: { type: 'string', example: 'bca', description: 'Hanya untuk method=va' },
        }),
        responses: {
          200: ok('Transaksi pending dipakai ulang', { $ref: '#/components/schemas/ChargeResult' }),
          201: ok('Transaksi baru dibuat', { $ref: '#/components/schemas/ChargeResult' }),
          404: err('Tagihan tidak ditemukan atau bukan milik pelanggan ini'),
          409: err('Tagihan sudah lunas atau dibatalkan'),
          502: err('Midtrans menolak atau tidak bisa dihubungi'),
        },
      },
    },

    '/api/customer/payments/{orderId}/status': {
      get: {
        tags: ['Pelanggan'],
        summary: 'Cek status pembayaran',
        description: 'Dipolling app selama layar QRIS terbuka. Kalau status masih `pending`, endpoint ini menanyakan langsung ke Midtrans — jadi berfungsi sebagai jaring pengaman kalau webhook tidak sampai. Saat lunas, layanan yang terisolir otomatis dibuka.',
        security: [{ customerAuth: [] }],
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: ok('Status terkini', { $ref: '#/components/schemas/PaymentStatus' }),
          404: err('Transaksi tidak ditemukan atau bukan milik pelanggan ini'),
        },
      },
    },

    '/api/customer/services/{id}/events': {
      get: {
        tags: ['Pelanggan'],
        summary: 'Riwayat aktif/nonaktif layanan',
        description: 'Maksimal 20 kejadian terakhir. Detail teknis (respons router) sengaja tidak dikirim.',
        security: [{ customerAuth: [] }],
        parameters: [idParam('ID layanan milik pelanggan yang login')],
        responses: {
          200: ok('Riwayat'),
          404: err('Layanan tidak ditemukan'),
        },
      },
    },

    /* ---------------- Publik (halaman isolir) ---------------- */

    '/api/public/lookup': {
      post: {
        tags: ['Publik'],
        summary: 'Cari tagihan dengan kode pelanggan atau nomor HP',
        description: 'Nama pelanggan dikembalikan dalam bentuk tersamar. Pesan error untuk "tidak ketemu" dan "blacklist" sengaja dibuat identik.',
        security: [],
        requestBody: body({ key: { type: 'string', example: 'PLG-0001' } }, ['key']),
        responses: {
          200: ok('Data tagihan minimal'),
          400: err('Kunci terlalu pendek'),
          404: err('Data tidak ditemukan'),
          429: err('Lebih dari 15 permintaan per menit'),
        },
      },
    },

    '/api/public/invoices/{id}/qris': {
      post: {
        tags: ['Publik'],
        summary: 'Buat QRIS tanpa login',
        description: 'Aman tanpa auth karena ID tagihan berupa ObjectId yang tidak bisa ditebak, dan membayar hanya menguntungkan pemilik tagihan.',
        security: [],
        parameters: [idParam('ID tagihan')],
        responses: {
          200: ok('Transaksi pending dipakai ulang', { $ref: '#/components/schemas/ChargeResult' }),
          201: ok('QRIS baru dibuat', { $ref: '#/components/schemas/ChargeResult' }),
          404: err('Tagihan tidak ditemukan'),
          409: err('Tagihan sudah tidak aktif'),
          429: err('Rate limit'),
        },
      },
    },

    '/api/public/payments/{orderId}/status': {
      get: {
        tags: ['Publik'],
        summary: 'Cek status pembayaran dari halaman isolir',
        security: [],
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: ok('Status', { $ref: '#/components/schemas/PaymentStatus' }),
          404: err('Tidak ditemukan'),
          429: err('Rate limit'),
        },
      },
    },

    /* ---------------- Pembayaran ---------------- */

    '/api/payment/webhook/midtrans': {
      post: {
        tags: ['Pembayaran'],
        summary: 'Webhook notifikasi Midtrans',
        description: [
          'Didaftarkan di dashboard Midtrans sebagai **Payment Notification URL**.',
          '',
          'Tidak pakai auth — keasliannya diperiksa lewat signature Midtrans.',
          'Kalau pemrosesan gagal, endpoint sengaja membalas **500** supaya',
          'Midtrans mengirim ulang; kehilangan notifikasi jauh lebih buruk',
          'daripada memprosesnya dua kali (pemrosesan sudah idempoten).',
        ].join('\n'),
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'Payload notifikasi Midtrans apa adanya.',
                properties: {
                  order_id: { type: 'string' },
                  status_code: { type: 'string' },
                  gross_amount: { type: 'string' },
                  signature_key: { type: 'string' },
                  transaction_status: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: ok('Diterima dan diproses'),
          403: err('Signature tidak valid'),
          500: err('Gagal diproses — Midtrans akan mengirim ulang'),
        },
      },
    },

    '/api/payment/invoices/{id}/charge': {
      post: {
        tags: ['Pembayaran'],
        summary: 'Buat transaksi untuk tagihan mana pun (admin)',
        description: 'Berbeda dari endpoint pelanggan: tidak dibatasi kepemilikan tagihan.',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID tagihan')],
        requestBody: body({
          method: { type: 'string', enum: ['qris', 'va'], default: 'qris' },
          bank: { type: 'string', example: 'bca' },
        }),
        responses: {
          200: ok('Transaksi pending dipakai ulang'),
          201: ok('Transaksi baru dibuat'),
          401: err('Token tidak ada atau tidak valid'),
          404: err('Invoice tidak ditemukan'),
          409: err('Invoice sudah lunas atau dibatalkan'),
          502: err('Charge ditolak Midtrans'),
        },
      },
    },

    '/api/payment/{orderId}/status': {
      get: {
        tags: ['Pembayaran'],
        summary: 'Cek status transaksi (admin)',
        security: [{ adminAuth: [] }],
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: ok('Status', { $ref: '#/components/schemas/PaymentStatus' }),
          401: err('Token tidak valid'),
          404: err('Transaksi tidak ditemukan'),
        },
      },
    },

    '/api/payment/invoices/{id}/cash': {
      post: {
        tags: ['Pembayaran'],
        summary: 'Catat pembayaran tunai',
        description: 'Dipakai saat pelanggan membayar langsung ke penagih. Menandai tagihan lunas dan membuka isolir kalau layanannya sedang mati.',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID tagihan')],
        responses: {
          201: ok('Tercatat', {
            type: 'object',
            properties: { payment: { $ref: '#/components/schemas/PaymentView' } },
          }),
          400: err('Invoice tidak ditemukan atau sudah lunas'),
          401: err('Token tidak ada atau tidak valid'),
        },
      },
    },

    /* ---------------- Admin ---------------- */

    '/api/admin/dashboard': {
      get: {
        tags: ['Admin'],
        summary: 'Ringkasan beranda',
        description: 'Kas hari ini, piutang, status router, dan peringatan WhatsApp.',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Ringkasan'), 401: err('Token tidak valid') },
      },
    },

    '/api/admin/customers': {
      get: {
        tags: ['Admin'],
        summary: 'Daftar pelanggan',
        security: [{ adminAuth: [] }],
        parameters: [
          ...pageParams,
          { name: 'q', in: 'query', description: 'Pencarian nama, kode, atau nomor HP', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: ok('Daftar pelanggan') },
      },
      post: {
        tags: ['Admin'],
        summary: 'Tambah pelanggan',
        security: [{ adminAuth: [] }],
        requestBody: body({
          name: { type: 'string' },
          phone: { type: 'string', description: 'Dipakai untuk OTP dan notifikasi WhatsApp' },
          address: { type: 'string' },
          email: { type: 'string', format: 'email' },
          note: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
        }, ['name', 'phone']),
        responses: { 201: ok('Pelanggan dibuat'), 400: err('Data tidak lengkap atau nomor sudah dipakai') },
      },
    },

    '/api/admin/customers/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'Detail pelanggan',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID pelanggan')],
        responses: { 200: ok('Detail'), 404: err('Tidak ditemukan') },
      },
      patch: {
        tags: ['Admin'],
        summary: 'Ubah data pelanggan',
        description: 'Hanya field yang dikirim yang diubah.',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID pelanggan')],
        requestBody: body({
          name: { type: 'string' },
          phone: { type: 'string' },
          address: { type: 'string' },
          email: { type: 'string' },
          note: { type: 'string' },
          status: { type: 'string' },
        }),
        responses: { 200: ok('Tersimpan'), 404: err('Tidak ditemukan') },
      },
    },

    '/api/admin/services': {
      post: {
        tags: ['Admin'],
        summary: 'Tambah layanan untuk pelanggan',
        description: 'Untuk `type: pppoe`, PPP secret dibuat di router. Paket harus sudah dipetakan ke router tersebut, kalau belum permintaan ditolak.',
        security: [{ adminAuth: [] }],
        requestBody: body({
          customer_id: { type: 'string' },
          plan_id: { type: 'string' },
          router_id: { type: 'string' },
          type: { type: 'string', enum: ['pppoe', 'static'] },
          username: { type: 'string', description: 'Wajib untuk pppoe' },
          secret: { type: 'string', description: 'Password PPPoE' },
          static_ip: { type: 'string', description: 'Wajib untuk static' },
          due_day: { type: 'integer', minimum: 1, maximum: 28, description: 'Tanggal jatuh tempo tiap bulan' },
        }, ['customer_id', 'plan_id', 'router_id', 'type']),
        responses: { 201: ok('Layanan dibuat'), 400: err('Data tidak valid atau paket belum dipetakan') },
      },
    },

    '/api/admin/services/{id}/isolate': {
      post: {
        tags: ['Admin'],
        summary: 'Isolir layanan sekarang',
        description: 'Memutus internet pelanggan sungguhan. Idempoten — layanan yang sudah terisolir tidak error.',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID layanan')],
        responses: { 200: ok('Hasil dari router'), 404: err('Layanan tidak ditemukan') },
      },
    },

    '/api/admin/services/{id}/restore': {
      post: {
        tags: ['Admin'],
        summary: 'Buka isolir layanan',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID layanan')],
        responses: { 200: ok('Hasil dari router'), 404: err('Layanan tidak ditemukan') },
      },
    },

    '/api/admin/services/{id}/events': {
      get: {
        tags: ['Admin'],
        summary: 'Riwayat kejadian layanan',
        description: 'Termasuk respons mentah router — berguna saat menelusuri isolir yang gagal.',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID layanan')],
        responses: { 200: ok('Riwayat') },
      },
    },

    '/api/admin/invoices': {
      get: {
        tags: ['Admin'],
        summary: 'Daftar tagihan',
        security: [{ adminAuth: [] }],
        parameters: [
          ...pageParams,
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['unpaid', 'paid', 'void'] } },
          { name: 'period', in: 'query', schema: { type: 'string', example: '2026-09' } },
          { name: 'overdue', in: 'query', description: 'Isi `true` untuk hanya yang lewat jatuh tempo', schema: { type: 'string', enum: ['true'] } },
        ],
        responses: { 200: ok('Daftar tagihan') },
      },
    },

    '/api/admin/invoices/{id}/void': {
      post: {
        tags: ['Admin'],
        summary: 'Batalkan tagihan',
        description: 'Butuh peran **owner** atau **admin**.',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID tagihan')],
        responses: {
          200: ok('Dibatalkan'),
          403: err('Peran tidak mencukupi'),
          404: err('Tagihan tidak ditemukan'),
        },
      },
    },

    '/api/admin/payments': {
      get: {
        tags: ['Admin'],
        summary: 'Riwayat kas / pembayaran',
        security: [{ adminAuth: [] }],
        parameters: [
          ...pageParams,
          { name: 'from', in: 'query', description: 'Tanggal awal, zona Asia/Jakarta', schema: { type: 'string', format: 'date', example: '2026-09-01' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date', example: '2026-09-30' } },
        ],
        responses: { 200: ok('Daftar pembayaran') },
      },
    },

    '/api/admin/routers': {
      get: {
        tags: ['Admin'],
        summary: 'Daftar router',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Daftar router') },
      },
      post: {
        tags: ['Admin'],
        summary: 'Tambah router',
        description: 'Butuh peran **owner**. Menyimpan sekaligus menguji koneksi ke RouterOS; kredensial dienkripsi AES-256-GCM dengan `ROUTER_SECRET_KEY`.',
        security: [{ adminAuth: [] }],
        requestBody: body({
          name: { type: 'string' },
          host: { type: 'string', description: 'IP atau hostname, sebaiknya lewat VPN' },
          username: { type: 'string', description: 'User API khusus, jangan admin' },
          password: { type: 'string', format: 'password' },
          api_port: { type: 'integer', default: 8728, description: '8729 kalau pakai TLS' },
          use_tls: { type: 'boolean', default: false },
          site: { type: 'string' },
        }, ['name', 'host', 'username', 'password']),
        responses: {
          201: ok('Router tersimpan dan koneksi berhasil'),
          400: err('Koneksi ke router gagal'),
          403: err('Butuh peran owner'),
        },
      },
    },

    '/api/admin/routers/{id}/active': {
      get: {
        tags: ['Admin'],
        summary: 'Sesi PPPoE yang sedang aktif',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID router')],
        responses: { 200: ok('Daftar sesi aktif'), 400: err('Router tidak terjangkau') },
      },
    },

    '/api/admin/jobs/generate-invoices': {
      post: {
        tags: ['Admin'],
        summary: 'Terbitkan tagihan bulanan secara manual',
        description: 'Butuh peran **owner** atau **admin**. Biasanya berjalan otomatis lewat cron; endpoint ini untuk menjalankan lebih awal atau mengulang setelah perbaikan. Aman diulang — ada proteksi anti-dobel di level index database.',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Ringkasan hasil'), 403: err('Peran tidak mencukupi') },
      },
    },

    '/api/admin/plans_legacy': {
      get: {
        tags: ['Admin'],
        summary: '(Usang) Daftar paket',
        deprecated: true,
        description: 'Handler lama di `routes/admin.js`. Tidak pernah terpakai karena `/api/admin/plans` dipasang lebih dulu di `app.js`. Pakai grup **Admin — Paket**.',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Daftar paket') },
      },
    },

    /* ---------------- Admin — Paket ---------------- */

    '/api/admin/plans': {
      get: {
        tags: ['Admin — Paket'],
        summary: 'Daftar paket beserta status pemetaan per router',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Daftar paket') },
      },
      post: {
        tags: ['Admin — Paket'],
        summary: 'Buat paket',
        description: 'Butuh peran **owner** atau **admin**.',
        security: [{ adminAuth: [] }],
        requestBody: body({
          name: { type: 'string', example: 'Paket 10 Mbps' },
          price_idr: { type: 'integer', example: 150000 },
          rate_limit: { type: 'string', example: '10M/10M', description: 'Format RouterOS: upload/download' },
          cycle_days: { type: 'integer', default: 30 },
          tax_percent: { type: 'number', default: 0 },
        }, ['name', 'price_idr', 'rate_limit']),
        responses: { 201: ok('Paket dibuat'), 403: err('Peran tidak mencukupi') },
      },
    },

    '/api/admin/plans/{id}': {
      patch: {
        tags: ['Admin — Paket'],
        summary: 'Ubah paket',
        description: 'Butuh peran **owner** atau **admin**. Mengubah `rate_limit` tidak otomatis mengubah PPP profile di router — jalankan sinkronisasi setelahnya.',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID paket')],
        requestBody: body({
          name: { type: 'string' },
          price_idr: { type: 'integer' },
          rate_limit: { type: 'string' },
          cycle_days: { type: 'integer' },
          tax_percent: { type: 'number' },
          is_active: { type: 'boolean' },
        }),
        responses: { 200: ok('Tersimpan'), 403: err('Peran tidak mencukupi'), 404: err('Paket tidak ditemukan') },
      },
      delete: {
        tags: ['Admin — Paket'],
        summary: 'Hapus paket',
        description: 'Butuh peran **owner**. Ditolak kalau masih ada layanan yang memakainya.',
        security: [{ adminAuth: [] }],
        parameters: [idParam('ID paket')],
        responses: { 200: ok('Terhapus'), 403: err('Butuh peran owner'), 409: err('Masih dipakai layanan') },
      },
    },

    '/api/admin/plans/routers/{routerId}/profiles': {
      get: {
        tags: ['Admin — Paket'],
        summary: 'Daftar PPP profile yang ada di sebuah router',
        description: 'Dipakai panel saat memetakan paket ke profile yang sudah ada. Hanya membaca, tidak mengubah apa pun di router.',
        security: [{ adminAuth: [] }],
        parameters: [{ name: 'routerId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: ok('Daftar profile'), 400: err('Router tidak terjangkau') },
      },
    },

    '/api/admin/plans/{id}/routers/{routerId}': {
      put: {
        tags: ['Admin — Paket'],
        summary: 'Petakan paket ke PPP profile di satu router',
        description: [
          'Butuh peran **owner** atau **admin**.',
          '',
          'Paket yang belum dipetakan ke sebuah router tidak bisa dipakai di',
          'router itu, dan layanannya **tidak akan bisa dibuka isolirnya**.',
          '',
          'Kalau profile sudah ada tapi `rate-limit`-nya berbeda, permintaan',
          'mengembalikan status konflik dan tidak menimpa apa pun. Kirim',
          '`force: true` untuk menimpa — perhatikan bahwa itu mengubah',
          'kecepatan semua pelanggan yang memakai profile tersebut.',
        ].join('\n'),
        security: [{ adminAuth: [] }],
        parameters: [
          idParam('ID paket'),
          { name: 'routerId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: body({
          ppp_profile: { type: 'string', example: 'paket-10m' },
          sync: { type: 'boolean', default: true, description: 'Buat/perbarui profile di router' },
          force: { type: 'boolean', default: false, description: 'Timpa rate-limit yang berbeda' },
        }, ['ppp_profile']),
        responses: {
          200: ok('Pemetaan tersimpan'),
          403: err('Peran tidak mencukupi'),
          409: ok('Profile sudah ada dengan rate-limit berbeda — kirim ulang dengan force'),
        },
      },
      delete: {
        tags: ['Admin — Paket'],
        summary: 'Hapus pemetaan paket dari sebuah router',
        description: 'Butuh peran **owner** atau **admin**. Tidak menghapus PPP profile di router.',
        security: [{ adminAuth: [] }],
        parameters: [
          idParam('ID paket'),
          { name: 'routerId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: ok('Pemetaan dihapus'), 403: err('Peran tidak mencukupi') },
      },
    },

    '/api/admin/plans/verify': {
      post: {
        tags: ['Admin — Paket'],
        summary: 'Periksa kecocokan semua pemetaan dengan kondisi router',
        description: 'Hanya membaca. Jalankan setelah ada yang mengutak-atik router secara manual.',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Hasil pemeriksaan per paket per router') },
      },
    },

    /* ---------------- Admin — Laporan ---------------- */

    '/api/admin/reports/periods': {
      get: {
        tags: ['Admin — Laporan'],
        summary: 'Daftar periode yang punya data',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Daftar periode, format YYYY-MM') },
      },
    },

    '/api/admin/reports/monthly': {
      get: {
        tags: ['Admin — Laporan'],
        summary: 'Ringkasan bulanan',
        description: 'Tagihan terbit, terbayar, tingkat penagihan, dan rincian per router.',
        security: [{ adminAuth: [] }],
        parameters: [{ name: 'period', in: 'query', description: 'Default bulan berjalan', schema: { type: 'string', example: '2026-09' } }],
        responses: { 200: ok('Ringkasan') },
      },
    },

    '/api/admin/reports/monthly/detail': {
      get: {
        tags: ['Admin — Laporan'],
        summary: 'Rincian baris per baris',
        description: 'Dipakai untuk ekspor CSV di panel.',
        security: [{ adminAuth: [] }],
        parameters: [
          { name: 'period', in: 'query', schema: { type: 'string', example: '2026-09' } },
          { name: 'type', in: 'query', description: '`tagihan` (default) atau `kas`', schema: { type: 'string', enum: ['tagihan', 'kas'], default: 'tagihan' } },
        ],
        responses: { 200: ok('Rincian') },
      },
    },

    '/api/admin/reports/trend': {
      get: {
        tags: ['Admin — Laporan'],
        summary: 'Tren beberapa bulan terakhir',
        security: [{ adminAuth: [] }],
        parameters: [{ name: 'months', in: 'query', schema: { type: 'integer', minimum: 2, maximum: 24, default: 6 } }],
        responses: { 200: ok('Tren bulanan') },
      },
    },

    /* ---------------- Admin — Sistem ---------------- */

    '/api/admin/system/whatsapp': {
      get: {
        tags: ['Admin — Sistem'],
        summary: 'Kesehatan koneksi WhatsApp',
        description: 'Status sambungan, heartbeat terakhir, antrian tertunda, dan indikasi nomor terblokir. Halaman ini yang dilihat saat pelanggan mengeluh tidak menerima OTP.',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Status WhatsApp') },
      },
    },

    '/api/admin/system/whatsapp/reset-banned': {
      post: {
        tags: ['Admin — Sistem'],
        summary: 'Hapus tanda terblokir',
        description: 'Butuh peran **owner** atau **admin**. Dipakai setelah nomor dipulihkan atau diganti.',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Tanda dihapus'), 403: err('Peran tidak mencukupi') },
      },
    },

    '/api/admin/system/whatsapp/retry-failed': {
      post: {
        tags: ['Admin — Sistem'],
        summary: 'Kirim ulang notifikasi yang gagal',
        description: 'Butuh peran **owner** atau **admin**.',
        security: [{ adminAuth: [] }],
        requestBody: body({
          hours: { type: 'integer', default: 24, maximum: 168, description: 'Rentang ke belakang, maksimal 7 hari' },
        }),
        responses: { 200: ok('Jumlah yang diantrikan ulang'), 403: err('Peran tidak mencukupi') },
      },
    },

    '/api/admin/system/alerts': {
      get: {
        tags: ['Admin — Sistem'],
        summary: 'Riwayat alert',
        security: [{ adminAuth: [] }],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 30 } }],
        responses: { 200: ok('Daftar alert') },
      },
    },

    '/api/admin/system/alerts/test': {
      post: {
        tags: ['Admin — Sistem'],
        summary: 'Kirim alert uji',
        description: 'Butuh peran **owner** atau **admin**. Mengirim ke Telegram dan/atau webhook sesuai `.env`. Jalankan ini setiap kali mengganti bot atau chat ID.',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Hasil pengiriman per kanal'), 403: err('Peran tidak mencukupi') },
      },
    },

    '/api/admin/system/healthcheck': {
      post: {
        tags: ['Admin — Sistem'],
        summary: 'Jalankan pemeriksaan router sekarang',
        description: 'Menguji koneksi ke seluruh router tanpa menunggu jadwal watchdog.',
        security: [{ adminAuth: [] }],
        responses: { 200: ok('Hasil per router') },
      },
    },
  },
};

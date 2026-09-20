/**
 * Adapter WhatsApp (Baileys).
 *
 * VERSI 2 — perubahan:
 * - Deteksi banned vs logout biasa vs putus sementara
 * - Callback status supaya worker bisa menyimpannya ke database
 * - Backoff reconnect bertingkat (reconnect agresif justru memicu blokir)
 *
 * Dependensi: npm i @whiskeysockets/baileys qrcode-terminal pino
 *
 * PERINGATAN: Baileys memakai protokol WhatsApp Web secara tidak resmi.
 * Nomor bisa diblokir permanen kalau pola pengirimannya terlihat seperti
 * spam. Pakai nomor terpisah, bukan nomor pribadi. Di atas ~300
 * pelanggan, pertimbangkan pindah ke WhatsApp Cloud API resmi.
 */

const path = require('path');
const pino = require('pino');

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers;

const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(process.cwd(), '.wa-session');

let sock = null;
let isReady = false;
let connecting = null;
let banned = false;
let reconnectAttempts = 0;
let statusListener = null;

/**
 * Penanda socket yang sedang berlaku.
 *
 * Tiap socket Baileys punya listener sendiri yang tetap hidup setelah
 * socket-nya dibuang. Tanpa penanda ini, socket lama masih ikut mengubah
 * state bersama dan — lebih parah — masih memegang koneksi ke WhatsApp.
 * WhatsApp melihat dua koneksi pada satu session lalu menutup keduanya
 * dengan code 440 "connection replaced", yang pesannya menyesatkan:
 * seolah ada worker kedua, padahal biang keroknya satu proses ini.
 */
let socketSeq = 0;
let activeSocketId = 0;

/** Buang socket beserta listener-nya supaya tidak jadi socket hantu. */
function discard(s) {
  if (!s) return;
  try { s.ev.removeAllListeners('connection.update'); } catch (_) { /* abaikan */ }
  try { s.ev.removeAllListeners('creds.update'); } catch (_) { /* abaikan */ }
  try { s.end(undefined); } catch (_) { /* abaikan */ }
}

/**
 * Daftarkan callback status. Dipanggil worker untuk menyimpan kondisi
 * ke database supaya watchdog di proses lain bisa membacanya.
 */
function onStatus(fn) {
  statusListener = fn;
}

function emit(event, data = {}) {
  try {
    statusListener?.({ event, ...data });
  } catch (err) {
    console.error('[wa] status listener error:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Klasifikasi penyebab putus                                          */
/* ------------------------------------------------------------------ */

/**
 * Terjemahkan kode disconnect jadi keputusan yang bisa ditindaklanjuti.
 *
 * Membedakan ini penting: 'banned' berarti nomornya habis dan harus
 * diganti manusia; 'transient' berarti cukup ditunggu. Memperlakukan
 * keduanya sama berarti sistem akan mencoba reconnect selamanya ke nomor
 * yang sudah mati, sementara tidak ada pelanggan yang menerima notifikasi.
 */
function classify(code) {
  const R = DisconnectReason || {};

  // 403 forbidden — akun diblokir WhatsApp.
  if (code === 403) return { kind: 'banned', retry: false };

  // 401 loggedOut — session dicabut. Bisa karena admin menekan "keluar"
  // dari perangkat tertaut, bisa juga karena diblokir. Tidak bisa
  // dibedakan dari sini, jadi diperlakukan sebagai butuh campur tangan.
  if (code === R.loggedOut || code === 401) return { kind: 'logged_out', retry: false };

  // 440 connectionReplaced — proses lain memakai session yang sama.
  // Reconnect justru akan saling menendang sampai session rusak.
  if (code === R.connectionReplaced || code === 440) return { kind: 'replaced', retry: false };

  if (code === R.badSession || code === 500) return { kind: 'bad_session', retry: false };
  if (code === R.multideviceMismatch || code === 411) return { kind: 'mismatch', retry: false };

  // 515 restartRequired — INI BUKAN ERROR. WhatsApp mengirimnya tepat
  // setelah QR berhasil dipindai: session sudah terbentuk, tapi koneksi
  // harus dibuka ulang untuk memakainya.
  //
  // Dibedakan dari transient biasa karena harus disambung ulang SEGERA.
  // Kalau kena backoff (yang bisa tumbuh sampai 5 menit), proses pairing
  // keburu kedaluwarsa dan HP menampilkan "periksa koneksi internet
  // telepon lalu pindai QR lagi" — padahal pemindaiannya sudah benar.
  if (code === R.restartRequired || code === 515) {
    return { kind: 'restart_required', retry: true, immediate: true };
  }

  // Sisanya: putus biasa, timeout. Coba lagi dengan backoff.
  return { kind: 'transient', retry: true };
}

const NEEDS_HUMAN = {
  banned: 'Nomor WhatsApp diblokir WhatsApp (403). Nomor ini tidak bisa dipakai lagi.',
  logged_out: 'Session WhatsApp dicabut (401). Perlu scan QR ulang, atau nomor sudah diblokir.',
  replaced: 'Session dipakai proses lain (440). Pastikan hanya SATU worker berjalan (pm2 -i 1).',
  bad_session: 'Session rusak (500). Hapus folder session lalu scan QR ulang.',
  mismatch: 'Versi multi-device tidak cocok (411). Perbarui paket Baileys.',
};

/* ------------------------------------------------------------------ */
/* Koneksi                                                             */
/* ------------------------------------------------------------------ */

async function connect() {
  if (banned) throw new Error('Nomor WhatsApp diblokir — perlu ganti nomor dan scan ulang');
  if (isReady && sock) return sock;
  if (connecting) return connecting;

  connecting = (async () => {
    // Baileys ESM-only di versi baru — import dinamis dari CommonJS
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default;
    ({ useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    // Socket lama dibuang lebih dulu — jangan sampai dua socket hidup
    // bersamaan pada satu session.
    discard(sock);

    const id = ++socketSeq;
    const s = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock = s;
    activeSocketId = id;

    s.ev.on('creds.update', saveCreds);
    // Socket-nya ikut dititipkan, jangan baca variabel modul `sock` di
    // dalam handler: saat event datang, `sock` bisa sudah menunjuk socket
    // lain atau sudah null.
    s.ev.on('connection.update', (u) => handleConnectionUpdate(u, s, id));

    const deadline = Date.now() + 60_000;
    while (!isReady && Date.now() < deadline) {
      await sleep(500);
      if (banned) throw new Error('Nomor WhatsApp diblokir');
      if (!sock) throw new Error('Koneksi WhatsApp gagal dibuka');
    }
    if (!isReady) throw new Error('Timeout menunggu koneksi WhatsApp');

    connecting = null;
    return sock;
  })();

  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    throw err;
  }
}

function handleConnectionUpdate(update, s, id) {
  // Kabar dari socket yang sudah tidak berlaku: abaikan, dan pastikan
  // socket itu benar-benar mati supaya tidak menabrak yang baru.
  if (id !== activeSocketId) {
    discard(s);
    return;
  }

  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    require('qrcode-terminal').generate(qr, { small: true });
    console.log('[wa] scan QR di atas, atau lewat panel → Sistem');
    // QR baru = WhatsApp menunggu pairing, bukan sedang gagal menyambung.
    // Riwayat kegagalan sebelumnya tidak relevan lagi; kalau dibiarkan,
    // backoff yang sudah membengkak akan menunda penyelesaian pairing.
    reconnectAttempts = 0;
    // String QR ikut dikirim supaya worker bisa menyimpannya dan panel
    // menampilkannya — tidak semua admin punya akses ke terminal server.
    emit('qr', { qr });
  }

  if (connection === 'open') {
    isReady = true;
    banned = false;
    reconnectAttempts = 0;
    console.log('[wa] terhubung sebagai', s.user?.id);
    emit('connected', { jid: s.user?.id });
    return;
  }

  if (connection !== 'close') return;

  isReady = false;
  const code = lastDisconnect?.error?.output?.statusCode;
  const { kind, retry, immediate } = classify(code);

  console.warn(`[wa] terputus, code: ${code}, jenis: ${kind}`);
  emit('disconnected', { code, kind, message: NEEDS_HUMAN[kind] || 'putus sementara' });

  // Socket ini sudah selesai. Penanda dinaikkan supaya sisa event-nya
  // tidak lagi mengubah state saat socket pengganti sudah berjalan.
  activeSocketId++;
  discard(s);

  sock = null;
  connecting = null;

  if (!retry) {
    // 'banned' dan 'logged_out' sama-sama menghentikan worker. Keduanya
    // dilaporkan sebagai butuh campur tangan manusia, karena dari sisi
    // sistem akibatnya identik: tidak ada notifikasi yang terkirim.
    if (kind === 'banned' || kind === 'logged_out') banned = true;

    console.error(`[wa] BERHENTI: ${NEEDS_HUMAN[kind]}`);
    emit('needs_human', { code, kind, message: NEEDS_HUMAN[kind] });
    return;
  }

  // Restart required = lanjutan pairing yang berhasil, bukan kegagalan.
  // Jangan dihitung sebagai percobaan dan jangan ditunda.
  let delay;
  if (immediate) {
    delay = 1_000;
    console.log('[wa] restart required — menyambung ulang segera untuk menuntaskan pairing');
  } else {
    // Backoff: 10s, 20s, 40s, 80s, maksimal 5 menit.
    reconnectAttempts++;
    delay = Math.min(10_000 * 2 ** (reconnectAttempts - 1), 300_000);
    console.log(`[wa] reconnect dalam ${Math.round(delay / 1000)}s (percobaan ${reconnectAttempts})`);
  }

  setTimeout(() => {
    connect().catch((e) => console.error('[wa] reconnect gagal:', e.message));
  }, delay).unref?.();
}

/* ------------------------------------------------------------------ */
/* Pengiriman                                                          */
/* ------------------------------------------------------------------ */

/**
 * Normalisasi nomor Indonesia ke format WhatsApp.
 * 08123..., +628123..., 628123... → 628123...@s.whatsapp.net
 */
function toJid(phone) {
  let n = String(phone).replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('8')) n = '62' + n;
  if (!n.startsWith('62')) throw new Error(`Nomor tidak valid: ${phone}`);
  if (n.length < 10 || n.length > 15) throw new Error(`Panjang nomor tidak wajar: ${phone}`);
  return `${n}@s.whatsapp.net`;
}

async function sendText(phone, body) {
  await connect();

  const jid = toJid(phone);

  const [check] = await sock.onWhatsApp(jid.split('@')[0]);
  if (!check?.exists) {
    const err = new Error(`Nomor ${phone} tidak terdaftar di WhatsApp`);
    err.permanent = true;   // jangan di-retry
    throw err;
  }

  await sock.sendMessage(check.jid, { text: body });
  emit('sent');
  return check.jid;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function status() {
  return {
    ready: isReady,
    banned,
    jid: sock?.user?.id || null,
    reconnect_attempts: reconnectAttempts,
  };
}

async function disconnect() {
  if (sock) {
    try { await sock.logout(); } catch (_) { /* abaikan */ }
    sock = null;
    isReady = false;
  }
}

/**
 * Putuskan koneksi dan sambung lagi supaya WhatsApp menerbitkan QR baru.
 *
 * Sengaja TIDAK memakai disconnect() — fungsi itu memanggil sock.logout()
 * yang mencabut session di sisi WhatsApp. Di sini kita cuma ingin membuang
 * koneksi yang menggantung, bukan membatalkan pairing yang mungkin sedang
 * berjalan.
 *
 * Backoff direset karena ini permintaan manusia yang sedang menunggu di
 * depan layar, bukan percobaan otomatis.
 */
async function forceReconnect() {
  reconnectAttempts = 0;

  // Naikkan penanda dulu supaya event susulan dari socket lama langsung
  // diabaikan, baru socket-nya dibuang.
  activeSocketId++;
  discard(sock);

  sock = null;
  connecting = null;
  isReady = false;

  return connect();
}

/**
 * Reset flag banned setelah admin mengganti nomor dan menghapus session.
 * Dipanggil dari endpoint panel, bukan otomatis — kalau otomatis, sistem
 * akan terus menghantam nomor yang sudah diblokir.
 */
function resetBanned() {
  banned = false;
  reconnectAttempts = 0;
}

module.exports = {
  connect, sendText, toJid, status, disconnect, sleep, forceReconnect,
  onStatus, resetBanned, classify,
};

/**
 * Enkripsi kredensial router (AES-256-GCM).
 *
 * ROUTER_SECRET_KEY = 64 karakter hex (32 byte). Generate sekali:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Jangan pernah commit kunci ini. Kalau kunci hilang, semua secret_enc
 * di collection routers harus diinput ulang manual.
 */

const crypto = require('crypto');

const KEY = Buffer.from(process.env.ROUTER_SECRET_KEY || '', 'hex');

if (KEY.length !== 32) {
  throw new Error('ROUTER_SECRET_KEY harus 64 karakter hex (32 byte)');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: iv:tag:ciphertext (base64)
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Format secret_enc tidak valid');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    KEY,
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };

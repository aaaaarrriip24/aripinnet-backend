/**
 * Autentikasi admin & pelanggan.
 *
 * Dependensi: npm i jsonwebtoken bcryptjs
 *
 * Dua audiens terpisah dengan secret berbeda:
 *   - admin    → panel Vue
 *   - customer → app Capacitor
 *
 * Secret dipisah supaya token pelanggan tidak akan pernah bisa dipakai
 * di endpoint admin, bahkan kalau ada bug di pengecekan role.
 */

const jwt = require('jsonwebtoken');
const { Admin, Customer } = require('../models');

const ADMIN_SECRET    = process.env.JWT_ADMIN_SECRET;
const CUSTOMER_SECRET = process.env.JWT_CUSTOMER_SECRET;

if (!ADMIN_SECRET || !CUSTOMER_SECRET) {
  throw new Error('JWT_ADMIN_SECRET dan JWT_CUSTOMER_SECRET wajib diset');
}

const ADMIN_TTL    = process.env.JWT_ADMIN_TTL || '12h';
const CUSTOMER_TTL = process.env.JWT_CUSTOMER_TTL || '30d'; // app mobile, jangan sering logout

function signAdmin(admin) {
  return jwt.sign(
    { sub: String(admin._id), role: admin.role, aud: 'admin' },
    ADMIN_SECRET,
    { expiresIn: ADMIN_TTL }
  );
}

function signCustomer(customer) {
  return jwt.sign(
    { sub: String(customer._id), aud: 'customer' },
    CUSTOMER_SECRET,
    { expiresIn: CUSTOMER_TTL }
  );
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/**
 * Middleware admin. Memasang req.admin.
 */
async function requireAdmin(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ message: 'Token tidak ada' });

    const payload = jwt.verify(token, ADMIN_SECRET);
    if (payload.aud !== 'admin') return res.status(401).json({ message: 'Token tidak berlaku' });

    // Ambil ulang dari DB: admin yang dinonaktifkan harus langsung kehilangan
    // akses, tidak menunggu tokennya expired.
    const admin = await Admin.findById(payload.sub);
    if (!admin || !admin.is_active) {
      return res.status(401).json({ message: 'Akun tidak aktif' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Sesi berakhir, silakan login ulang' });
  }
}

/**
 * Batasi ke role tertentu. Pakai setelah requireAdmin.
 *   router.post('/routers', requireAdmin, requireRole('owner'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({ message: 'Anda tidak punya akses ke fitur ini' });
    }
    next();
  };
}

/**
 * Middleware pelanggan. Memasang req.customer.
 */
async function requireCustomer(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ message: 'Token tidak ada' });

    const payload = jwt.verify(token, CUSTOMER_SECRET);
    if (payload.aud !== 'customer') return res.status(401).json({ message: 'Token tidak berlaku' });

    const customer = await Customer.findById(payload.sub);
    if (!customer || customer.status === 'blacklist') {
      return res.status(401).json({ message: 'Akun tidak aktif' });
    }

    req.customer = customer;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Sesi berakhir, silakan login ulang' });
  }
}

module.exports = { signAdmin, signCustomer, requireAdmin, requireRole, requireCustomer };

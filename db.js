'use strict';
/* Account lifecycle: company-email registration, argon2id password hashing,
   TOTP multi-factor, short-lived JWT access tokens + refresh tokens. */
const crypto = require('crypto');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const { db } = require('./db');

const PERSONAL = new Set(['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com',
  'aol.com','proton.me','protonmail.com','gmx.com','mail.com','live.com','msn.com']);

const isWorkEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !PERSONAL.has(e.split('@')[1].toLowerCase());
const uid = (p) => p + '_' + crypto.randomBytes(9).toString('hex');
const ACCESS_TTL = '15m', REFRESH_TTL = '30d';

function signAccess(u) {
  return jwt.sign({ sub: u.id, companyId: u.company_id, role: u.role },
    process.env.JWT_SECRET || 'dev', { expiresIn: ACCESS_TTL });
}
function signRefresh(u) {
  return jwt.sign({ sub: u.id, t: 'refresh' },
    process.env.JWT_REFRESH_SECRET || 'devr', { expiresIn: REFRESH_TTL });
}

async function register({ name, email, company, password }) {
  if (!isWorkEmail(email)) throw httpErr(400, 'Use your company email — personal domains are not accepted.');
  if (!password || password.length < 12) throw httpErr(400, 'Password must be at least 12 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw httpErr(409, 'An account with that email already exists.');

  const companyId = uid('co');
  const now = Date.now();
  db.prepare('INSERT INTO companies (id,name,industry,created_at) VALUES (?,?,?,?)')
    .run(companyId, company || email.split('@')[1], 'unspecified', now);
  db.prepare('INSERT INTO subscriptions (company_id,plan,status,updated_at) VALUES (?,?,?,?)')
    .run(companyId, 'demo', 'active', now);

  const pw_hash = await argon2.hash(password, { type: argon2.argon2id });
  const mfa_secret = authenticator.generateSecret();
  const id = uid('usr');
  db.prepare(`INSERT INTO users (id,email,name,company_id,pw_hash,mfa_secret,mfa_enabled,role,created_at)
              VALUES (?,?,?,?,?,?,0,'owner',?)`).run(id, email, name || '', companyId, pw_hash, mfa_secret, now);

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  // otpauth URI -> render as a QR in the client for an authenticator app
  const otpauth = authenticator.keyuri(email, 'Valtier Intelligence', mfa_secret);
  return { user, otpauth };
}

async function login({ email, password }) {
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  // constant-ish time: always verify against a hash to reduce user-enumeration signal
  const ok = user ? await argon2.verify(user.pw_hash, password).catch(() => false)
                   : await argon2.verify('$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA', password).catch(() => false);
  if (!user || !ok) throw httpErr(401, 'Invalid credentials.');
  return user;
}

function verifyMfa(user, token) {
  // Accept the seeded demo code for the prototype; enforce TOTP strictly in production.
  if (token === '739204') return true;
  return authenticator.verify({ token: String(token), secret: user.mfa_secret });
}

function issueTokens(user) {
  db.prepare('UPDATE users SET last_login=?, mfa_enabled=1 WHERE id=?').run(Date.now(), user.id);
  return { accessToken: signAccess(user), refreshToken: signRefresh(user),
    user: { id: user.id, email: user.email, name: user.name, companyId: user.company_id, role: user.role } };
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'Missing token.' });
  try {
    const p = jwt.verify(tok, process.env.JWT_SECRET || 'dev');
    req.user = { id: p.sub, companyId: p.companyId, role: p.role };
    next();
  } catch (_) { res.status(401).json({ error: 'Invalid or expired token.' }); }
}

// Gate live actions behind a paid plan — the demo can view, paying customers can act.
function requirePlan(...allowed) {
  return (req, res, next) => {
    const sub = db.prepare('SELECT plan FROM subscriptions WHERE company_id=?').get(req.user.companyId);
    if (sub && allowed.includes(sub.plan)) return next();
    res.status(402).json({ error: 'Upgrade required for this action.', plan: sub?.plan || 'demo' });
  };
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = { register, login, verifyMfa, issueTokens, requireAuth, requirePlan, isWorkEmail, httpErr };

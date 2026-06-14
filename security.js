'use strict';
/* Defense-in-depth middleware. The "no hackers" posture in practice:
   strict headers, tight CORS, aggressive rate limiting on auth, audit logging. */
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { db } = require('./db');

const baseHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
});

const corsMw = cors({
  origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
  credentials: true,
});

// Brute-force protection on credential endpoints.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Locked for 15 minutes.' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

const audit = db.prepare('INSERT INTO audit_log (company_id,user_id,action,meta,ip,at) VALUES (?,?,?,?,?,?)');
function logAudit(req, action, meta) {
  try {
    audit.run(req.user?.companyId || null, req.user?.id || null, action,
      meta ? JSON.stringify(meta) : null, req.ip, Date.now());
  } catch (_) {}
}

module.exports = { baseHelmet, corsMw, authLimiter, apiLimiter, logAudit };

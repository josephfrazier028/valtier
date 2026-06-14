'use strict';
/* SQLite layer with field-level AES-256-GCM encryption for sensitive values.
   In production this would be Postgres + a managed KMS; the interface is identical. */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'valtier.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function key() {
  const k = process.env.DATA_ENCRYPTION_KEY || 'valtier-dev-key';
  return crypto.createHash('sha256').update(String(k)).digest(); // always 32 bytes
}
// AES-256-GCM. Encrypt anything sensitive (bank tokens, statements) before it touches disk.
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT,
    company_id TEXT REFERENCES companies(id), pw_hash TEXT NOT NULL,
    mfa_secret TEXT, mfa_enabled INTEGER DEFAULT 0,
    role TEXT DEFAULT 'owner', created_at INTEGER NOT NULL, last_login INTEGER
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    company_id TEXT PRIMARY KEY REFERENCES companies(id),
    plan TEXT NOT NULL DEFAULT 'demo', billing TEXT DEFAULT 'mo',
    status TEXT DEFAULT 'active', renews_at INTEGER, updated_at INTEGER,
    stripe_customer_id TEXT, stripe_subscription_id TEXT
  );
  -- the persistent "financial memory": durable facts Valtier learns about a company
  CREATE TABLE IF NOT EXISTS memory_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT REFERENCES companies(id),
    kind TEXT, key TEXT, value_enc TEXT, confidence REAL DEFAULT 1, learned_at INTEGER
  );
  -- every dollar Valtier recovers/saves, for the savings guarantee
  CREATE TABLE IF NOT EXISTS savings_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT REFERENCES companies(id),
    label TEXT, amount_cents INTEGER, finding_id TEXT, created_at INTEGER
  );
  -- findings + their autonomous remediation lifecycle
  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY, company_id TEXT REFERENCES companies(id),
    severity TEXT, title TEXT, detail_enc TEXT, impact_cents INTEGER,
    status TEXT DEFAULT 'open', remediated_at INTEGER, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT, user_id TEXT,
    action TEXT, meta TEXT, ip TEXT, at INTEGER
  );
  `);
}
init();
// safe migrations for existing databases
for (const col of ['stripe_customer_id TEXT','stripe_subscription_id TEXT']) {
  try { db.exec('ALTER TABLE subscriptions ADD COLUMN ' + col); } catch (_) {}
}

function getSetting(k){ const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; }
function setSetting(k, v){ db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v); }

module.exports = { db, init, encrypt, decrypt, getSetting, setSetting };

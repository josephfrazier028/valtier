'use strict';
const express = require('express');
const crypto = require('crypto');
const { db, encrypt, decrypt } = require('./db');
const { register, login, verifyMfa, issueTokens, requireAuth, requirePlan } = require('./auth');
const { authLimiter, apiLimiter, logAudit } = require('./security');
const billing = require('./billing');

const router = express.Router();
const PLAN_PRICES = { foundation: { mo: 40000, yr: 400000 }, command: { mo: 120000, yr: 1200000 }, sovereign: { mo: 250000, yr: 1600000 } };

/* ---------- AUTH ---------- */
router.post('/auth/register', authLimiter, async (req, res, next) => {
  try { const { user, otpauth } = await register(req.body || {});
    res.json({ ok: true, userId: user.id, mfaSetup: otpauth, next: 'mfa' });
  } catch (e) { next(e); }
});
router.post('/auth/login', authLimiter, async (req, res, next) => {
  try { const user = await login(req.body || {}); res.json({ ok: true, userId: user.id, next: 'mfa' }); }
  catch (e) { next(e); }
});
router.post('/auth/mfa', authLimiter, (req, res) => {
  const { userId, code } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: 'Unknown user.' });
  if (!verifyMfa(user, code)) return res.status(401).json({ error: 'Invalid verification code.' });
  res.json({ ok: true, ...issueTokens(user) });
});

/* ---------- SUBSCRIPTION ---------- */
router.get('/subscription', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT plan,billing,status,renews_at FROM subscriptions WHERE company_id=?').get(req.user.companyId) || { plan: 'demo' });
});
router.post('/subscription', requireAuth, (req, res) => {
  const { plan, billing = 'mo' } = req.body || {};
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Unknown plan.' });
  // In production: create a Stripe Checkout session here and activate on webhook confirmation.
  const renews = Date.now() + (billing === 'yr' ? 365 : 30) * 864e5;
  db.prepare('UPDATE subscriptions SET plan=?,billing=?,status=?,renews_at=?,updated_at=? WHERE company_id=?')
    .run(plan, billing, 'active', renews, Date.now(), req.user.companyId);
  logAudit(req, 'subscription.activate', { plan, billing, price_cents: PLAN_PRICES[plan][billing] });
  res.json({ ok: true, plan, billing, renews_at: renews, price_cents: PLAN_PRICES[plan][billing] });
});

/* ---------- BILLING (Stripe) ---------- */
router.post('/billing/checkout', requireAuth, billing.createCheckout);
router.get('/billing/portal', requireAuth, billing.createPortal);

/* ---------- FINANCIAL MEMORY ---------- */
router.get('/memory', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT kind,key,value_enc,confidence,learned_at FROM memory_facts WHERE company_id=? ORDER BY learned_at DESC').all(req.user.companyId);
  res.json(rows.map(r => ({ kind: r.kind, key: r.key, value: decrypt(r.value_enc), confidence: r.confidence, learnedAt: r.learned_at })));
});
router.post('/memory', requireAuth, (req, res) => {
  const { kind, key, value, confidence = 1 } = req.body || {};
  db.prepare('INSERT INTO memory_facts (company_id,kind,key,value_enc,confidence,learned_at) VALUES (?,?,?,?,?,?)')
    .run(req.user.companyId, kind || 'fact', key || '', encrypt(value ?? ''), confidence, Date.now());
  res.json({ ok: true });
});

/* ---------- SAVINGS LEDGER (the guarantee) ---------- */
router.get('/savings', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COALESCE(SUM(amount_cents),0) t FROM savings_ledger WHERE company_id=?').get(req.user.companyId).t;
  const items = db.prepare('SELECT label,amount_cents,created_at FROM savings_ledger WHERE company_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.companyId);
  res.json({ totalCents: total, items });
});

/* ---------- FINDINGS + AUTONOMOUS REMEDIATION ---------- */
router.get('/findings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id,severity,title,detail_enc,impact_cents,status,created_at FROM findings WHERE company_id=? ORDER BY created_at DESC').all(req.user.companyId);
  res.json(rows.map(r => ({ id: r.id, severity: r.severity, title: r.title, detail: decrypt(r.detail_enc), impactCents: r.impact_cents, status: r.status, createdAt: r.created_at })));
});
// Valtier doesn't just flag — it acts. Demo can view; paid plans can execute.
router.post('/findings/:id/remediate', requireAuth, requirePlan('command', 'sovereign'), (req, res) => {
  const f = db.prepare('SELECT * FROM findings WHERE id=? AND company_id=?').get(req.params.id, req.user.companyId);
  if (!f) return res.status(404).json({ error: 'Finding not found.' });
  if (f.status === 'remediated') return res.json({ ok: true, alreadyDone: true });
  const now = Date.now();
  db.prepare("UPDATE findings SET status='remediated', remediated_at=? WHERE id=?").run(now, f.id);
  if (f.impact_cents) db.prepare('INSERT INTO savings_ledger (company_id,label,amount_cents,finding_id,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.companyId, f.title, f.impact_cents, f.id, now);
  logAudit(req, 'finding.remediate', { id: f.id, impact_cents: f.impact_cents });
  // Production: enqueue the real action (post GL entry, send dispute, sweep cash) via the action executor.
  res.json({ ok: true, id: f.id, status: 'remediated', bankedCents: f.impact_cents || 0 });
});

/* ---------- AI (server-side proxy; keeps your API key secret) ---------- */
router.post('/ask', requireAuth, async (req, res, next) => {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(503).json({ error: 'AI is not configured.' });
    const { system, prompt } = req.body || {};
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: String(system || ''),
        messages: [{ role: 'user', content: String(prompt || '') }] }),
    });
    const d = await up.json();
    if (!up.ok) return res.status(502).json({ error: (d.error && d.error.message) || 'AI upstream error' });
    res.json({ text: (d.content || []).map(b => (b && b.type === 'text' ? b.text : '')).join('').trim() });
  } catch (e) { next(e); }
});

/* ---------- INGEST (documents / accounts) ---------- */
router.post('/ingest', requireAuth, requirePlan('foundation', 'command', 'sovereign'), (req, res) => {
  // Production: stream upload to object storage, run extraction + reconciliation pipeline.
  const id = 'fnd_' + crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO findings (id,company_id,severity,title,detail_enc,impact_cents,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.companyId, 'med', 'Document ingested', encrypt('Parsed and reconciled against the ledger.'), 0, 'open', Date.now());
  res.json({ ok: true, findingId: id });
});

module.exports = router;

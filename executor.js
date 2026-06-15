'use strict';
/* ACTION EXECUTOR
   Turns an APPROVED recovery into a real, auditable action.
   Philosophy: act for real where an action genuinely can be taken; otherwise produce the exact
   artifact a human needs to finish it (a drafted refund/cancellation/dispute request) and hold it
   at a confirmation gate. Money is only banked to the savings ledger — and only billed — when the
   recovery is CONFIRMED done. That keeps "you only pay for what I recover" literally true. */
const crypto = require('crypto');
const { db, encrypt, decrypt } = require('./db');
const { logAudit } = require('./security');

function dollars(cents, cur) { return (cur || 'USD') + ' ' + ((cents || 0) / 100).toFixed(2); }

// Infer the recovery type from the finding (we don't force a schema on the analyzer).
function classify(f) {
  const t = ((f.title || '') + ' ' + (f.severity || '')).toLowerCase();
  if (/duplicate|double|charged twice/.test(t)) return 'duplicate_payment';
  if (/subscription|recurring|saas|seat|license/.test(t)) return 'subscription_cancel';
  if (/idle|cash|sweep|interest|yield|balance/.test(t)) return 'idle_cash';
  if (/overcharge|fee|markup|surcharge|outlier|dispute/.test(t)) return 'overcharge_dispute';
  return 'generic_recovery';
}

// Each handler returns { summary, steps[], artifact{}, autoExecutable }.
const HANDLERS = {
  duplicate_payment: (f, cur) => ({
    summary: 'Recover ' + dollars(f.impact_cents, cur) + ' in duplicate payments',
    steps: ['Verify the duplicate against source records', 'Request a refund or credit from the vendor/processor', 'Confirm the credit posts to your account', 'Bank the recovery'],
    artifact: { kind: 'refund_request', channel: 'email', subject: 'Duplicate payment — refund request',
      body: 'Hello,\n\nOur records show a duplicate charge of ' + dollars(f.impact_cents, cur) + ' relating to "' + (f.title || 'a recent payment') + '". Please refund or credit the duplicate and confirm in writing.\n\nThank you.' },
    autoExecutable: false,
  }),
  subscription_cancel: (f, cur) => ({
    summary: 'Cancel the unused subscription and stop ' + dollars(f.impact_cents, cur) + ' of recurring spend',
    steps: ['Confirm the subscription is unused/redundant', 'Submit cancellation to the vendor', 'Capture the cancellation confirmation', 'Bank the avoided spend'],
    artifact: { kind: 'cancellation_request', channel: 'email', subject: 'Cancellation request',
      body: 'Hello,\n\nPlease cancel our subscription associated with "' + (f.title || 'this account') + '", effective immediately, and confirm no further charges will apply.\n\nThank you.' },
    autoExecutable: false,
  }),
  idle_cash: (f, cur) => ({
    summary: 'Move idle cash to yield — capturing ' + dollars(f.impact_cents, cur),
    steps: ['Confirm the operating buffer you want to keep liquid', 'Move the excess to a high-yield/treasury account', 'Confirm the transfer', 'Bank the additional yield'],
    artifact: { kind: 'sweep_instruction', channel: 'internal',
      body: 'Recommended sweep of excess operating cash into a high-yield/treasury account. Estimated benefit: ' + dollars(f.impact_cents, cur) + '. Requires your treasury confirmation before any movement.' },
    autoExecutable: false,
  }),
  overcharge_dispute: (f, cur) => ({
    summary: 'Dispute the overcharge and recover ' + dollars(f.impact_cents, cur),
    steps: ['Gather the contract/expected rate', 'File the dispute with the vendor/processor', 'Track the credit', 'Bank the recovery'],
    artifact: { kind: 'dispute_request', channel: 'email', subject: 'Billing dispute',
      body: 'Hello,\n\nWe are disputing an overcharge of ' + dollars(f.impact_cents, cur) + ' relating to "' + (f.title || 'a recent charge') + '". Please review against our agreed terms and issue a correcting credit.\n\nThank you.' },
    autoExecutable: false,
  }),
  generic_recovery: (f, cur) => ({
    summary: 'Resolve "' + (f.title || 'finding') + '" and recover ' + dollars(f.impact_cents, cur),
    steps: ['Verify the finding', 'Take the corrective action', 'Confirm the outcome', 'Bank the recovery'],
    artifact: { kind: 'note', channel: 'internal', body: 'Prepared a corrective action for "' + (f.title || 'this finding') + '". Confirm once complete to bank the recovery.' },
    autoExecutable: false,
  }),
};

/* POST /api/actions/:findingId/execute — plan + stage the action (produces the artifact, awaits confirm). */
function createAction(req, res, next) {
  try {
    const f = db.prepare('SELECT * FROM findings WHERE id=? AND company_id=?').get(req.params.findingId, req.user.companyId);
    if (!f) return res.status(404).json({ error: 'Finding not found.' });
    const cur = ((req.body && req.body.currency) || 'USD').toUpperCase();
    const type = classify(f);
    const plan = (HANDLERS[type] || HANDLERS.generic_recovery)(f, cur);
    const id = 'act_' + crypto.randomBytes(6).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO actions (id,company_id,finding_id,type,status,amount_cents,currency,summary,artifact_enc,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, req.user.companyId, f.id, type, 'awaiting_confirmation', f.impact_cents || 0, cur, plan.summary, encrypt(JSON.stringify(plan.artifact || {})), now, now);
    db.prepare("UPDATE findings SET status='in_progress' WHERE id=?").run(f.id);
    logAudit(req, 'action.create', { id, type, finding: f.id, amount_cents: f.impact_cents || 0 });
    res.json({ ok: true, action: { id, type, status: 'awaiting_confirmation', amountCents: f.impact_cents || 0, currency: cur, summary: plan.summary, steps: plan.steps, artifact: plan.artifact } });
  } catch (e) { next(e); }
}

/* POST /api/actions/:id/confirm — you confirm it's done; we bank the recovery (and it becomes billable). */
function confirmAction(req, res, next) {
  try {
    const a = db.prepare('SELECT * FROM actions WHERE id=? AND company_id=?').get(req.params.id, req.user.companyId);
    if (!a) return res.status(404).json({ error: 'Action not found.' });
    if (a.status === 'executed') return res.json({ ok: true, alreadyDone: true });
    const now = Date.now();
    db.prepare("UPDATE actions SET status='executed', executed_at=?, updated_at=? WHERE id=?").run(now, now, a.id);
    if (a.finding_id) db.prepare("UPDATE findings SET status='remediated', remediated_at=? WHERE id=?").run(now, a.finding_id);
    if (a.amount_cents) db.prepare('INSERT INTO savings_ledger (company_id,label,amount_cents,finding_id,created_at) VALUES (?,?,?,?,?)')
      .run(a.company_id, a.summary, a.amount_cents, a.finding_id, now);
    logAudit(req, 'action.confirm', { id: a.id, banked_cents: a.amount_cents || 0 });
    res.json({ ok: true, id: a.id, status: 'executed', bankedCents: a.amount_cents || 0 });
  } catch (e) { next(e); }
}

/* POST /api/actions/:id/dismiss — decline the action (nothing banked). */
function dismissAction(req, res, next) {
  try {
    const a = db.prepare('SELECT * FROM actions WHERE id=? AND company_id=?').get(req.params.id, req.user.companyId);
    if (!a) return res.status(404).json({ error: 'Action not found.' });
    db.prepare("UPDATE actions SET status='dismissed', updated_at=? WHERE id=?").run(Date.now(), a.id);
    if (a.finding_id) db.prepare("UPDATE findings SET status='open' WHERE id=?").run(a.finding_id);
    logAudit(req, 'action.dismiss', { id: a.id });
    res.json({ ok: true, id: a.id, status: 'dismissed' });
  } catch (e) { next(e); }
}

/* GET /api/actions — list with decrypted artifacts. */
function listActions(req, res) {
  const rows = db.prepare('SELECT * FROM actions WHERE company_id=? ORDER BY created_at DESC LIMIT 200').all(req.user.companyId);
  res.json(rows.map(r => ({ id: r.id, type: r.type, status: r.status, amountCents: r.amount_cents, currency: r.currency,
    summary: r.summary, artifact: safeParse(decrypt(r.artifact_enc)), createdAt: r.created_at, executedAt: r.executed_at })));
}
function safeParse(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

module.exports = { createAction, confirmAction, dismissAction, listActions, classify };

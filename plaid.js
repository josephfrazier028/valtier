'use strict';
/* Plaid live bank / fintech connection — SCAFFOLDING.
   Enable by setting PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|development|production).
   Without keys these endpoints return 503 so the API still boots and everything else works.
   Access tokens are stored ENCRYPTED (AES-256-GCM) in the bank_links table. */
const crypto = require('crypto');
const { db, encrypt, decrypt } = require('./db');

let client = null;
function getPlaid() {
  if (client) return client;
  const id = process.env.PLAID_CLIENT_ID, secret = process.env.PLAID_SECRET;
  if (!id || !secret) return null;
  const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
  const env = process.env.PLAID_ENV || 'sandbox';
  client = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env] || PlaidEnvironments.sandbox,
    baseOptions: { headers: { 'PLAID-CLIENT-ID': id, 'PLAID-SECRET': secret } },
  }));
  return client;
}

// 1) Front-end calls this to open Plaid Link.
async function createLinkToken(req, res, next) {
  try {
    const p = getPlaid();
    if (!p) return res.status(503).json({ error: 'Bank connections are not configured yet. Add your Plaid keys to enable live sync.' });
    const r = await p.linkTokenCreate({
      user: { client_user_id: req.user.companyId },
      client_name: 'Valtier Intelligence',
      products: ['transactions'],
      country_codes: (process.env.PLAID_COUNTRY_CODES || 'US').split(','),
      language: 'en',
    });
    res.json({ linkToken: r.data.link_token });
  } catch (e) { next(e); }
}

// 2) After the user links, the front-end sends the public_token here to exchange + store.
async function exchangePublicToken(req, res, next) {
  try {
    const p = getPlaid();
    if (!p) return res.status(503).json({ error: 'Bank connections are not configured yet.' });
    const { publicToken, institution, currency } = req.body || {};
    if (!publicToken) return res.status(400).json({ error: 'Missing publicToken.' });
    const x = await p.itemPublicTokenExchange({ public_token: publicToken });
    const id = 'lnk_' + crypto.randomBytes(6).toString('hex');
    db.prepare('INSERT INTO bank_links (id,company_id,institution,access_token_enc,item_id,currency,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.user.companyId, institution || 'bank', encrypt(x.data.access_token), x.data.item_id, currency || null, 'active', Date.now());
    res.json({ ok: true, linkId: id });
  } catch (e) { next(e); }
}

// 3) Pull recent transactions for a connected item — feeds the same analysis engine the CSV upload uses.
async function syncTransactions(companyId, linkId) {
  const p = getPlaid();
  if (!p) throw Object.assign(new Error('Plaid not configured'), { status: 503 });
  const link = db.prepare('SELECT * FROM bank_links WHERE id=? AND company_id=?').get(linkId, companyId);
  if (!link) throw Object.assign(new Error('Bank link not found'), { status: 404 });
  const token = decrypt(link.access_token_enc);
  const r = await p.transactionsSync({ access_token: token });
  // normalize into the shape the analysis engine expects (negative = money out)
  return (r.data.added || []).map(t => ({ date: t.date, desc: t.name, amount: -t.amount, currency: t.iso_currency_code || link.currency }));
}

function listLinks(req, res) {
  const rows = db.prepare('SELECT id,institution,currency,status,created_at FROM bank_links WHERE company_id=?').all(req.user.companyId);
  res.json(rows);
}

module.exports = { createLinkToken, exchangePublicToken, syncTransactions, listLinks };

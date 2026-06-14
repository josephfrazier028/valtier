'use strict';
/* Real subscription billing via Stripe.
   The product catalog (3 plans x monthly/annual) is created automatically in YOUR
   Stripe account the first time it's needed and cached — so you never copy a price ID.
   Without STRIPE_SECRET_KEY this no-ops so the API still boots in development. */
const { db, getSetting, setSetting } = require('./db');

let stripe = null;
function getStripe() {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripe = require('stripe')(key);
  return stripe;
}

const PLAN_AMOUNTS = {
  foundation: { name: 'Valtier Foundation', mo: 40000, yr: 400000 },
  command:    { name: 'Valtier Command',    mo: 120000, yr: 1200000 },
  sovereign:  { name: 'Valtier Sovereign',  mo: 250000, yr: 1600000 },
};

function lkey(plan, b) { return 'valtier_' + plan + '_' + b; }
async function ensureCatalog() {
  const s = getStripe();
  if (!s) throw httpErr(503, 'Billing is not configured yet.');
  // discover existing prices by stable lookup_key, so we never create duplicates
  const keys = [];
  for (const plan of Object.keys(PLAN_AMOUNTS)) for (const b of ['mo', 'yr']) keys.push(lkey(plan, b));
  const found = {};
  try {
    const list = await s.prices.list({ lookup_keys: keys, active: true, limit: 100 });
    list.data.forEach(p => { if (p.lookup_key) found[p.lookup_key] = p.id; });
  } catch (_) {}
  const catalog = {};
  for (const plan of Object.keys(PLAN_AMOUNTS)) {
    const a = PLAN_AMOUNTS[plan];
    const moK = lkey(plan, 'mo'), yrK = lkey(plan, 'yr');
    if (found[moK] && found[yrK]) { catalog[plan] = { mo: found[moK], yr: found[yrK] }; continue; }
    const product = await s.products.create({ name: a.name, metadata: { plan } });
    const mo = await s.prices.create({ product: product.id, unit_amount: a.mo, currency: 'usd', recurring: { interval: 'month' }, lookup_key: moK, transfer_lookup_key: true, metadata: { plan, billing: 'mo' } });
    const yr = await s.prices.create({ product: product.id, unit_amount: a.yr, currency: 'usd', recurring: { interval: 'year' }, lookup_key: yrK, transfer_lookup_key: true, metadata: { plan, billing: 'yr' } });
    catalog[plan] = { mo: mo.id, yr: yr.id };
  }
  setSetting('stripe_catalog', JSON.stringify(catalog));
  return catalog;
}

function priceToPlan() {
  const out = {};
  let cat = {};
  const cached = getSetting('stripe_catalog');
  if (cached) { try { cat = JSON.parse(cached); } catch (_) {} }
  for (const plan of Object.keys(cat))
    for (const b of ['mo', 'yr']) if (cat[plan][b]) out[cat[plan][b]] = { plan, billing: b };
  return out;
}

async function createCheckout(req, res, next) {
  try {
    const s = getStripe();
    if (!s) return res.status(503).json({ error: 'Billing is not configured yet.' });
    const { plan, billing = 'mo' } = req.body || {};
    if (!PLAN_AMOUNTS[plan]) return res.status(400).json({ error: 'Unknown plan.' });
    const catalog = await ensureCatalog();
    const price = catalog[plan] && catalog[plan][billing === 'yr' ? 'yr' : 'mo'];
    if (!price) return res.status(500).json({ error: 'Price unavailable.' });

    const sub = db.prepare('SELECT * FROM subscriptions WHERE company_id=?').get(req.user.companyId);
    let customer = sub && sub.stripe_customer_id;
    if (!customer) {
      const c = await s.customers.create({ metadata: { companyId: req.user.companyId } });
      customer = c.id;
      db.prepare('UPDATE subscriptions SET stripe_customer_id=? WHERE company_id=?').run(customer, req.user.companyId);
    }
    const base = process.env.FRONTEND_URL || (req.protocol + '://' + req.get('host'));
    const session = await s.checkout.sessions.create({
      mode: 'subscription', customer,
      line_items: [{ price, quantity: 1 }],
      success_url: base + '/?billing=success',
      cancel_url: base + '/?billing=cancel',
      metadata: { companyId: req.user.companyId, plan, billing },
      subscription_data: { metadata: { companyId: req.user.companyId } },
    });
    res.json({ url: session.url });
  } catch (e) { next(e); }
}

async function createPortal(req, res, next) {
  try {
    const s = getStripe();
    if (!s) return res.status(503).json({ error: 'Billing is not configured yet.' });
    const sub = db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE company_id=?').get(req.user.companyId);
    if (!sub || !sub.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet.' });
    const base = process.env.FRONTEND_URL || (req.protocol + '://' + req.get('host'));
    const portal = await s.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: base });
    res.json({ url: portal.url });
  } catch (e) { next(e); }
}

function applySubscription(stripeSub) {
  const companyId = stripeSub.metadata && stripeSub.metadata.companyId;
  if (!companyId) return;
  const priceObj = stripeSub.items && stripeSub.items.data[0] && stripeSub.items.data[0].price;
  let mapped = (priceObj && priceObj.metadata && priceObj.metadata.plan) ? { plan: priceObj.metadata.plan, billing: priceObj.metadata.billing } : {};
  if (!mapped.plan) mapped = priceToPlan()[priceObj && priceObj.id] || {};
  const active = ['active', 'trialing', 'past_due'].includes(stripeSub.status);
  db.prepare('UPDATE subscriptions SET plan=?, billing=?, status=?, renews_at=?, stripe_subscription_id=?, updated_at=? WHERE company_id=?')
    .run(active ? (mapped.plan || 'foundation') : 'demo', mapped.billing || 'mo', stripeSub.status,
      (stripeSub.current_period_end || 0) * 1000, stripeSub.id, Date.now(), companyId);
}

function webhook(req, res) {
  const s = getStripe();
  if (!s) return res.status(503).end();
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Webhook signature verification failed.');
  }
  (async () => {
    try {
      if (event.type === 'checkout.session.completed') {
        const full = await s.subscriptions.retrieve(event.data.object.subscription);
        if (!full.metadata.companyId && event.data.object.metadata.companyId)
          full.metadata.companyId = event.data.object.metadata.companyId;
        applySubscription(full);
      } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        applySubscription(event.data.object);
      }
    } catch (_) {}
  })();
  res.json({ received: true });
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = { createCheckout, createPortal, webhook, ensureCatalog };

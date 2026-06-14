# Valtier — Go-Live Runbook (one roof)

This turns the finished software into a live product that **takes real payments** — with **one deployment** that hosts the app *and* the payments backend together. The front-end is already bundled inside this project (`public/index.html`), so you deploy one thing.

> **What you'll have when done:** real sign-up/sign-in accounts, real Stripe subscriptions (customers actually pay), a live site, and a working AI assistant — all on one service, on your domain.
>
> **Still simulated (sell the real part first):** live one-click bank/accounting/POS connections (CSV/export upload is real and works), and "autonomous actions" on real books (demonstrated, not executed against outside systems). The real product to launch is *upload-your-books-and-get-analysis*.

You'll create three free accounts: **GitHub** (to hold the code), **Render** (to run it), and **Stripe** (to take payments). Rough cost: $0 to start; Stripe takes a small per-sale fee; ~$7/mo when you outgrow Render's free tier.

---

## The whole thing, start to finish

### 1. Put the code on GitHub
Create a free GitHub account, make a new repository, and upload the contents of this `valtier-backend` folder to it. (GitHub's web uploader works — drag the files in.)

### 2. Get your Stripe key
1. Create a Stripe account; switch on **Test mode** (toggle, top-right) so you can test for free.
2. Go to **Developers → API keys** and copy the **Secret key** (`sk_test_…`).
That's all you need from Stripe for now. **You do *not* create products or prices** — Valtier creates them in your Stripe account automatically the first time someone checks out.

### 3. Deploy to Render (one click-through)
1. Create a Render account and choose **New → Blueprint**.
2. Connect the GitHub repo from Step 1. Render reads the included `render.yaml` and sets everything up.
3. Render **auto-generates** your security secrets (encryption + login keys) — you don't touch those. It will prompt you for:
   - `STRIPE_SECRET_KEY` → paste your `sk_test_…`
   - `ANTHROPIC_API_KEY` → optional, for the live AI assistant (from console.anthropic.com)
   - `STRIPE_WEBHOOK_SECRET` → leave blank for now (Step 4)
4. Click deploy. When it finishes, open the URL Render gives you (e.g. `https://valtier-intelligence.onrender.com`). **Your whole platform is live there** — sign-up, the app, everything.

### 4. Turn on payment confirmations (Stripe webhook)
Stripe needs to tell your app when a payment clears.
1. Stripe → **Developers → Webhooks → Add endpoint**.
2. URL: `https://YOUR-RENDER-URL/api/billing/webhook`
3. Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
4. Save, copy the **Signing secret** (`whsec_…`), paste it into Render as `STRIPE_WEBHOOK_SECRET`, and let it redeploy.

### 5. Test the full loop (free)
1. Open your Render URL, create an account, pick a plan.
2. Pay with Stripe's test card **4242 4242 4242 4242**, any future date, any CVC/ZIP.
3. You'll land back in the app on a paid plan. Check Stripe → Customers to see the subscription. (Your products/prices were created automatically — look under Stripe → Product catalog.)
4. Go to **Connect**, upload `sample-transactions.csv` or `sample-inventory.csv`, and confirm the analysis runs.

### 6. Put it on valtierintelligence.com
1. Register the domain at a registrar (Cloudflare, Namecheap, Porkbun) if you haven't — I can't reserve it; check availability there.
2. Render → your service → **Settings → Custom Domains → Add** `valtierintelligence.com`.
3. Render shows you a DNS record; add it at your registrar. HTTPS turns on automatically.

### 7. Go live
In Stripe, switch off **Test mode**, repeat Step 2 (live `sk_live_…` key) and Step 4 (a new live webhook + secret), update those two values in Render, redeploy. You're now taking real money.

---

## One honest production note

Render's **free** tier uses temporary storage and sleeps when idle — fine for testing, but accounts/data can reset on restart. Before real customers, do one of these so data is durable:
- Add a **Render Persistent Disk** (a few $/mo), mount it (e.g. at `/data`), and set the env var `DB_PATH=/data/valtier.db`; **or**
- Switch to managed **Postgres** (the data layer is isolated in `src/db.js`).

Your Stripe catalog is safe regardless — Valtier re-discovers your prices by a stable key, so it never creates duplicates even if local storage resets.

---

## Alternative: free demo on Netlify (no payments)
Just want the demo online to show people? Drag the standalone `index.html` onto **app.netlify.com/drop** — instant URL, no backend, payments simulated. (That file ships with live mode off.)

## Connecting POS & inventory
**Works today:** any POS/inventory system (Square, Shopify, Clover, Toast, Lightspeed, Cin7) can export a CSV. In **Connect**, upload it — Valtier auto-detects transactions, POS sales, or inventory and analyzes it for real. Inventory is **recommended for product/retail businesses but never required**; the platform runs fully on bank/accounting/POS data alone.
**Next build:** true one-click "Connect Square" sync needs each provider's developer approval + OAuth (keys issued to you; a developer wires the sync). The connector tiles and backend hooks are already in place.

## Where things live
- Payments + auto-catalog: `src/billing.js`
- Accounts / auth / MFA: `src/auth.js`
- API routes (incl. AI proxy `/api/ask`): `src/routes.js`
- Security middleware: `src/security.js`
- Data + encryption + settings: `src/db.js`
- The app the customer sees: `public/index.html` (bundled; live mode on)
- Deploy config: `render.yaml`

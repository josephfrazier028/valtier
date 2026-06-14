# Valtier Intelligence

**The finance department that never sleeps.** Valtier runs a company's books, forecasting, cash, and reporting with the judgment of a hundred senior CFOs — continuously, and it executes the fix instead of just flagging it.

This repository is a full-stack foundation:

- `valtier-intelligence.html` — the complete front-end product (single file, zero build step). Open it in any browser. Sign-up → live demo → paywall → subscription tiers, secure sign-in with MFA, the always-on lightning-V "it's working" mark, a guided first-run tutorial, persistent financial memory, and autonomous remediation where Valtier performs the fix and banks the savings.
- `valtier-backend/` — a runnable Node/Express + SQLite API implementing the real account lifecycle: company-email registration, argon2id passwords, TOTP multi-factor, short-lived JWTs, subscription state, the financial-memory store, the savings-guarantee ledger, and the findings/remediation lifecycle.

---

## Run it

**Front-end** — no install. Open `valtier-intelligence.html` in a browser. It works fully standalone; memory persists in the browser. (Sign up with any company email, MFA demo code `739204`, or pick "explore the full demo.")

**Backend**

```bash
cd valtier-backend
cp .env.example .env          # set real secrets before any real deployment
npm install
npm run init-db
npm start                     # API on http://localhost:8787
```

Health check: `GET /health`. All product endpoints live under `/api`.

---

## Architecture

```
Browser (valtier-intelligence.html)
        │  HTTPS / JWT (Bearer)
        ▼
Express API  ──►  Auth (argon2id + TOTP MFA + JWT)
   │              Subscriptions (demo → foundation → command → sovereign)
   │              Financial Memory  (durable, encrypted facts per company)
   │              Savings Ledger    (the guarantee — every dollar recovered)
   │              Findings + Autonomous Remediation (Valtier acts)
   ▼
SQLite (dev) / Postgres + KMS (prod), field-level AES-256-GCM at rest
```

The front-end ships as a single file on purpose: it loads instantly, has nothing to break in a build pipeline, and demonstrates the entire experience without a server. The backend mirrors every concept the UI exposes, so wiring the UI to live data is a matter of pointing `fetch` at `/api`.

## Security posture ("no hackers")

Security is layered, not a single feature:

- **Passwords:** argon2id hashing (memory-hard), 12-character minimum, login verifies against a hash even for unknown users to blunt account-enumeration.
- **Multi-factor:** TOTP via authenticator app (`otplib`); MFA is required to mint tokens.
- **Sessions:** short-lived (15-minute) access JWTs plus refresh tokens; the UI auto-locks an idle session.
- **Transport & headers:** Helmet with a strict Content-Security-Policy, HSTS preload, `no-referrer`, `x-powered-by` disabled.
- **Abuse control:** aggressive rate limiting on auth (10 / 15 min) and the API surface.
- **Data at rest:** sensitive values (bank tokens, statement detail, learned facts) are encrypted with AES-256-GCM before they touch disk. In production the key lives in a managed KMS, not an env var.
- **Least privilege:** Valtier requests **read-only** access tokens to source systems and never stores banking credentials.
- **Accountability:** every privileged action writes to an immutable `audit_log`.

For production this is the on-ramp to SOC 2 Type II, penetration testing, and a formal incident-response program — none of which can be claimed by software alone; they are organizational commitments layered on top of this code.

## Persistent financial memory

`memory_facts` is Valtier's long-term brain for each company — vendor rates, payment behavior, seasonality, prior decisions — stored encrypted and recalled on every session ("Welcome back — I've recovered $X since {date}"). This is what lets the platform compound: it gets sharper the longer it runs.

## Autonomous remediation (it does the fix)

A finding is not a to-do for the human. On approval (or autonomously, by policy), `POST /api/findings/:id/remediate` runs the action end-to-end, marks the finding resolved, and writes the recovered amount to `savings_ledger`. Demo accounts can watch the full sequence; paid plans can execute against real books. The production executor is where each action type plugs in: post a GL entry, send a vendor dispute, sweep idle cash to T-bills, fire a collections reminder.

## Subscription tiers

| Plan | Monthly | Annual | For |
|---|---|---|---|
| Foundation | $400 | $4,000 | Owner-operators & small businesses |
| Command | $1,200 | $12,000 | Growing companies — adds live forecasting + auto-remediation |
| **Sovereign** | **$2,500** | **$16,000** | The full mecca — unlimited entities, dedicated memory, treasury, guarantee |

Subscription activation is stubbed for the prototype; the production path is a Stripe Checkout session activated on webhook confirmation (the `POST /api/subscription` handler marks where that goes).

## The "100 CFOs" engine — production design

The demo uses realistic scripted data. The real engine that delivers the promise is a continuously-running pipeline:

1. **Ingest** — read-only connectors to ledgers, banks, payroll, billing; documents via extraction + OCR.
2. **Normalize & reconcile** — map every source to a unified chart of accounts; auto-match transactions; surface anomalies.
3. **Analyze** — a panel of specialized models (margin, cash, AR/AP, tax, treasury, forecasting) each acting as a domain CFO; an orchestrator reconciles their views into one verdict. This is the "100 senior managers, but faster and more accurate" — parallel, tireless, and consistent.
4. **Forecast** — models re-tuned in real time to the macro regime (rates, demand, FX).
5. **Act** — the remediation executor performs approved actions and records outcomes.
6. **Remember** — every result feeds back into financial memory, so judgment compounds.

## Honest status

The front-end is the real, complete product experience — every screen, flow, and interaction is built and working. The backend is a genuine, runnable foundation with real auth, encryption, and the full data model. What separates this from a deployed production platform is infrastructure and integration work, not vision: live connectors to real financial systems, the trained analysis/forecasting models, hardened cloud infrastructure, and third-party compliance certification. Those are the roadmap — and this codebase is built to receive them.

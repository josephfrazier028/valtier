'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const { baseHelmet, corsMw, apiLimiter } = require('./src/security');
const routes = require('./src/routes');
const billing = require('./src/billing');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(baseHelmet);
app.use(corsMw);
// Stripe webhook needs the raw body for signature verification (before json parser)
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billing.webhook);
app.use(express.json({ limit: '1mb' }));
app.use('/api', apiLimiter, routes);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'valtier', ts: Date.now() }));

// Serve the front-end — one service hosts both the app and the API.
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized error handler — never leak internals to the client.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal error.' : err.message });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Valtier API on :${PORT}`));

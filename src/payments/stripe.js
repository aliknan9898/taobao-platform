// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Stripe over plain REST (no SDK). Buyer pays the platform; the native app confirms
 * the PaymentIntent with the Stripe mobile SDK using `client_secret`.
 * Seller payouts: Stripe Connect transfers (see docs/ARCHITECTURE.md) — ledger kept in db.ledger.
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');

const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'pyg', 'ugx', 'xaf', 'xof']);
const toMinor = (amount, cur) => Math.round(Number(amount) * (ZERO_DECIMAL.has(cur) ? 1 : 100));

const demoMode = () => !config.stripeSecretKey;

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}

async function stripe(path, params, idempotencyKey, method = 'POST') {
  const res = await fetch(`${config.stripeApiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body: method === 'POST' ? form(params || {}) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(j.error?.message || 'Stripe error'), { status: 402 });
  return j;
}

async function createPaymentIntent(order) {
  if (demoMode()) return { provider: 'demo', intent_id: `demo_${order.id}`, client_secret: null, status: 'requires_payment_method' };
  const pi = await stripe('/payment_intents', {
    amount: toMinor(order.total, order.currency),
    currency: order.currency,
    automatic_payment_methods: { enabled: true },
    metadata: { order_id: order.id, buyer_id: order.buyer_id }
  }, `pi_${order.id}`);
  return { provider: 'stripe', intent_id: pi.id, client_secret: pi.client_secret, status: pi.status };
}

async function refund(order, amount) {
  if (demoMode() || order.payment?.provider !== 'stripe') return { demo: true };
  return stripe('/refunds', { payment_intent: order.payment.intent_id, amount: amount ? toMinor(amount, order.currency) : undefined }, `rf_${order.id}_${amount || 'full'}`);
}

// ---------- automatic setup: webhook endpoint + Apple Pay / Google Pay domain ----------
const SETUP_ID = 'stripe_setup';
const EVENTS = ['payment_intent.succeeded'];
const keyMode = () => (config.stripeSecretKey.startsWith('sk_live') || config.stripeSecretKey.startsWith('rk_live') ? 'live' : 'test');
const keyFingerprint = () => crypto.createHash('sha256').update(config.stripeSecretKey).digest('hex').slice(0, 16);
const hookUrl = () => `${config.publicBaseUrl}/webhooks/stripe`;

/** Webhook signing secrets to accept: the one set by hand (STRIPE_WEBHOOK_SECRET) and the one created automatically. */
function webhookSecrets() {
  const s = db.settings.get(SETUP_ID);
  return [config.stripeWebhookSecret, s && s.key === keyFingerprint() && s.url === hookUrl() ? s.webhook_secret : ''].filter(Boolean);
}

/**
 * With only the API keys set, create the webhook endpoint for this site (the signing secret is only shown at creation,
 * so it is stored) and register the domain for Apple Pay / Google Pay. Runs at start-up; does nothing once done.
 */
async function setup() {
  if (demoMode() || !/^https:\/\//.test(config.publicBaseUrl)) return { skipped: true };
  const saved = db.settings.get(SETUP_ID);
  const fp = keyFingerprint();
  if (saved && saved.key === fp && saved.url === hookUrl() && saved.webhook_secret && saved.domain_done) return { ok: true, mode: saved.mode };
  const doc = { key: fp, mode: keyMode(), url: hookUrl(), webhook_secret: saved && saved.key === fp && saved.url === hookUrl() ? saved.webhook_secret : '', domain_done: Boolean(saved && saved.key === fp && saved.domain_done) };
  if (!doc.webhook_secret && !config.stripeWebhookSecret) {
    const list = await stripe('/webhook_endpoints?limit=100', null, null, 'GET');
    for (const w of list.data || []) if (w.url === doc.url) await stripe(`/webhook_endpoints/${w.id}`, null, null, 'DELETE');
    const w = await stripe('/webhook_endpoints', { url: doc.url, enabled_events: EVENTS, description: 'Kinan — payment confirmations' });
    doc.webhook_secret = w.secret; doc.webhook_id = w.id;
    console.log(`[stripe] webhook endpoint created (${doc.mode}) → ${doc.url}`);
  }
  if (!doc.domain_done) {
    try {
      await stripe('/payment_method_domains', { domain_name: new URL(config.publicBaseUrl).hostname, enabled: true });
      console.log('[stripe] domain registered for Apple Pay / Google Pay');
    } catch (e) { if (!/already/i.test(e.message)) console.warn('[stripe] domain registration:', e.message); }
    doc.domain_done = true;
  }
  if (saved) db.settings.update(SETUP_ID, doc); else db.settings.insert({ id: SETUP_ID, ...doc });
  return { ok: true, mode: doc.mode };
}

function status() {
  if (demoMode()) return { mode: 'demo' };
  return { mode: keyMode(), webhook: webhookSecrets().length > 0, publishable_key: Boolean(config.stripePublishableKey) };
}

/** Verify `Stripe-Signature` (t=…,v1=…) over the RAW body, 5-minute tolerance. */
function verifyWebhook(rawBody, header, secret, now = Date.now()) {
  const secrets = secret ? [secret] : webhookSecrets();
  if (!header || !secrets.length) return false;
  return secrets.some((sec) => verifyWith(rawBody, header, sec, now));
}

function verifyWith(rawBody, header, secret, now) {
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = { createPaymentIntent, refund, verifyWebhook, demoMode, toMinor, setup, status, webhookSecrets };

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Stripe over plain REST (no SDK). Buyer pays the platform; the native app confirms
 * the PaymentIntent with the Stripe mobile SDK using `client_secret`.
 * Seller payouts: Stripe Connect transfers (see docs/ARCHITECTURE.md) — ledger kept in db.ledger.
 */
const crypto = require('crypto');
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

async function stripe(path, params, idempotencyKey) {
  const res = await fetch(`${config.stripeApiUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body: form(params),
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

/** Verify `Stripe-Signature` (t=…,v1=…) over the RAW body, 5-minute tolerance. */
function verifyWebhook(rawBody, header, secret = config.stripeWebhookSecret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = { createPaymentIntent, refund, verifyWebhook, demoMode, toMinor };

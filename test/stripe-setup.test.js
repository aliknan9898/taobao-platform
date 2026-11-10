// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Stripe automatic setup: webhook endpoint + wallet domain created from the API keys alone. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stripe-'));
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://kinan.example', STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_PUBLISHABLE_KEY: 'pk_test_abc', STRIPE_WEBHOOK_SECRET: '' });

const calls = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); const method = opts.method || 'GET';
  calls.push([method, u.pathname]);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.pathname === '/v1/webhook_endpoints' && method === 'GET') return ok({ data: [{ id: 'we_old', url: 'https://kinan.example/webhooks/stripe' }, { id: 'we_other', url: 'https://other.example/hook' }] });
  if (u.pathname === '/v1/webhook_endpoints/we_old' && method === 'DELETE') return ok({ deleted: true });
  if (u.pathname === '/v1/webhook_endpoints' && method === 'POST') {
    const b = new URLSearchParams(opts.body);
    assert.strictEqual(b.get('url'), 'https://kinan.example/webhooks/stripe');
    assert.strictEqual(b.get('enabled_events[0]'), 'payment_intent.succeeded');
    return ok({ id: 'we_new', secret: 'whsec_auto' });
  }
  if (u.pathname === '/v1/payment_method_domains') { assert.strictEqual(new URLSearchParams(opts.body).get('domain_name'), 'kinan.example'); return ok({ id: 'pmd_1' }); }
  throw new Error(`unexpected ${method} ${u.pathname}`);
};

const db = require('../src/db');
const stripe = require('../src/payments/stripe');

test('creates the webhook once, replaces the old one, registers the domain, and verifies with the stored secret', async () => {
  await db.init();
  const r = await stripe.setup();
  assert.deepStrictEqual(r, { ok: true, mode: 'test' });
  assert.deepStrictEqual(calls.map((c) => c.join(' ')), ['GET /v1/webhook_endpoints', 'DELETE /v1/webhook_endpoints/we_old', 'POST /v1/webhook_endpoints', 'POST /v1/payment_method_domains']);

  calls.length = 0;
  await stripe.setup();
  assert.strictEqual(calls.length, 0, 'second start does nothing');

  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_auto').update(`${t}.${body}`).digest('hex');
  assert.ok(stripe.verifyWebhook(body, `t=${t},v1=${sig}`));
  assert.ok(!stripe.verifyWebhook(body, `t=${t},v1=${'0'.repeat(64)}`));
  assert.deepStrictEqual(stripe.status(), { mode: 'test', webhook: true, publishable_key: true });
});

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Saved cards against a fake Stripe: add (SetupIntent on the buyer's customer), list, remove only your own. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_t' });

const customers = {}; const pms = {}; let n = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.stripe.com') return realFetch(url, opts);
  const method = opts.method || 'GET'; const b = new URLSearchParams(opts.body || '');
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.pathname === '/v1/customers' && method === 'POST') { const id = `cus_${++n}`; customers[id] = { id, email: b.get('email') }; return ok(customers[id]); }
  if (u.pathname === '/v1/setup_intents' && method === 'POST') {
    assert.ok(customers[b.get('customer')]); assert.strictEqual(b.get('payment_method_types[0]'), 'card');
    // pretend the buyer finished Stripe's form: a Visa is now on the customer
    const id = `pm_${++n}`; pms[id] = { id, customer: b.get('customer'), card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } };
    return ok({ id: `seti_${n}`, client_secret: `seti_${n}_secret` });
  }
  let m = u.pathname.match(/^\/v1\/customers\/(cus_\d+)\/payment_methods$/);
  if (m) return ok({ data: Object.values(pms).filter((p) => p.customer === m[1]) });
  m = u.pathname.match(/^\/v1\/payment_methods\/(pm_\d+)\/detach$/);
  if (m) { delete pms[m[1]]; return ok({ id: m[1] }); }
  throw new Error(`unexpected ${method} ${u.pathname}`);
};

const auth = require('../src/auth');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const buyer = async (email) => { await api('POST', '/api/auth/register', { email, password: 'password123', name: 'Buyer', role: 'buyer' }); return (await api('POST', '/api/auth/login', { email, password: 'password123' })).body.token; };

test('a buyer saves a card, sees only brand + last 4, and removes it; nobody else can', async () => {
  const a = await buyer('a@x.com'); const b = await buyer('b@x.com');
  assert.deepStrictEqual((await api('GET', '/api/buyer/cards', null, a)).body, []);
  const s = await api('POST', '/api/buyer/cards/setup', null, a);
  assert.strictEqual(s.status, 200); assert.match(s.body.client_secret, /^seti_/);
  const list = (await api('GET', '/api/buyer/cards', null, a)).body;
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(Object.keys(list[0]).sort(), ['brand', 'exp_month', 'exp_year', 'id', 'last4']);
  assert.strictEqual(list[0].last4, '4242');
  // the second buyer cannot see or remove it
  assert.deepStrictEqual((await api('GET', '/api/buyer/cards', null, b)).body, []);
  assert.strictEqual((await api('DELETE', `/api/buyer/cards/${list[0].id}`, null, b)).status, 404);
  const after = await api('DELETE', `/api/buyer/cards/${list[0].id}`, null, a);
  assert.strictEqual(after.status, 200); assert.deepStrictEqual(after.body, []);
  // one Stripe customer per buyer, reused
  await api('POST', '/api/buyer/cards/setup', null, a);
  assert.strictEqual(Object.keys(customers).length, 1);
});

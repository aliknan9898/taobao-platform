// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* A saved Stripe customer id that the current key does not know (test → live switch, other account, deleted):
   the cards page must not show "No such customer"; a fresh customer is made and the old id is replaced. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-stale-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_t' });

const customers = {}; const pms = {}; let n = 0; let created = 0;
const realFetch = global.fetch;
const missing = (id) => ({ ok: false, status: 404, json: async () => ({ error: { code: 'resource_missing', param: 'customer', message: `No such customer: '${id}'` } }) });
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.stripe.com') return realFetch(url, opts);
  const method = opts.method || 'GET'; const b = new URLSearchParams(opts.body || '');
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.pathname === '/v1/customers' && method === 'POST') { created++; const id = `cus_new${++n}`; customers[id] = { id }; return ok(customers[id]); }
  let m = u.pathname.match(/^\/v1\/customers\/(cus_\w+)$/);
  if (m) return customers[m[1]] ? ok(customers[m[1]]) : missing(m[1]);
  m = u.pathname.match(/^\/v1\/customers\/(cus_\w+)\/payment_methods$/);
  if (m) return customers[m[1]] ? ok({ data: Object.values(pms).filter((p) => p.customer === m[1]) }) : missing(m[1]);
  if (u.pathname === '/v1/setup_intents' && method === 'POST') {
    if (!customers[b.get('customer')]) return missing(b.get('customer'));
    const id = `pm_${++n}`; pms[id] = { id, customer: b.get('customer'), card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } };
    return ok({ id: `seti_${n}`, client_secret: `seti_${n}_secret` });
  }
  throw new Error(`unexpected ${method} ${u.pathname}`);
};

const db = require('../src/db');
const auth = require('../src/auth');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('an old customer id from test mode is replaced instead of breaking the cards page', async () => {
  await api('POST', '/api/auth/register', { email: 'old@x.com', password: 'password123', name: 'Old', role: 'buyer' });
  const token = (await api('POST', '/api/auth/login', { email: 'old@x.com', password: 'password123' })).body.token;
  const user = db.users.find((x) => x.email === 'old@x.com');
  db.users.update(user.id, { stripe_customer_id: 'cus_VbqdWm472eqowq' }); // made with the old test key

  const list = await api('GET', '/api/buyer/cards', null, token);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.body, []);
  assert.strictEqual(db.users.get(user.id).stripe_customer_id, null);

  const s = await api('POST', '/api/buyer/cards/setup', null, token);
  assert.strictEqual(s.status, 200);
  const fresh = db.users.get(user.id).stripe_customer_id;
  assert.match(fresh, /^cus_new/);
  assert.strictEqual((await api('GET', '/api/buyer/cards', null, token)).body.length, 1);

  // the new id is trusted from now on: no new customer on later calls
  await api('GET', '/api/buyer/cards', null, token);
  await api('POST', '/api/buyer/cards/setup', null, token);
  assert.strictEqual(created, 1);
  assert.strictEqual(db.users.get(user.id).stripe_customer_id, fresh);
});

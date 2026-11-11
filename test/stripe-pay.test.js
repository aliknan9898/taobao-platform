// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Card payments end to end against a fake Stripe: pay, instant confirmation, webhook replay, cancel → automatic refund. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stripepay-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_t' });

const intents = {}; const refunds = []; const cancels = []; let n = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.stripe.com') return realFetch(url, opts);
  const method = opts.method || 'GET'; const b = new URLSearchParams(opts.body || '');
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.pathname === '/v1/payment_intents' && method === 'POST') {
    const id = `pi_${++n}`;
    intents[id] = { id, amount: Number(b.get('amount')), currency: b.get('currency'), status: 'requires_payment_method', client_secret: `${id}_secret`, metadata: { order_id: b.get('metadata[order_id]') }, livemode: false };
    return ok(intents[id]);
  }
  let m = u.pathname.match(/^\/v1\/payment_intents\/(pi_\d+)$/);
  if (m && method === 'GET') return ok(intents[m[1]]);
  m = u.pathname.match(/^\/v1\/payment_intents\/(pi_\d+)\/cancel$/);
  if (m) { cancels.push(m[1]); intents[m[1]].status = 'canceled'; return ok(intents[m[1]]); }
  if (u.pathname === '/v1/refunds') { refunds.push(b.get('payment_intent')); return ok({ id: `re_${refunds.length}` }); }
  throw new Error(`unexpected ${method} ${u.pathname}`);
};
const succeed = (id) => Object.assign(intents[id], { status: 'succeeded', amount_received: intents[id].amount });

const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token, headers = {}) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
function hook(pi) {
  const body = JSON.stringify({ id: `evt_${pi.id}_${Math.random()}`, type: 'payment_intent.succeeded', data: { object: pi } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_t').update(`${t}.${body}`).digest('hex');
  return api('POST', '/webhooks/stripe', body, null, { 'Stripe-Signature': `t=${t},v1=${sig}` });
}

test('card payment flow', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('sel@x.com', 'sellerpass');
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Lamp', category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants: [{ name: 'One', price: 20, stock: 10 }] }, sel)).body;
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'C' });
  const cust = await login('c@x.com', 'buyerpass1');
  const checkout = () => api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 1 }], shipping_address: { name: 'C', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' } }, cust);

  // 1) pay by card, browser confirms at once
  const o = (await checkout()).body;
  assert.strictEqual((await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, cust)).status, 403, 'test button is off');
  const cp = (await api('POST', `/api/buyer/orders/${o.id}/card-payment`, null, cust)).body;
  assert.strictEqual(cp.client_secret, 'pi_1_secret', 'reuses the intent made at checkout');
  assert.strictEqual(intents.pi_1.amount, Math.round(db.orders.get(o.id).total * 100));
  succeed('pi_1');
  const after = (await api('POST', `/api/buyer/orders/${o.id}/confirm-card`, null, cust)).body;
  assert.strictEqual(after.status !== 'pending_payment', true, 'paid right away');
  // webhook arrives later: nothing changes, no refund
  assert.strictEqual((await hook(intents.pi_1)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(refunds, []);

  // 2) cancelled while unpaid, then the bank completes the payment anyway → refunded automatically
  const o2 = (await checkout()).body;
  const id2 = db.orders.get(o2.id).payment.intent_id;
  await api('POST', `/api/buyer/orders/${o2.id}/cancel`, null, cust);
  assert.deepStrictEqual(cancels, [id2]);
  succeed(id2);
  await hook(intents[id2]);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(refunds, [id2]);
  assert.strictEqual(db.orders.get(o2.id).status, 'cancelled');

  // 3) a forged webhook is rejected
  const bad = await api('POST', '/webhooks/stripe', JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: intents.pi_1 } }), null, { 'Stripe-Signature': 't=1,v1=00' });
  assert.strictEqual(bad.status, 400);

  // 4) an intent that Stripe cancelled gets replaced with a new one
  const o3 = (await checkout()).body;
  const id3 = db.orders.get(o3.id).payment.intent_id;
  intents[id3].status = 'canceled';
  const cp3 = (await api('POST', `/api/buyer/orders/${o3.id}/card-payment`, null, cust)).body;
  assert.notStrictEqual(cp3.client_secret, `${id3}_secret`);
});

test('customers in the UK pay in GBP and in Europe in EUR; the order keeps USD inside', async () => {
  const fx = require('../src/services/fx');
  db.settings.get('set_fx') ? db.settings.update('set_fx', { base: 'USD', rates: { CNY: 7.1, EUR: 0.9, GBP: 0.8 }, updated_at: Date.now() }) : db.settings.insert({ id: 'set_fx', base: 'USD', rates: { CNY: 7.1, EUR: 0.9, GBP: 0.8 }, updated_at: Date.now() });
  assert.strictEqual(fx.chargeRate('EUR'), 0.909);
  const cust = await login('c@x.com', 'buyerpass1');
  const p = db.listings.find((l) => l.title === 'Lamp');
  db.listings.update(p.id, (x) => ({ ...x, skus: x.skus.map((s) => ({ ...s, stock: 50 })) }));
  const buy = (country) => api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 1 }], shipping_address: { name: 'C', phone: '+44', country_code: country, city: 'X', line1: 'St 1' } }, cust);
  const uk = (await buy('GB')).body;
  const o = db.orders.get(uk.id);
  assert.strictEqual(o.currency, 'usd'); assert.strictEqual(o.charge.currency, 'gbp'); assert.strictEqual(o.charge.total, Math.round(o.total * 0.808 * 100) / 100);
  const pi = Object.values(intents).find((x) => x.metadata.order_id === o.id);
  assert.strictEqual(pi.currency, 'gbp'); assert.strictEqual(pi.amount, Math.round(o.charge.total * 100));
  const view = (await api('GET', `/api/buyer/orders/${o.id}`, null, cust)).body;
  assert.strictEqual(view.currency, 'gbp'); assert.strictEqual(view.total, o.charge.total);
  succeed(pi.id); await hook(pi);
  assert.notStrictEqual(db.orders.get(o.id).status, 'pending_payment', 'GBP payment accepted');
  const eu = db.orders.get((await buy('MT')).body.id); assert.strictEqual(eu.charge.currency, 'eur');
  const us = db.orders.get((await buy('SA')).body.id); assert.strictEqual(us.charge, undefined);
});

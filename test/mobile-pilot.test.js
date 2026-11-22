// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* KINAN Shop mobile pilot (Flutter app, apps/shop-mobile): the API acceptance criteria the app depends on, run end to end
   against the normal Shop API with synthetic sellers, buyers and products and a fake Stripe in test mode.
   Covers: country eligibility (catalog, quote and checkout), price/stock changes before payment, checkout recovery after a
   lost response and an app/server restart (one order, one payment intent), the payment lifecycle (pending until the
   webhook), seller isolation, and a fulfilment step reaching the buyer's order view. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobilepilot-'));
for (const k of ['DATABASE_URL', 'PAYMENTS_PAUSED']) delete process.env[k];
Object.assign(process.env, {
  ADMIN_EMAIL: 'boss@pilot.test', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example',
  STRIPE_SECRET_KEY: 'sk_test_pilot', STRIPE_PUBLISHABLE_KEY: 'pk_test_pilot', STRIPE_WEBHOOK_SECRET: 'whsec_pilot'
});

// Fake Stripe (test mode only): records every PaymentIntent so the test can count them per order.
const intents = {}; let n = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.stripe.com') return realFetch(url, opts);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  const method = opts.method || 'GET'; const b = new URLSearchParams(opts.body || '');
  if (u.pathname === '/v1/payment_intents' && method === 'POST') {
    const id = `pi_pilot_${++n}`;
    intents[id] = { id, amount: Number(b.get('amount')), currency: b.get('currency'), status: 'requires_payment_method', client_secret: `${id}_secret_x`, metadata: { order_id: b.get('metadata[order_id]') }, livemode: false };
    return ok(intents[id]);
  }
  let m = u.pathname.match(/^\/v1\/payment_intents\/(pi_pilot_\d+)$/);
  if (m && method === 'GET') return ok(intents[m[1]]);
  m = u.pathname.match(/^\/v1\/payment_intents\/(pi_pilot_\d+)\/cancel$/);
  if (m) { intents[m[1]].status = 'canceled'; return ok(intents[m[1]]); }
  if (u.pathname === '/v1/refunds') return ok({ id: 're_pilot' });
  throw new Error(`unexpected Stripe call ${method} ${u.pathname}`);
};

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
const login = async (email, password, app) => (await api('POST', '/api/auth/login', { email, password, app })).body.token;
const hook = (pi, type = 'payment_intent.succeeded') => {
  const body = JSON.stringify({ id: `evt_${pi.id}_${type}`, type, data: { object: pi } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_pilot').update(`${t}.${body}`).digest('hex');
  return api('POST', '/webhooks/stripe', body, null, { 'Stripe-Signature': `t=${t},v1=${sig}` });
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const addr = (country_code) => ({ name: 'Pilot Buyer', phone: '+35679000000', country_code, city: 'Valletta', line1: 'Pilot Street 1' });
const intentsFor = (orderId) => Object.values(intents).filter((i) => i.metadata.order_id === orderId);

// Fixture: two active sellers, approved products, one product the supplier cannot deliver to Malta.
const fx = {};
async function fixture() {
  if (fx.ready) return fx;
  fx.boss = await login('boss@pilot.test', 'adminpass1');
  const seller = async (email, shop) => {
    const reg = (await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email, password: 'sellerpass1', shop_name: shop })).body;
    await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, fx.boss);
    return { id: reg.seller_id, token: await login(email, 'sellerpass1', 'seller') };
  };
  fx.a = await seller('seller-a@pilot.test', 'Pilot Store A');
  fx.b = await seller('seller-b@pilot.test', 'Pilot Store B');
  fx.c = await seller('seller-c@pilot.test', 'Pilot Store C');
  const product = async (s, title, variants) => {
    const p = (await api('POST', '/api/seller/products/manual', { title, category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants }, s.token)).body;
    assert.ok(p.id, JSON.stringify(p));
    assert.equal((await api('POST', `/api/admin/listings/${p.id}/approve`, null, fx.boss)).status, 200);
    return p.id;
  };
  fx.lamp = await product(fx.a, 'Pilot Lamp', [{ name: 'Red', price: 20, stock: 10 }, { name: 'Blue', price: 22, stock: 0 }]);
  fx.vase = await product(fx.b, 'Pilot Vase', [{ name: 'White', price: 15, stock: 10 }]);
  fx.blocked = await product(fx.a, 'Pilot Heater', [{ name: 'One', price: 30, stock: 10 }]);
  // Supplier (CJ) product with a fresh "cannot deliver to MT" answer: the same state the CJ shipping check stores.
  db.listings.update(fx.blocked, (l) => ({ ...l, source: 'cj', last_synced_at: Date.now(), skus: l.skus.map((s) => ({ ...s, cj_vid: 'vid_pilot_1' })), cj_ship: { MT: { none: true, at: Date.now(), vid: 'vid_pilot_1' } } }));
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'buyer@pilot.test', password: 'buyerpass1', name: 'Pilot Buyer' });
  fx.buyer = await login('buyer@pilot.test', 'buyerpass1', 'shop');
  fx.sku = async (id, i = 0) => (await api('GET', `/api/catalog/${id}`)).body.skus[i].mp_sku_id;
  fx.ready = true;
  return fx;
}

test('browse by country: the eligible product is listed, the ineligible one cannot be bought there', async () => {
  const f = await fixture();
  const mt = (await api('GET', '/api/catalog?country=MT&limit=50')).body;
  const sa = (await api('GET', '/api/catalog?country=SA&limit=50')).body;
  assert.ok(mt.items.some((x) => x.id === f.lamp), 'eligible product listed for MT');
  assert.ok(!mt.items.some((x) => x.id === f.blocked), 'ineligible product hidden for MT');
  assert.ok(sa.items.some((x) => x.id === f.blocked), 'still listed where it can be delivered');
  assert.ok(Number.isFinite(mt.total) && Array.isArray(mt.items), 'paginated shape {total, items}');
  assert.equal((await api('GET', '/api/catalog?country=MT&limit=1&offset=1')).body.items.length, 1, 'offset pages');

  const blockedItem = { listing_id: f.blocked, mp_sku_id: await f.sku(f.blocked), qty: 1 };
  const q = await api('POST', '/api/shipping/quote', { items: [blockedItem, { listing_id: f.lamp, mp_sku_id: await f.sku(f.lamp), qty: 1 }], country_code: 'MT' });
  assert.equal(q.status, 200);
  assert.deepEqual(q.body.undeliverable, [f.blocked], 'quote names the item the app must remove');
  const qOk = await api('POST', '/api/shipping/quote', { items: [blockedItem], country_code: 'SA' });
  assert.equal(qOk.body.undeliverable, undefined, 'no field when everything can be delivered (unchanged response)');

  const before = db.orders.all().length;
  const co = await api('POST', '/api/buyer/checkout', { items: [blockedItem], shipping_address: addr('MT') }, f.buyer, { 'Idempotency-Key': 'pilot-blocked-0001' });
  assert.equal(co.status, 409, JSON.stringify(co.body));
  assert.match(co.body.error, /cannot be delivered to Malta/);
  assert.equal(db.orders.all().length, before, 'no order, no payment intent');
});

test('price and stock changes are reported by the server before any payment', async () => {
  const f = await fixture();
  const sku = await f.sku(f.lamp);
  const shown = (await api('GET', `/api/catalog/${f.lamp}`)).body.skus[0].price;
  assert.equal(shown, 20);
  // seller raises the price while the buyer has it in the cart
  const l = db.listings.get(f.lamp);
  const realSku = l.skus.find((s) => s.props === 'Red').mp_sku_id;
  assert.equal((await api('PATCH', `/api/seller/products/${f.lamp}`, { prices: { [realSku]: 24 } }, f.a.token)).status, 200);
  assert.equal((await api('GET', `/api/catalog/${f.lamp}`)).body.skus[0].price, 24, 'catalog re-read shows the new price');
  const co = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: f.lamp, mp_sku_id: sku, qty: 1 }], shipping_address: addr('MT') }, f.buyer, { 'Idempotency-Key': 'pilot-price-00001' });
  assert.equal(co.status, 201);
  assert.equal(co.body.status, 'pending_payment', 'nothing charged yet');
  assert.equal(co.body.lines[0].price > 20, true, 'the order carries the server price, which the app compares with what it showed');
  assert.ok(co.body.total && co.body.currency && co.body.payment.client_secret, 'server total + currency + client secret before payment');
  // out of stock variant
  const oos = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: f.lamp, mp_sku_id: await f.sku(f.lamp, 1), qty: 1 }], shipping_address: addr('MT') }, f.buyer, { 'Idempotency-Key': 'pilot-stock-00001' });
  assert.equal(oos.status, 409);
  assert.match(oos.body.error, /Not enough stock/);
  assert.equal((await api('GET', `/api/catalog/${f.lamp}`)).body.skus[1].in_stock, false, 'variant shown as unavailable');
  await api('PATCH', `/api/seller/products/${f.lamp}`, { prices: { [realSku]: 20 } }, f.a.token);
});

test('checkout recovery: lost response, app restart and retry give one order and one payment intent', async () => {
  const f = await fixture();
  const key = `pilot-recover-${crypto.randomBytes(6).toString('hex')}`;
  const body = { items: [{ listing_id: f.vase, mp_sku_id: await f.sku(f.vase), qty: 2 }], shipping_address: addr('MT') };
  const ordersBefore = db.orders.all().length;
  // 1) the request reaches the server but the phone loses the connection before the answer arrives
  // (the server's final save is slowed down so the connection is always dropped after the order exists, before the reply)
  const realFlush = db.flush; let release; const held = new Promise((r) => { release = r; });
  db.flush = async (...a) => { await held; return realFlush.apply(db, a); };
  const ctl = new AbortController();
  const lost = realFetch(`${base}/api/buyer/checkout`, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.buyer}`, 'Idempotency-Key': key }, body: JSON.stringify(body) }).catch((e) => e);
  try {
    for (let i = 0; i < 200 && db.orders.all().length === ordersBefore; i++) await wait(5);
    assert.equal(db.orders.all().length, ordersBefore + 1, 'the server created the order');
    ctl.abort();
    assert.ok((await lost) instanceof Error, 'the app never saw the answer');
  } finally { db.flush = realFlush; release(); }
  await wait(20);
  // 2) the app restarts, reads its saved attempt (same key, same payload) and retries — twice, in parallel
  const [r1, r2] = await Promise.all([api('POST', '/api/buyer/checkout', body, f.buyer, { 'Idempotency-Key': key }), api('POST', '/api/buyer/checkout', body, f.buyer, { 'Idempotency-Key': key })]);
  assert.ok([200, 201].includes(r1.status), JSON.stringify(r1.body));
  assert.equal(r1.body.id, r2.body.id);
  // 3) the server restarts between saving the order and saving the key: the order itself still carries the key
  const keyHash = crypto.createHash('sha256').update(`${db.users.find((u) => u.email === 'buyer@pilot.test').id}|${key}`).digest('hex');
  for (const t of db.tokens.all((x) => x.kind === 'idem' && x.token_hash === keyHash)) db.tokens.remove(t.id);
  const r3 = await api('POST', '/api/buyer/checkout', body, f.buyer, { 'Idempotency-Key': key });
  assert.equal(r3.body.id, r1.body.id, 'found through the order');
  assert.equal(db.orders.all().length, ordersBefore + 1, 'exactly one order');
  assert.equal(intentsFor(r1.body.id).length, 1, 'exactly one payment intent');
  assert.equal(r3.body.payment.client_secret, intentsFor(r1.body.id)[0].client_secret, 'the same client secret to finish paying');
  // 4) a deliberately changed basket with the old key is refused; the app makes a new key for it
  const changed = await api('POST', '/api/buyer/checkout', { ...body, items: [{ ...body.items[0], qty: 3 }] }, f.buyer, { 'Idempotency-Key': key });
  assert.equal(changed.status, 409);
});

test('payment lifecycle: confirmed only by the backend; cancelled and failed payments leave a payable order', async () => {
  const f = await fixture();
  const body = { items: [{ listing_id: f.lamp, mp_sku_id: await f.sku(f.lamp), qty: 1 }], shipping_address: addr('MT') };
  const o = (await api('POST', '/api/buyer/checkout', body, f.buyer, { 'Idempotency-Key': `pilot-pay-${Date.now()}` })).body;
  const pi = intents[db.orders.get(o.id).payment.intent_id];
  // the app's PaymentSheet reports success, but no webhook yet: still pending
  Object.assign(pi, { status: 'succeeded', amount_received: pi.amount });
  assert.equal((await api('GET', `/api/buyer/orders/${o.id}`, null, f.buyer)).body.status, 'pending_payment');
  assert.equal((await hook(pi)).status, 200);
  for (let i = 0; i < 50 && db.orders.get(o.id).status === 'pending_payment'; i++) await wait(20);
  const paid = (await api('GET', `/api/buyer/orders/${o.id}`, null, f.buyer)).body;
  assert.notEqual(paid.status, 'pending_payment', 'confirmed after the backend saw the payment');
  assert.equal(paid.payment.client_secret, undefined, 'no secret once paid');

  // cancellation in the sheet: nothing changes server side; the same secret is offered again
  const o2 = (await api('POST', '/api/buyer/checkout', body, f.buyer, { 'Idempotency-Key': `pilot-cancel-${Date.now()}` })).body;
  const again = (await api('GET', `/api/buyer/orders/${o2.id}`, null, f.buyer)).body;
  assert.equal(again.status, 'pending_payment');
  assert.equal(again.payment.client_secret, o2.payment.client_secret, 'retry possible');
  // a failed card: Stripe sends payment_failed; the order stays payable, then the buyer can cancel it
  const pi2 = intents[db.orders.get(o2.id).payment.intent_id];
  assert.equal((await hook({ ...pi2, status: 'requires_payment_method' }, 'payment_intent.payment_failed')).status, 200);
  await wait(30);
  assert.equal(db.orders.get(o2.id).status, 'pending_payment');
  const cancelled = await api('POST', `/api/buyer/orders/${o2.id}/cancel`, null, f.buyer);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
});

test('seller linkage: each seller sees only its own lines; a fulfilment step reaches the buyer', async () => {
  const f = await fixture();
  const items = [{ listing_id: f.lamp, mp_sku_id: await f.sku(f.lamp), qty: 1 }, { listing_id: f.vase, mp_sku_id: await f.sku(f.vase), qty: 1 }];
  const o = (await api('POST', '/api/buyer/checkout', { items, shipping_address: addr('MT') }, f.buyer, { 'Idempotency-Key': `pilot-sellers-${Date.now()}` })).body;
  // unpaid orders are not shown to sellers
  assert.ok(!(await api('GET', '/api/seller/orders', null, f.a.token)).body.some((x) => x.id === o.id));
  const pi = intents[db.orders.get(o.id).payment.intent_id];
  Object.assign(pi, { status: 'succeeded', amount_received: pi.amount });
  await hook(pi);
  for (let i = 0; i < 50 && db.orders.get(o.id).status === 'pending_payment'; i++) await wait(20);

  const forA = (await api('GET', '/api/seller/orders', null, f.a.token)).body.find((x) => x.id === o.id);
  const forB = (await api('GET', '/api/seller/orders', null, f.b.token)).body.find((x) => x.id === o.id);
  assert.deepEqual(forA.lines.map((l) => l.title), ['Pilot Lamp']);
  assert.deepEqual(forB.lines.map((l) => l.title), ['Pilot Vase']);
  assert.ok(!JSON.stringify(forA).includes('Pilot Street 1'), 'no buyer address for sellers');
  assert.ok(!(await api('GET', '/api/seller/orders', null, f.c.token)).body.some((x) => x.id === o.id), 'a seller without lines does not see it');
  assert.equal((await api('GET', `/api/seller/orders/${o.id}/messages`, null, f.c.token)).status, 404);
  assert.equal((await api('GET', `/api/seller/orders/${o.id}`, null, f.c.token)).status === 200, false);
  assert.equal((await api('GET', `/api/buyer/orders/${o.id}`, null, f.a.token)).status === 200, false, 'a seller token cannot read the buyer view');

  // Fulfilment: Kinan buys seller A's manual item (existing admin/procurement route) — seller A and the buyer both see it
  const subA = db.orders.get(o.id).sub_orders.find((s) => s.seller_id === f.a.id && s.manual);
  assert.ok(subA, 'manual purchase for seller A');
  assert.equal((await api('POST', `/api/admin/orders/${o.id}/manual-bought`, { outer_purchase_id: subA.outer_purchase_id, taobao_order_no: 'TB-PILOT-1' }, f.boss)).status, 200);
  const aAfter = (await api('GET', '/api/seller/orders', null, f.a.token)).body.find((x) => x.id === o.id);
  assert.equal(aAfter.purchase.status, 'MANUAL_BOUGHT');
  const bAfter = (await api('GET', '/api/seller/orders', null, f.b.token)).body.find((x) => x.id === o.id);
  assert.notEqual(bAfter.purchase.status, 'MANUAL_BOUGHT', "seller B's part is unchanged");
  const buyerView = (await api('GET', `/api/buyer/orders/${o.id}`, null, f.buyer)).body;
  assert.ok(buyerView.timeline.some((t) => t.event === 'manual_bought'), 'buyer timeline shows the step');

  // Warehouse ships (parcels received + QC are shortcut here with synthetic state); the buyer gets tracking
  await api('POST', '/api/admin/staff', { name: 'Pilot WH', email: 'wh@pilot.test', password: 'whpass1234', role: 'warehouse' }, f.boss);
  const wh = await login('wh@pilot.test', 'whpass1234');
  db.orders.update(o.id, { status: 'ready_to_ship' });
  const ship = await api('POST', `/api/warehouse/orders/${o.id}/ship`, { carrier: 'DHL', tracking: 'PILOT123456', weight_g: 1500 }, wh);
  assert.equal(ship.status, 200, JSON.stringify(ship.body));
  const shipped = (await api('GET', `/api/buyer/orders/${o.id}`, null, f.buyer)).body;
  assert.equal(shipped.status, 'shipped');
  assert.equal(shipped.tracking.number, 'PILOT123456');
  assert.equal((await api('GET', '/api/seller/orders', null, f.a.token)).body.find((x) => x.id === o.id).status, 'shipped');
});

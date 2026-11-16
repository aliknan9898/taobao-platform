// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* API additions for the native Kinan Shop apps: public variant ids, checkout idempotency, webhook retry and the hourly
   payment check, phone sign-in token, profile/password, account deletion, native push devices, cart read, languages,
   measured delivery days. Runs against fake Stripe, Brevo SMS and Expo push services. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobileapi-'));
Object.assign(process.env, {
  ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_t',
  BREVO_API_KEY: 'brevo_test', SMS_SENDER: 'Kinan', PHONE_LOGIN_PREFIXES: '+356'
});

const intents = {}; let n = 0; const sms = []; const expo = []; const deletedCustomers = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.hostname === 'api.brevo.com') {
    if (u.pathname.includes('transactionalSMS')) sms.push(JSON.parse(opts.body));
    return ok({ messageId: 1 });
  }
  if (u.hostname === 'exp.host') {
    const msgs = JSON.parse(opts.body); expo.push(...msgs);
    return ok({ data: msgs.map((m) => (m.to.includes('Gone') ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: crypto.randomUUID() })) });
  }
  if (u.hostname !== 'api.stripe.com') return realFetch(url, opts);
  const method = opts.method || 'GET'; const b = new URLSearchParams(opts.body || '');
  if (u.pathname === '/v1/payment_intents' && method === 'POST') {
    const id = `pi_${++n}`;
    intents[id] = { id, amount: Number(b.get('amount')), currency: b.get('currency'), status: 'requires_payment_method', client_secret: `${id}_secret`, metadata: { order_id: b.get('metadata[order_id]') }, livemode: false };
    return ok(intents[id]);
  }
  let m = u.pathname.match(/^\/v1\/payment_intents\/(pi_\d+)$/);
  if (m && method === 'GET') return ok(intents[m[1]]);
  m = u.pathname.match(/^\/v1\/payment_intents\/(pi_\d+)\/cancel$/);
  if (m) { intents[m[1]].status = 'canceled'; return ok(intents[m[1]]); }
  m = u.pathname.match(/^\/v1\/customers\/(cus_\w+)$/);
  if (m && method === 'DELETE') { deletedCustomers.push(m[1]); return ok({ id: m[1], deleted: true }); }
  if (u.pathname === '/v1/refunds') return ok({ id: 're_1' });
  throw new Error(`unexpected Stripe call ${method} ${u.pathname}`);
};
const succeed = (id) => Object.assign(intents[id], { status: 'succeeded', amount_received: intents[id].amount });

const auth = require('../src/auth');
const db = require('../src/db');
const orders = require('../src/services/orders');
const webhooks = require('../src/webhooks');
const push = require('../src/push');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token, headers = {}) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p, app: 'shop' })).body.token;
const hook = (pi, id = `evt_${pi.id}`) => {
  const body = JSON.stringify({ id, type: 'payment_intent.succeeded', data: { object: pi } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_t').update(`${t}.${body}`).digest('hex');
  return api('POST', '/webhooks/stripe', body, null, { 'Stripe-Signature': `t=${t},v1=${sig}` });
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const addr = { name: 'C', phone: '+35679000000', country_code: 'MT', city: 'Valletta', line1: 'St 1' };

let product; let product2; let boss;
async function shopWithProducts() {
  if (product) return;
  boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = (await api('POST', '/api/auth/login', { email: 'sel@x.com', password: 'sellerpass', app: 'seller' })).body.token;
  const mk = async (title) => {
    const p = (await api('POST', '/api/seller/products/manual', { title, category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants: [{ name: 'Red', price: 20, stock: 10 }, { name: 'Blue', price: 22, stock: 10 }] }, sel)).body;
    await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);
    return p;
  };
  product = await mk('Lamp'); product2 = await mk('Vase');
}
async function customer(email, password = 'buyerpass1') {
  await api('POST', '/api/auth/register', { role: 'buyer', email, password, name: 'Cust' });
  return login(email, password);
}

test('customers see neutral variant ids; old and new ids both work at checkout', async () => {
  await shopWithProducts();
  // make the first variant look like a supplier variant inside Kinan
  db.listings.update(product.id, (l) => ({ ...l, skus: l.skus.map((s, i) => (i === 0 ? { ...s, mp_sku_id: 'cj_998877' } : s)) }));
  const view = (await api('GET', `/api/catalog/${product.id}`)).body;
  const raw = JSON.stringify(view);
  assert.ok(!/cj_|"AE\d|bg_/.test(raw), 'no supplier-style ids in the product view');
  assert.ok(view.skus.every((s) => /^v_[\w-]{16}$/.test(s.mp_sku_id)), 'public ids');
  const list = JSON.stringify((await api('GET', '/api/catalog?limit=50')).body);
  assert.ok(!list.includes('cj_998877'), 'not in the list either');

  const cust = await customer('ids@x.com');
  const byPublic = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: product.id, mp_sku_id: view.skus[0].mp_sku_id, qty: 1 }], shipping_address: addr }, cust);
  assert.strictEqual(byPublic.status, 201, JSON.stringify(byPublic.body));
  assert.strictEqual(db.orders.get(byPublic.body.id).lines[0].mp_sku_id, 'cj_998877', 'stored with the real id');
  const byOld = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: product.id, mp_sku_id: 'cj_998877', qty: 1 }], shipping_address: addr }, cust);
  assert.strictEqual(byOld.status, 201, 'carts saved before the change still check out');
  const bad = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: product.id, mp_sku_id: 'v_notarealvariant1', qty: 1 }], shipping_address: addr }, cust);
  assert.strictEqual(bad.status, 409);

  // shipping quote and cart lines accept the public id
  const q = await api('POST', '/api/shipping/quote', { items: [{ listing_id: product.id, mp_sku_id: view.skus[0].mp_sku_id, qty: 1 }], country_code: 'MT' });
  assert.strictEqual(q.status, 200);
  assert.ok(q.body.weight_kg > 0, 'the variant was recognised');
  const lines = (await api('GET', `/api/catalog/lines?items=${product.id}~${encodeURIComponent(view.skus[1].mp_sku_id)}`)).body;
  assert.strictEqual(lines.items[0].mp_sku_id, view.skus[1].mp_sku_id, 'same variant back, public id');
});

test('checkout with an Idempotency-Key makes one order, even for parallel taps', async () => {
  await shopWithProducts();
  const cust = await customer('idem@x.com');
  const sku = (await api('GET', `/api/catalog/${product2.id}`)).body.skus[0].mp_sku_id;
  const body = { items: [{ listing_id: product2.id, mp_sku_id: sku, qty: 1 }], shipping_address: addr };
  const before = db.orders.all().length;
  const [a, b] = await Promise.all([api('POST', '/api/buyer/checkout', body, cust, { 'Idempotency-Key': 'tap-0001-abcdef' }), api('POST', '/api/buyer/checkout', body, cust, { 'Idempotency-Key': 'tap-0001-abcdef' })]);
  const c = await api('POST', '/api/buyer/checkout', body, cust, { 'Idempotency-Key': 'tap-0001-abcdef' });
  assert.strictEqual(a.body.id, b.body.id); assert.strictEqual(a.body.id, c.body.id);
  assert.strictEqual(db.orders.all().length, before + 1, 'one order');
  const other = await api('POST', '/api/buyer/checkout', { ...body, items: [{ ...body.items[0], qty: 2 }] }, cust, { 'Idempotency-Key': 'tap-0001-abcdef' });
  assert.strictEqual(other.status, 409, 'same key, different cart');
  const someoneElse = await customer('idem2@x.com');
  const d = await api('POST', '/api/buyer/checkout', body, someoneElse, { 'Idempotency-Key': 'tap-0001-abcdef' });
  assert.notStrictEqual(d.body.id, a.body.id, 'keys are per customer');
  assert.strictEqual((await api('POST', '/api/buyer/checkout', body, cust, { 'Idempotency-Key': 'bad key!' })).status, 400);
  const plain = await api('POST', '/api/buyer/checkout', body, cust);
  assert.notStrictEqual(plain.body.id, a.body.id, 'no key: a new order as before');
});

test('a webhook whose work failed runs again on the next delivery; the hourly check finds missed payments', async () => {
  await shopWithProducts();
  const cust = await customer('hook@x.com');
  const sku = (await api('GET', `/api/catalog/${product2.id}`)).body.skus[1].mp_sku_id;
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: product2.id, mp_sku_id: sku, qty: 1 }], shipping_address: addr }, cust)).body;
  const pi = intents[db.orders.get(o.id).payment.intent_id]; succeed(pi.id);
  const real = orders.stripePaid; let calls = 0;
  orders.stripePaid = async (x) => { calls++; if (calls === 1) throw new Error('database busy'); return real(x); };
  try {
    assert.strictEqual((await hook(pi, 'evt_retry_1')).status, 200);
    await wait(50);
    assert.strictEqual(db.orders.get(o.id).status, 'pending_payment', 'first try failed');
    assert.strictEqual(db.inbox.get('msg_st_evt_retry_1').processed, false, 'not marked done');
    await hook(pi, 'evt_retry_1'); // Stripe delivers the same event again
    await wait(50);
    assert.notStrictEqual(db.orders.get(o.id).status, 'pending_payment', 'paid on the retry');
    assert.strictEqual(db.inbox.get('msg_st_evt_retry_1').processed, true);
    assert.strictEqual((await hook(pi, 'evt_retry_1')).body, 'dup');
  } finally { orders.stripePaid = real; }

  // no webhook at all: the hourly check marks the order paid
  const o2 = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: product2.id, mp_sku_id: sku, qty: 1 }], shipping_address: addr }, cust)).body;
  succeed(db.orders.get(o2.id).payment.intent_id);
  assert.strictEqual(await webhooks.checkUnpaidCards(), 0, 'too new to check');
  db.orders.update(o2.id, { created_at: Date.now() - 20 * 60e3 });
  assert.strictEqual(await webhooks.checkUnpaidCards(), 1);
  assert.notStrictEqual(db.orders.get(o2.id).status, 'pending_payment');
  assert.strictEqual(await webhooks.checkUnpaidCards(), 0, 'nothing left');
});

test('phone sign-in gives the app a token', async () => {
  const s = await api('POST', '/api/auth/phone/start', { phone: '+356 7912 3456' });
  assert.strictEqual(s.status, 200, JSON.stringify(s.body));
  const code = sms.at(-1).content.match(/\d{6}/)[0];
  const v = await api('POST', '/api/auth/phone/verify', { phone: '+356 7912 3456', code, name: 'Maria' });
  assert.strictEqual(v.status, 200);
  assert.ok(v.body.token, 'token in the body');
  assert.strictEqual((await api('GET', '/api/me', null, v.body.token)).body.name, 'Maria');
});

test('profile, language and password changes', async () => {
  const t1 = await customer('prof@x.com');
  const t2 = await login('prof@x.com', 'buyerpass1'); // a second phone
  assert.strictEqual((await api('PATCH', '/api/buyer/profile', { name: 'Ali K', lang: 'de' }, t1)).body.name, 'Ali K');
  assert.strictEqual(db.users.find((u) => u.email === 'prof@x.com').lang, 'de');
  assert.strictEqual((await api('PATCH', '/api/buyer/profile', { lang: 'xx' }, t1)).status, 400);
  await api('GET', '/api/me', null, t1, { 'X-Kinan-Lang': 'it' });
  assert.strictEqual(db.users.find((u) => u.email === 'prof@x.com').lang, 'it', 'app language header kept');
  assert.strictEqual((await api('POST', '/api/buyer/password', { current: 'wrong-one', password: 'newpass123' }, t1)).status, 401);
  assert.strictEqual((await api('POST', '/api/buyer/password', { current: 'buyerpass1', password: 'short' }, t1)).status, 400);
  assert.strictEqual((await api('POST', '/api/buyer/password', { current: 'buyerpass1', password: 'newpass123' }, t1)).status, 200);
  assert.strictEqual((await api('GET', '/api/me', null, t1)).status, 200, 'this phone stays signed in');
  assert.strictEqual((await api('GET', '/api/me', null, t2)).status, 401, 'the other phone is signed out');
  assert.ok(await login('prof@x.com', 'newpass123'));
});

test('account deletion: checks, then personal data is removed and orders are kept', async () => {
  await shopWithProducts();
  const t = await customer('del@x.com');
  const me = db.users.find((u) => u.email === 'del@x.com');
  db.users.update(me.id, { stripe_customer_id: 'cus_del1', stripe_customer_key: crypto.createHash('sha256').update('sk_test_x').digest('hex').slice(0, 16), addresses: [{ id: 'adr_aaaaaaaa', ...addr }] });
  const sku = (await api('GET', `/api/catalog/${product2.id}`)).body.skus[0].mp_sku_id;
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: product2.id, mp_sku_id: sku, qty: 1 }], shipping_address: addr }, t)).body;
  await api('PUT', '/api/buyer/cart', { items: [{ listing_id: product2.id, mp_sku_id: sku, qty: 1, title: 'Vase' }] }, t);
  await api('POST', `/api/buyer/wishlist/${product2.id}`, null, t);
  await api('POST', '/api/push/devices', { token: 'ExponentPushToken[delete-me-123456]', platform: 'ios' }, t);

  assert.strictEqual((await api('POST', '/api/buyer/account/delete', { password: 'buyerpass1' }, t)).status, 400, 'needs confirm');
  assert.strictEqual((await api('POST', '/api/buyer/account/delete', { password: 'nope', confirm: 'DELETE' }, t)).status, 401);
  // an order on its way blocks deletion
  db.orders.update(o.id, { status: 'procuring' });
  const blocked = await api('POST', '/api/buyer/account/delete', { password: 'buyerpass1', confirm: 'DELETE' }, t);
  assert.strictEqual(blocked.status, 409); assert.strictEqual(blocked.body.code, 'open_orders');
  assert.deepStrictEqual((await api('GET', '/api/buyer/account/delete', null, t)).body.open_orders, [o.id]);
  db.orders.update(o.id, { status: 'delivered' });
  // money in the wallet must be given up explicitly
  require('../src/services/shop').walletEntry(me.id, 5, 'Gift');
  const money = await api('POST', '/api/buyer/account/delete', { password: 'buyerpass1', confirm: 'DELETE' }, t);
  assert.strictEqual(money.body.code, 'wallet_balance');
  const ok = await api('POST', '/api/buyer/account/delete', { password: 'buyerpass1', confirm: 'DELETE', forfeit_wallet: true }, t);
  assert.deepStrictEqual(ok.body, { deleted: true });

  assert.strictEqual((await api('GET', '/api/me', null, t)).status, 401, 'signed out');
  assert.strictEqual((await api('POST', '/api/auth/login', { email: 'del@x.com', password: 'buyerpass1', app: 'shop' })).status, 401, 'cannot sign in');
  const u = db.users.get(me.id);
  assert.strictEqual(u.status, 'deleted'); assert.strictEqual(u.name, ''); assert.ok(!u.pass && !u.addresses && !u.stripe_customer_id);
  assert.ok(!JSON.stringify(u).includes('del@x.com'));
  assert.deepStrictEqual(deletedCustomers, ['cus_del1'], 'saved cards removed at Stripe');
  assert.strictEqual(db.devices.all((d) => d.user_id === me.id).length, 0);
  assert.strictEqual(db.wishlist.all((w) => w.user_id === me.id).length, 0);
  assert.strictEqual(db.carts.get(`crt_${me.id}`), undefined);
  assert.ok(db.orders.get(o.id), 'the order stays for the accounts');
  assert.strictEqual((await api('POST', '/api/auth/register', { role: 'buyer', email: 'del@x.com', password: 'buyerpass1', name: 'Again' })).status, 201, 'the email can be used again');

  // the owner's account cannot be deleted from the app
  const own = await login('boss@x.com', 'adminpass1');
  assert.strictEqual((await api('POST', '/api/buyer/account/delete', { password: 'adminpass1', confirm: 'DELETE' }, own)).status, 403);
});

test('a social or phone account confirms deletion with a fresh sign-in', async () => {
  const s = await api('POST', '/api/auth/phone/start', { phone: '+356 7912 9999' });
  assert.strictEqual(s.status, 200);
  const code = sms.at(-1).content.match(/\d{6}/)[0];
  const v = (await api('POST', '/api/auth/phone/verify', { phone: '+356 7912 9999', code })).body;
  const sess = db.sessions.all((x) => x.user_id === v.user.id)[0];
  db.sessions.update(sess.id, { created_at: Date.now() - 60 * 60e3 });
  const old = await api('POST', '/api/buyer/account/delete', { confirm: 'DELETE' }, v.token);
  assert.strictEqual(old.status, 401); assert.strictEqual(old.body.code, 'reauth');
  db.sessions.update(sess.id, { created_at: Date.now() });
  assert.strictEqual((await api('POST', '/api/buyer/account/delete', { confirm: 'DELETE' }, v.token)).status, 200);
});

test('native push: devices register, receive notifications, and dead tokens are dropped', async () => {
  const t = await customer('push@x.com');
  const me = db.users.find((u) => u.email === 'push@x.com');
  assert.strictEqual((await api('POST', '/api/push/devices', { token: 'not-a-token' }, t)).status, 400);
  assert.strictEqual((await api('POST', '/api/push/devices', { token: 'ExponentPushToken[phone-one-12345]', platform: 'ios' }, t)).status, 200);
  assert.strictEqual((await api('POST', '/api/push/devices', { token: 'ExponentPushToken[Gone-phone-12345]', platform: 'android' }, t)).status, 200);
  assert.strictEqual((await api('POST', '/api/push/devices', { token: 'ExponentPushToken[phone-one-12345]', platform: 'ios' }, t)).status, 200, 'same phone again');
  assert.strictEqual(db.devices.all((d) => d.user_id === me.id).length, 2, 'no duplicates');
  expo.length = 0;
  push.toUser(me.id, { title: 'Your order has shipped', body: 'Track it in the app', url: '/#/orders/ord_1' });
  await wait(50);
  assert.deepStrictEqual(expo.map((m) => m.to).sort(), ['ExponentPushToken[Gone-phone-12345]', 'ExponentPushToken[phone-one-12345]']);
  assert.strictEqual(expo[0].data.url, '/#/orders/ord_1');
  assert.deepStrictEqual(db.devices.all((d) => d.user_id === me.id).map((d) => d.token), ['ExponentPushToken[phone-one-12345]'], 'unregistered token removed');
  // a phone that changes account moves with it
  const t2 = await customer('push2@x.com');
  await api('POST', '/api/push/devices', { token: 'ExponentPushToken[phone-one-12345]', platform: 'ios' }, t2);
  assert.strictEqual(db.devices.all((d) => d.user_id === me.id).length, 0);
  assert.strictEqual((await api('DELETE', '/api/push/devices', { token: 'ExponentPushToken[phone-one-12345]' }, t2)).status, 200);
  assert.strictEqual(db.devices.all((d) => d.token === 'ExponentPushToken[phone-one-12345]').length, 0, 'removed on sign-out');
});

test('the saved cart can be read back on another phone, with public ids', async () => {
  await shopWithProducts();
  const t = await customer('cart@x.com');
  const sku = (await api('GET', `/api/catalog/${product.id}`)).body.skus[0].mp_sku_id;
  await api('PUT', '/api/buyer/cart', { items: [{ listing_id: product.id, mp_sku_id: sku, qty: 3, title: 'Lamp' }] }, t);
  const me = db.users.find((u) => u.email === 'cart@x.com');
  assert.strictEqual(db.carts.get(`crt_${me.id}`).items[0].mp_sku_id, 'cj_998877', 'stored with the real id (cart emails)');
  const c = (await api('GET', '/api/buyer/cart', null, await login('cart@x.com', 'buyerpass1'))).body;
  assert.deepStrictEqual(c.items.map(({ listing_id, mp_sku_id, qty }) => ({ listing_id, mp_sku_id, qty })), [{ listing_id: product.id, mp_sku_id: sku, qty: 3 }]);
  assert.ok(c.changed_at);
});

test('measured delivery days are used for supplier-direct products', async () => {
  await shopWithProducts();
  db.listings.update(product2.id, (l) => ({ ...l, fulfillment: 'direct', sourcing: { gb_days: 7, gb_min: 4, eu_days: 12 } }));
  const gb = (await api('GET', `/api/catalog/${product2.id}/delivery?country=GB`)).body;
  assert.deepStrictEqual([gb.min_days, gb.max_days, gb.known, gb.basis], [4, 7, true, 'GB']);
  const mt = (await api('GET', `/api/catalog/${product2.id}/delivery?country=MT`)).body;
  assert.deepStrictEqual([mt.min_days, mt.max_days, mt.known, mt.basis], [12, 12, true, 'EU'], 'no measured fastest time: the measured time only');
  const sa = (await api('GET', `/api/catalog/${product2.id}/delivery?country=SA`)).body;
  assert.strictEqual(sa.known, false, 'not measured for this country: still an estimate');
});

test('parcels shipped straight from a supplier carry a neutral state', () => {
  const pid = require('../src/services/publicIds');
  assert.strictEqual(pid.directState('AE_SHIPPED'), 'shipped');
  assert.strictEqual(pid.directState('AE_PAID'), 'preparing');
  assert.strictEqual(pid.directState('SOMETHING_NEW'), 'ordering');
});

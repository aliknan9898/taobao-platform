// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Coupons, referral reward, saved items alerts, reviews, cart reminders. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grow-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', REFERRAL_REWARD: '5' });
delete process.env.STRIPE_SECRET_KEY;

const auth = require('../src/auth');
const db = require('../src/db');
const growth = require('../src/services/growth');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); growth.ensureWelcome(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j, headers: res.headers };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('growth features', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 's@x.com', password: 'sellerpass', shop_name: 'S' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active' }, boss);
  const sel = await login('s@x.com', 'sellerpass');
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Lamp', category: 'home', weight_kg: 0.5, images: [PNG], variants: [{ name: 'One', price: 50, stock: 5 }] }, sel)).body;
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);

  // referral: A invites B
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'a@x.com', password: 'buyerpass1', name: 'Amal' });
  const a = await login('a@x.com', 'buyerpass1');
  const ref = (await api('GET', '/api/buyer/referral', null, a)).body;
  assert.match(ref.link, /\?ref=[A-Z0-9]{5,6}$/);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'b@x.com', password: 'buyerpass1', name: 'Badr' });
  const b = await login('b@x.com', 'buyerpass1');
  await api('GET', '/api/me', null, b, { Cookie: `kinan_ref=${ref.code}` });
  assert.strictEqual(db.users.find((u) => u.email === 'b@x.com').referred_by, db.users.find((u) => u.email === 'a@x.com').id);

  // coupon: WELCOME10 on first order (10% of 50 = 5)
  assert.strictEqual((await api('POST', '/api/buyer/coupon', { code: 'welcome10', subtotal: 50 }, b)).body.discount, 5);
  assert.strictEqual((await api('POST', '/api/buyer/coupon', { code: 'NOPE', subtotal: 50 }, b)).status, 400);
  const addr = { name: 'B', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' };
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 1 }], shipping_address: addr, coupon: 'WELCOME10' }, b)).body;
  assert.strictEqual(o.discount, 5); assert.strictEqual(o.total, 50 + o.shipping_fee - 5);
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, b);
  assert.strictEqual(db.ledger.find((l) => l.order_id === o.id).gross, 50, 'seller paid full price');
  assert.match((await api('POST', '/api/buyer/coupon', { code: 'WELCOME10', subtotal: 50 }, b)).body.error, /already used|first order/);
  // admin code
  assert.ok((await api('POST', '/api/admin/coupons', { code: 'EID5', kind: 'fixed', value: 5, min_subtotal: 40 }, boss)).status < 300);
  assert.match((await api('POST', '/api/buyer/coupon', { code: 'EID5', subtotal: 20 }, a)).body.error, /Spend at least/);

  // delivered → review + referral reward
  db.orders.update(o.id, { status: 'delivered' });
  assert.ok((await api('POST', `/api/buyer/orders/${o.id}/reviews`, { listing_id: p.id, rating: 4, text: 'Nice', photos: [PNG] }, b)).status < 300);
  assert.strictEqual((await api('POST', `/api/buyer/orders/${o.id}/reviews`, { listing_id: p.id, rating: 5 }, b)).status, 409);
  const rv = (await api('GET', `/api/catalog/${p.id}/reviews`)).body;
  assert.strictEqual(rv.average, 4); assert.strictEqual((await api('GET', rv.reviews[0].photos[0])).status, 200);
  assert.strictEqual((await api('GET', `/api/catalog/${p.id}`)).body.rating, 4);
  growth.payReferrals();
  assert.strictEqual((await api('GET', '/api/buyer/wallet', null, a)).body.balance, 5);
  growth.payReferrals();
  assert.strictEqual((await api('GET', '/api/buyer/wallet', null, a)).body.balance, 5, 'paid once');

  // saved item: price drop email
  await api('POST', `/api/buyer/wishlist/${p.id}`, null, a);
  assert.strictEqual((await api('GET', '/api/buyer/wishlist', null, a)).body.length, 1);
  db.listings.update(p.id, (l) => ({ ...l, skus: l.skus.map((s) => ({ ...s, price: 40 })) }));
  assert.strictEqual(growth.wishlistAlerts(), 1);
  assert.strictEqual(growth.wishlistAlerts(), 0, 'not twice for the same price');

  // cart reminder after 24h
  await api('PUT', '/api/buyer/cart', { items: [{ listing_id: p.id, mp_sku_id: 'x', qty: 1, title: 'Lamp' }] }, a);
  assert.strictEqual(growth.cartReminders(), 0, 'too early');
  assert.strictEqual(growth.cartReminders(Date.now() + 25 * 3600e3), 1);
  assert.strictEqual(growth.cartReminders(Date.now() + 26 * 3600e3), 0);
});

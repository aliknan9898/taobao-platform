// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Packing options, storage + one box for several orders (shipping saving to wallet), check photos. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whp-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', PACKAGING_PROTECT_FEE: '2' });
delete process.env.STRIPE_SECRET_KEY;

const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j, headers: res.headers };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Pretend the warehouse received every item of an order. */
function arrive(orderId) {
  const o = db.orders.get(orderId);
  db.orders.update(o.id, { status: 'ready_to_ship', sub_orders: o.lines.map((l) => ({ seller_id: l.seller_id, status: 'WAIT_BUYER_CONFIRM_GOODS', manual: true })) });
  db.parcels.insert({ order_id: o.id, tracking: `T${o.id}`, status: 'received', weight_g: 500 });
}

test('packing, storage, combined box and photos', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 's@x.com', password: 'sellerpass', shop_name: 'S' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('s@x.com', 'sellerpass');
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Mug', category: 'home', weight_kg: 0.5, images: [PNG], variants: [{ name: 'One', price: 10, stock: 50 }] }, sel)).body;
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'C' });
  const cust = await login('c@x.com', 'buyerpass1');
  const addr = { name: 'C', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' };
  const buy = async (extra) => (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 1 }], shipping_address: addr, ...extra }, cust)).body;

  const o1 = await buy({ packaging: 'protect', hold: true });
  assert.strictEqual(o1.packaging_fee, 2); assert.strictEqual(o1.total, o1.subtotal + o1.shipping_fee + 2); assert.strictEqual(o1.hold, true);
  assert.strictEqual((await api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 1 }], shipping_address: addr, packaging: 'gold' }, cust)).status, 400);
  const o2 = await buy({ hold: true });
  for (const o of [o1, o2]) { await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, cust); arrive(o.id); }

  // Warehouse staff
  await api('POST', '/api/admin/staff', { name: 'w', email: 'w@x.com', password: 'staffpass1', role: 'warehouse' }, boss);
  const wh = await login('w@x.com', 'staffpass1');
  const ship = (id, body) => api('POST', `/api/warehouse/orders/${id}/ship`, { carrier: 'DHL Express', tracking: 'TRK1', weight_g: 1000, ...body }, wh);
  assert.match((await ship(o1.id)).body.error, /store it/);

  // photos → customer reports problem → blocked until resolved
  assert.strictEqual((await api('POST', `/api/warehouse/orders/${o1.id}/qc-photos`, { images: [PNG, PNG] }, wh)).body.photos, 2);
  const img = await api('GET', `/api/buyer/orders/${o1.id}/qc/1`, null, cust);
  assert.strictEqual(img.status, 200); assert.strictEqual(img.headers.get('content-type'), 'image/png');
  const other = (await api('POST', '/api/auth/register', { role: 'buyer', email: 'z@x.com', password: 'buyerpass1', name: 'Z' }), await login('z@x.com', 'buyerpass1'));
  assert.strictEqual((await api('GET', `/api/buyer/orders/${o1.id}/qc/0`, null, other)).status, 404);
  await api('POST', `/api/buyer/orders/${o1.id}/qc`, { ok: false, note: 'Wrong colour' }, cust);

  const rel = (await api('POST', '/api/buyer/ship-stored', null, cust)).body;
  assert.strictEqual(rel.released, 2);
  const ov = (await api('GET', '/api/warehouse/overview', null, wh)).body.orders.find((x) => x.id === o1.id);
  assert.deepStrictEqual(ov.combine_with, [o2.id]);
  assert.match((await ship(o1.id, { with: [o2.id] })).body.error, /problem/);
  await api('POST', `/api/admin/orders/${o1.id}/qc-resolved`, { note: 'Customer OK with colour' }, boss);

  // one box for both: paid 2× shipping, one combined price → saving to wallet
  const paid = db.orders.get(o1.id).shipping_fee + db.orders.get(o2.id).shipping_fee;
  const s = (await ship(o1.id, { with: [o2.id] })).body;
  assert.deepStrictEqual(s.order_ids, [o1.id, o2.id]);
  assert.strictEqual(db.orders.get(o2.id).status, 'shipped');
  const actual = require('../src/services/shipping').priceFor(1, 'SA').fee;
  const w = (await api('GET', '/api/buyer/wallet', null, cust)).body;
  assert.strictEqual(w.balance, Math.round((paid - actual) * 100) / 100);
  // delivering one delivers the box
  await api('POST', `/api/warehouse/orders/${o1.id}/delivered`, null, wh);
  assert.strictEqual(db.orders.get(o2.id).status, 'delivered');
});

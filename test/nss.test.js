// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* NextSmartShip: product registration, order with the customer's address, stock → fulfilment, webhook → shipped. API mocked. */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', NSS_CLIENT_ID: 'cid_x', NSS_CLIENT_SECRET: 'csec_y' });
delete process.env.STRIPE_SECRET_KEY;

const realFetch = global.fetch; const calls = []; let stock = 0; let nssStatus = 'open';
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  const ok = (j, status = 200) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j) });
  const p = u.pathname.replace('/api/2026-07-01', ''); const body = opts.body && typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : null;
  calls.push(`${opts.method || 'GET'} ${p}`);
  if (p === '/oauth/token') return ok({ access_token: 'T', expires_in: 86400, token_type: 'Bearer' });
  assert.strictEqual(opts.headers.Authorization, 'Bearer T');
  if (p === '/products' && opts.method === 'POST') {
    assert.match(body.sku, /^KN-[A-Za-z0-9]+-[0-9A-F]{8}$/); assert.match(body.barcode, /^KN[0-9A-F]{12}$/);
    assert.deepStrictEqual(body.customs.declared_values.map((d) => d.country), ['US', 'OTHER']); assert.match(body.customs.hs_code, /^[0-9.]{6,16}$/);
    return ok({ success: true, data: { product_id: 501, sku: body.sku } }, 201);
  }
  if (p === '/orders' && opts.method === 'POST') {
    assert.strictEqual(body.recipient.first_name, 'Sara'); assert.strictEqual(body.recipient.last_name, 'Al Malki'); assert.strictEqual(body.recipient.country_code, 'GB'); assert.strictEqual(body.items[0].qty, 2);
    return ok({ success: true, data: { order_number: 'WK1' } }, 201);
  }
  if (p === '/inventory/501') return ok({ success: true, data: [{ product_id: 501, warehouse_id: 1, available_qty: stock, committed_qty: 0 }] });
  if (p === '/orders/WK1/shipping-options') return ok({ success: true, data: [{ route_id: 7, channel_id: 70, route_name_en: 'Express', estimated_fee: { total: 19, currency: 'USD' }, min_transit_days: 4, max_transit_days: 7 }, { route_id: 8, channel_id: 80, route_name_en: 'Economy', estimated_fee: { total: 9.5, currency: 'USD' }, min_transit_days: 10, max_transit_days: 18 }] });
  if (p === '/orders/WK1/fulfillments') { assert.deepStrictEqual(body, { route_id: 8, channel_id: 80 }); nssStatus = 'requested'; return ok({ success: true, data: { order_number: 'WK1', status: 'requested' } }, 202); }
  if (p === '/orders/WK1') return ok({ success: true, data: { order_number: 'WK1', status: nssStatus, hold_reason: '', packages: nssStatus === 'fulfilled' ? [{ nss_tracking_number: 'NSS123', nss_tracking_url: 'https://t.nss/NSS123', last_mile_courier: 'Royal Mail', last_mile_tracking_number: 'RM9', delivery_status: 'in_transit', ship_date: '2026-11-12T00:00:00Z' }] : [] } });
  if (p === '/orders/WK1/cancellations') return ok({ success: true, data: { cancellation_result: 'ok' } });
  throw new Error(`unexpected ${opts.method} ${p}`);
};

const auth = require('../src/auth');
const db = require('../src/db');
const nss = require('../src/services/nss');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token, headers = {}) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined || body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, body: j };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const PNG = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '../public/assets/icon-192.png')).toString('base64')}`;

test('NextSmartShip order: create → goods arrive → ships cheapest → webhook marks shipped', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 's@x.com', password: 'sellerpass', shop_name: 'S' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const st = await login('s@x.com', 'sellerpass');
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Cotton T-shirt', category: 'men', weight_kg: 0.3, images: [PNG], variants: [{ name: 'Black / L', price: 15, stock: 10, cost_cny: 30 }] }, st)).body;
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'Sara' });
  const ct = await login('c@x.com', 'buyerpass1');
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 2 }], shipping_address: { name: 'Sara Al Malki', phone: '+44 7700 900000', country_code: 'GB', city: 'London', line1: '10 High St', postal_code: 'E1 6AN' } }, ct)).body;
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, ct);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(db.orders.get(o.id).nss, undefined, 'test payments are never sent automatically');

  const r = await api('POST', `/api/admin/orders/${o.id}/nss`, { action: 'create', force: true }, boss);
  assert.strictEqual(r.status, 200); assert.strictEqual(db.orders.get(o.id).nss.order_number, 'WK1');
  const opts = (await api('POST', `/api/admin/orders/${o.id}/nss`, { action: 'options' }, boss)).body;
  assert.deepStrictEqual(opts.map((x) => x.name), ['Economy', 'Express'], 'cheapest first');

  // Goods not in the warehouse yet: nothing ships (test payment orders also wait for a person)
  await nss.tick(); assert.strictEqual(db.orders.get(o.id).nss.status, 'open');
  await nss.ship(o.id);
  assert.strictEqual(db.orders.get(o.id).nss.status, 'requested');

  // NSS ships → signed webhook → Kinan order shipped with tracking for the customer
  nssStatus = 'fulfilled';
  const raw = JSON.stringify({ topic: 'order.shipped', data: { order_number: 'WK1' } });
  assert.strictEqual((await api('POST', '/webhooks/nss', raw, null, { 'X-Nss-Signature': 'bad' })).status, 200);
  await new Promise((r2) => setTimeout(r2, 50)); assert.notStrictEqual(db.orders.get(o.id).status, 'shipped', 'unsigned call ignored');
  await api('POST', '/webhooks/nss', raw, null, { 'X-Nss-Signature': crypto.createHmac('sha256', 'csec_y').update(raw).digest('base64') });
  await new Promise((r2) => setTimeout(r2, 80));
  const done = db.orders.get(o.id);
  assert.strictEqual(done.status, 'shipped');
  const view = (await api('GET', `/api/buyer/orders/${o.id}`, null, ct)).body;
  assert.strictEqual(view.tracking.number, 'NSS123'); assert.strictEqual(view.tracking.url, 'https://t.nss/NSS123');
});

test('automatic: real payment creates the NSS order; stock arrival ships it', async () => {
  const o = db.orders.find((x) => x.nss);
  const { id, nss: _n, created_at, updated_at, ...rest } = o; void id; void _n; void created_at; void updated_at;
  const copy = db.orders.insert({ ...rest, status: 'procuring', shipment_id: null, payment: { provider: 'stripe', mode: 'live' } });
  nssStatus = 'open';
  await nss.onPaid(copy.id);
  assert.strictEqual(db.orders.get(copy.id).nss.order_number, 'WK1');
  stock = 5; await nss.tick();
  assert.strictEqual(db.orders.get(copy.id).nss.status, 'requested');
});

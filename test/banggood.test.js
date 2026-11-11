// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Banggood against a fake API: import with options + UK warehouse, shipping at checkout, order, status and tracking. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', BANGGOOD_APP_ID: 'app123456', BANGGOOD_APP_SECRET: 'sec', BANGGOOD_SANDBOX: '1', BANGGOOD_MIN_GAP_MS: '0' });
delete process.env.STRIPE_SECRET_KEY;

const calls = []; let tokens = 0; let orderState = 'Unpaid';
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'apibeta.banggood.com') return realFetch(url, opts);
  const q = Object.fromEntries(u.searchParams); const body = new URLSearchParams(opts.body || '');
  const ok = (j) => ({ ok: true, status: 200, json: async () => ({ code: 0, lang: 'en', ...j }) });
  calls.push({ path: u.pathname, q, body: Object.fromEntries(body) });
  if (u.pathname === '/getAccessToken') { tokens++; assert.strictEqual(q.app_id, 'app123456'); return ok({ access_token: `T${tokens}`, expires_in: 3600 }); }
  assert.ok(q.access_token || body.get('access_token'), 'token sent'); assert.strictEqual(q.apiTest || body.get('apiTest'), '1');
  if (u.pathname === '/product/getProductInfo') return ok({ product_name: 'LED Desk Lamp', description: '<p>Bright <b>lamp</b></p>', weight: '0.45',
    warehouse_list: [{ warehouse: 'CN', warehouse_price: 10 }, { warehouse: 'UK', warehouse_price: 14 }],
    poa_list: [{ option_id: 1, option_name: 'Color', option_values: [{ poa_id: '11', poa_name: 'White', poa_price: 0, large_image: 'https://img.bg/w.jpg' }, { poa_id: '12', poa: 'POA_BLACK', poa_name: 'Black', poa_price: 1 }] },
      { option_id: 2, option_name: 'Plug', option_values: [{ poa_id: '21', poa_name: 'UK', poa_price: 0 }] }],
    image_list: { large: '//img.bg/2.jpg', home: 'https://img.bg/small.jpg', view: 'https://img.bg/1.jpg' } });
  if (u.pathname === '/category/getCategoryList') return ok(q.page === '1' ? { page: 1, page_total: 2, cat_list: [{ cat_id: '1', cat_name: 'Home', parent_id: '0' }, { cat_id: '10', cat_name: 'Lighting', parent_id: '1' }] } : { page: 2, page_total: 2, cat_list: [{ cat_id: '100', cat_name: 'Desk Lamps', parent_id: '10' }] });
  if (u.pathname === '/product/getProductList') { assert.strictEqual(q.cat_id, '100'); return ok({ page: 1, page_total: 3, product_total: 41, product_list: [{ product_id: '1234567', product_name: 'LED Desk Lamp', img: 'https://img.bg/t.jpg' }] }); }
  if (u.pathname === '/product/getProductUpdateList') { assert.ok(Number(q.minutes) >= 30 && Number(q.minutes) <= 21600); return ok({ page: 1, page_total: 1, product_list: [{ product_id: 1234567, state: 2, modify_date: '2026-11-11 10:00:00' }, { product_id: 999, state: 1 }] }); }
  if (u.pathname === '/product/getLimitPriceBrand') return ok({ page: 1, page_total: 1, brand_list: [{ brand_id: '300000001', name: 'DIGOO' }] });
  if (u.pathname === '/product/getBrandLimitPriceList') { assert.strictEqual(q.brand_id, '300000001'); return ok({ page: 1, page_total: 1, product_list: [{ products_id: '1234567', sku: 'SKU1', poa: 'POA_BLACK', limit_price: '30.00' }] }); }
  if (u.pathname === '/product/Translate') { assert.strictEqual(q.lang, 'ar'); return { ok: true, status: 200, json: async () => ({ error: 0, TranslatedText: { product_name: 'مصباح مكتب LED', description: '<p>مصباح ساطع</p>' } }) }; }
  if (u.pathname === '/product/getProductPrice') { assert.strictEqual(q.warehouse, 'UK'); return ok({ productPrice: [{ poa_id: '21,11', price: 14.5 }] }); }
  if (u.pathname === '/product/getStocks') return ok({ stocks: [{ warehouse: 'UK', stock_list: [{ poa_id: '11,21', stock: 7, stock_msg: 'In stock' }, { poa_id: '12,21', stock: 0 }] }] });
  if (u.pathname === '/product/getShipments') { assert.strictEqual(q.country, 'malta'); return ok({ currency: 'USD', shipment_list: [{ shipmethod_code: 'ukpost_std', shipmethod_name: 'Standard', shipday: '4-7 business days', shipfee: '6.50' }, { shipmethod_code: 'dhl', shipmethod_name: 'DHL', shipday: '2-3 business days', shipfee: '19' }] }); }
  if (u.pathname === '/order/importOrder' && body.get('product_list[0][product_id]') === 'FAIL') return ok({ code: 1, success_total: 0, failure_total: 1, failure_list: [{ product_id: 'FAIL', error_desc: 'Error poa' }] });
  if (u.pathname === '/order/importOrder') {
    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(body.get('delivery_country'), 'malta'); assert.strictEqual(body.get('product_list[0][warehouse]'), 'UK');
    assert.strictEqual(body.get('product_list[0][shipmethod_code]'), 'ukpost_std'); assert.strictEqual(body.get('product_list[0][poa_id]'), '11,21');
    return ok({ sale_record_id: body.get('sale_record_id'), product_total: 1, success_total: 1, failure_total: 0, failure_list: [] });
  }
  if (u.pathname === '/order/getOrderInfo') return ok({ sale_record_id_list: [{ sale_record_id: q.sale_record_id, order_list: [{ order_id: '9001', status: orderState, total_amount: '21.00' }] }] });
  if (u.pathname === '/order/getOrderHistory') { assert.strictEqual(q.order_id, '9001'); return ok({ track_number: orderState === 'Shipped' ? 'LX987654321GB' : '', order_history: [{ status: 'Payment Pending', date_add: '2026-11-11 10:00:00' }, ...(orderState === 'Shipped' ? [{ status: 'Shipped', date_add: '2026-11-12 09:00:00' }] : [])] }); }
  if (u.pathname === '/order/getTrackInfo') return ok({ track_info: orderState === 'Shipped' ? [{ event: 'Shipped with Royal Mail RR123456789GB', time: '2026-11-12 10:00:00' }] : [] });
  throw new Error(`unexpected ${u.pathname}`);
};

const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;

test('Banggood: import, checkout shipping, order, paid by hand, tracking', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  assert.strictEqual((await api('GET', '/api/config/public')).body.banggood, true);
  const pv = await api('POST', '/api/admin/banggood/preview', { ref: 'https://www.banggood.com/LED-Desk-Lamp-p-1234567.html' }, boss);
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.body));
  assert.strictEqual(pv.body.warehouse, 'UK', 'UK warehouse preferred');
  assert.strictEqual(pv.body.skus.length, 2);
  const white = pv.body.skus.find((s) => s.props === 'White / UK');
  assert.strictEqual(white.cost_sale, 14, 'warehouse price + option prices');
  assert.strictEqual(white.stock, 7);
  assert.strictEqual(pv.body.skus.find((s) => s.props === 'Black / UK').cost_sale, 15, 'warehouse price + option price');
  assert.deepStrictEqual(white.opts, [{ name: 'Color', value: 'White' }, { name: 'Plug', value: 'UK' }]);
  assert.strictEqual(pv.body.description, 'Bright lamp');
  assert.deepStrictEqual(pv.body.images, ['https://img.bg/2.jpg', 'https://img.bg/1.jpg'], 'large first, no thumbnails');

  const l = (await api('POST', '/api/admin/banggood/import', { ref: '1234567', category: 'home', prices: { [white.mp_sku_id]: 29 } }, boss)).body;
  assert.strictEqual(l.status, 'active'); assert.strictEqual(l.bg_warehouse, 'UK');
  assert.strictEqual(l.title_ar, 'مصباح مكتب LED', 'Arabic from Banggood'); assert.strictEqual(l.description_ar, 'مصباح ساطع');

  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'C' });
  const cust = await login('c@x.com', 'buyerpass1');
  const q = await api('POST', '/api/shipping/quote', { items: [{ listing_id: l.id, mp_sku_id: white.mp_sku_id, qty: 1 }], country_code: 'MT' });
  assert.strictEqual(q.body.banggood.fee, 6.5, 'cheapest Banggood method');
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: l.id, mp_sku_id: white.mp_sku_id, qty: 1 }], shipping_address: { name: 'C', phone: '+35679000000', country_code: 'MT', city: 'Valletta', line1: 'Triq 1', postal_code: 'VLT1000' } }, cust)).body;
  assert.strictEqual(o.shipping_fee >= 6.5, true);
  assert.strictEqual((await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, cust)).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  let sub = db.orders.get(o.id).sub_orders.find((s) => s.source === 'banggood');
  assert.strictEqual(sub.status, 'AE_PLACED', JSON.stringify(sub) + JSON.stringify(calls.map((c) => c.path)));
  assert.deepStrictEqual(sub.purchase_ids, ['9001']);

  // Paid by hand in the Banggood account
  const paid = await api('POST', `/api/admin/orders/${o.id}/aliexpress`, { outer_purchase_id: sub.outer_purchase_id, pay: true }, boss);
  assert.strictEqual(paid.status, 200, JSON.stringify(paid.body));
  orderState = 'Shipped';
  await require('../src/services/orders').syncSub(o.id, sub.outer_purchase_id);
  sub = db.orders.get(o.id).sub_orders.find((s) => s.source === 'banggood');
  assert.strictEqual(sub.status, 'AE_SHIPPED');
  assert.strictEqual(sub.logistics[0].tracking, 'LX987654321GB', 'tracking number from getOrderHistory');
  assert.strictEqual(tokens, 1, 'token reused');
  // Banggood stopped selling it: hourly update list marks it unavailable; unknown products are ignored
  assert.deepStrictEqual(await require('../src/services/banggood').updateTick(), { checked: 1 });
  assert.strictEqual(db.listings.get(l.id).status, 'unavailable');
});

test('Banggood: browse sub-categories and their products', async () => {
  const b = require('../src/services/banggood');
  assert.deepStrictEqual(await b.categories(), [{ id: '100', name: 'Home › Lighting › Desk Lamps' }]);
  const r = await b.listProducts({ cat_id: '100' });
  assert.deepStrictEqual([r.page_total, r.total, r.items[0].pid, r.items[0].image], [3, 41, '1234567', 'https://img.bg/t.jpg']);
  await assert.rejects(() => b.listProducts({ cat_id: 'x' }), /Choose a category/);
});

test('Banggood brand minimum prices: refused below, products below get paused', async () => {
  const b = require('../src/services/banggood');
  const sys = require('../src/services/buyforme').systemSeller();
  const before = db.listings.find((x) => x.source === 'banggood');
  const black = before.skus.find((x) => x.props.startsWith('Black'));
  db.listings.update(before.id, { status: 'active', skus: before.skus.map((x) => (x === black ? { ...x, price: 20 } : x)) });
  const r = await b.refreshLimits();
  assert.deepStrictEqual([r.brands, r.products, r.paused], [1, 1, 1]);
  assert.strictEqual(db.listings.get(before.id).status, 'paused');
  assert.strictEqual(b.limitFor('1234567', black), 30);
  assert.strictEqual(b.limitFor('1234567', before.skus.find((x) => x.props.startsWith('White'))), null, 'other options are free');
  await assert.rejects(() => b.publish(sys, { ref: '1234567', category: 'home', prices: { [black.mp_sku_id]: 25 } }), /minimum selling price of \$30\.00/);
});

test('Banggood country names and status mapping', () => {
  const b = require('../src/services/banggood');
  assert.strictEqual(b.countryName('GB'), 'united kingdom');
  assert.strictEqual(b.countryName('SY'), 'syrian arab republic');
  assert.strictEqual(b.countryName('CZ'), 'czech republic');
  assert.strictEqual(b.countryName('IR'), 'iran (islamic republic of)');
  assert.strictEqual(b.countryName('CI'), "cote d'ivoire");
  assert.strictEqual(b.countryName('PS'), null, 'not served by Banggood');
  assert.strictEqual(b.mapStatus('Unpaid'), 'AE_PLACED');
  assert.strictEqual(b.mapStatus('Payment Pending'), 'AE_PLACED');
  assert.strictEqual(b.mapStatus('Processing'), 'AE_PAID');
  assert.strictEqual(b.mapStatus('Cancelled'), 'AE_CANCELLED');
  assert.strictEqual(b.parseRef('https://www.banggood.com/x-p-1234567.html?rmmds=x'), '1234567');
});

test('Banggood: a refused product keeps the reason and a retry gets a new sale_record_id', async () => {
  const b = require('../src/services/banggood');
  const o = { id: 'ord_aaaabbbbccccdddd', shipping_address: { name: 'C', country_code: 'MT', city: 'Valletta', line1: 'x', phone: '1' }, payment: { provider: 'stripe', mode: 'live' } };
  const sub = { seller_id: 'sel_x1234', status: 'AE_TO_BUY' };
  const line = { listing_id: 'none', bg_pid: 'FAIL', bg_poa: '1', bg_warehouse: 'UK', qty: 1, mp_sku_id: 'm', title: 'Bad' };
  o.bg_shipping = { methods: [{ mp_sku_id: 'm', code: 'x' }] };
  await b.place(o, sub, [line]);
  assert.strictEqual(sub.status, 'AE_TO_BUY'); assert.match(sub.error, /Error poa/);
  await b.place(o, sub, [line]);
  const ids = calls.filter((c) => c.path === '/order/importOrder').map((c) => c.body.sale_record_id).slice(-2);
  assert.notStrictEqual(ids[0], ids[1]);
});

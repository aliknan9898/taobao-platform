// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Operations & growth: staff roles, reports, couriers, price alerts, share links. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
Object.assign(process.env, {
  ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example',
  DHL_API_KEY: 'k', DHL_API_SECRET: 's', DHL_ACCOUNT: '123456789', ARAMEX_USERNAME: 'u', ARAMEX_PASSWORD: 'p', ARAMEX_ACCOUNT: '111', ARAMEX_PIN: '222',
  WAREHOUSE_NAME: 'WH', WAREHOUSE_MOBILE: '138', WAREHOUSE_CITY: 'Guangzhou', WAREHOUSE_DETAIL: 'road 1'
});

// Mock couriers
const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  if (u.hostname === 'express.api.dhl.com') {
    calls.push(['dhl', u.pathname, opts.method || 'GET']);
    assert.strictEqual(opts.headers.Authorization, 'Basic ' + Buffer.from('k:s').toString('base64'));
    if (u.pathname.endsWith('/rates')) {
      assert.strictEqual(u.searchParams.get('destinationCountryCode'), 'SA');
      return ok({ products: [{ productName: 'EXPRESS WORLDWIDE', productCode: 'P', totalPrice: [{ currencyType: 'BILLC', price: 41.5, priceCurrency: 'USD' }], deliveryCapabilities: { estimatedDeliveryDateAndTime: '2026-11-14T23:59:00' } }] });
    }
    if (u.pathname.endsWith('/shipments')) {
      const b = JSON.parse(opts.body);
      assert.strictEqual(b.customerDetails.receiverDetails.postalAddress.countryCode, 'SA');
      assert.strictEqual(b.productCode, 'P');
      return ok({ shipmentTrackingNumber: '1234567890', documents: [{ typeCode: 'label', imageFormat: 'PDF', content: Buffer.from('%PDF-1.4 label').toString('base64') }], shipmentCharges: [{ currencyType: 'BILLC', price: 41.5 }] });
    }
  }
  if (u.hostname === 'ws.aramex.net') {
    calls.push(['aramex', u.pathname]);
    if (/CalculateRate/.test(u.pathname)) return ok({ HasErrors: false, TotalAmount: { CurrencyCode: 'USD', Value: 38 } });
  }
  return realFetch(url, opts);
};

const db = require('../src/db');
const auth = require('../src/auth');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j, headers: res.headers };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('operations and growth', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  // ---- staff roles ----
  for (const [role, email] of [['procurement', 'buy@x.com'], ['finance', 'fin@x.com'], ['support', 'sup@x.com'], ['warehouse', 'wh@x.com']]) {
    assert.strictEqual((await api('POST', '/api/admin/staff', { name: role, email, password: 'staffpass1', role }, boss)).status, 201);
  }
  assert.strictEqual((await api('POST', '/api/admin/staff', { name: 'x', email: 'x@x.com', password: 'staffpass1', role: 'buyer' }, boss)).status, 400);
  const [buy, fin, sup, wh] = await Promise.all(['buy', 'fin', 'sup', 'wh'].map((n) => login(`${n}@x.com`, 'staffpass1')));

  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('sel@x.com', 'sellerpass');
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Hiking backpack', description: 'Strong <b>30L</b> bag', category: 'sports', weight_kg: 1, images: [img], variants: [{ name: 'Black', price: 30, stock: 10, cost_cny: 72 }] }, sel)).body;
  assert.strictEqual((await api('POST', `/api/admin/listings/${p.id}/approve`, null, buy)).status, 403, 'procurement cannot approve products');
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);

  await api('POST', '/api/auth/register', { role: 'buyer', email: 'cust@x.com', password: 'buyerpass1', name: 'Sara' });
  const cust = await login('cust@x.com', 'buyerpass1');
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 2 }], shipping_address: { name: 'Sara', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' } }, cust)).body;
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, cust);

  // who can do what
  assert.strictEqual((await api('GET', '/api/admin/orders', null, sup)).status, 200, 'support sees orders');
  assert.strictEqual((await api('POST', `/api/admin/orders/${o.id}/manual-bought`, { tracking: 'T1' }, sup)).status, 403, 'support cannot buy');
  assert.strictEqual((await api('POST', `/api/admin/orders/${o.id}/cancel`, null, buy)).status, 403, 'procurement cannot refund');
  assert.strictEqual((await api('GET', '/api/admin/reports', null, buy)).status, 403);
  assert.strictEqual((await api('GET', '/api/admin/sellers', null, fin)).status, 403);
  assert.strictEqual((await api('GET', '/api/warehouse/overview', null, buy)).status, 403);
  assert.strictEqual((await api('GET', '/api/admin/overview', null, wh)).status, 403, 'warehouse staff only use the warehouse app');
  const users = (await api('GET', '/api/admin/users', null, sup)).body;
  assert.strictEqual((await api('POST', `/api/admin/users/${users.find((u) => u.email === 'boss@x.com').id}/reset-link`, null, sup)).status, 403, 'support cannot reset staff passwords');
  assert.strictEqual((await api('POST', `/api/admin/users/${users.find((u) => u.email === 'cust@x.com').id}/reset-link`, null, sup)).status, 200);

  // procurement buys, warehouse receives
  assert.strictEqual((await api('POST', `/api/admin/orders/${o.id}/manual-bought`, { taobao_order_no: '400', tracking: 'YT1' }, buy)).status, 200);
  await api('POST', '/api/warehouse/receive', { tracking: 'YT1', weight_g: 1900 }, wh);

  // ---- couriers ----
  const cs = (await api('GET', '/api/warehouse/couriers', null, wh)).body;
  assert.deepStrictEqual([cs.dhl, cs.aramex], [true, true]);
  const rates = (await api('POST', `/api/warehouse/orders/${o.id}/rates`, { weight_g: 1900, length_cm: 40, width_cm: 30, height_cm: 15 }, wh)).body;
  assert.deepStrictEqual(rates.rates.map((r) => [r.carrier, r.price]), [['aramex', 38], ['dhl', 41.5]], 'cheapest first');
  const lab = await api('POST', `/api/warehouse/orders/${o.id}/label`, { carrier: 'dhl', code: 'P', price: 41.5, weight_g: 1900 }, wh);
  assert.strictEqual(lab.status, 200, JSON.stringify(lab.body));
  assert.deepStrictEqual([lab.body.tracking, lab.body.cost, lab.body.carrier], ['1234567890', 41.5, 'DHL']);
  const pdf = await realFetch(`${base}/api/warehouse/shipments/${lab.body.id}/label`, { headers: { Authorization: `Bearer ${wh}` } });
  assert.deepStrictEqual([pdf.status, pdf.headers.get('content-type'), (await pdf.text()).slice(0, 8)], [200, 'application/pdf', '%PDF-1.4']);
  const bv = (await api('GET', `/api/buyer/orders/${o.id}`, null, cust)).body;
  assert.match(bv.tracking.url, /^https:\/\/www\.dhl\.com\/.*tracking-id=1234567890$/);
  assert.ok(!JSON.stringify((await api('GET', '/api/warehouse/overview', null, wh)).body).includes('JVBERi'), 'label PDFs are not sent with the overview');
  await api('POST', `/api/warehouse/orders/${o.id}/delivered`, null, wh);

  // ---- reports ----
  let rep = (await api('GET', '/api/admin/reports?days=30', null, fin)).body;
  assert.deepStrictEqual([rep.totals.orders, rep.test_orders], [0, 1], 'test payments left out by default');
  rep = (await api('GET', '/api/admin/reports?days=30&include_test=1', null, fin)).body;
  const t = rep.totals;
  // 2×30 = 60 + Gulf shipping 2 kg (8 + 3×3 = 17) = 77; seller: 60 − 6 commission − 20 goods (72¥/7.2 × 2) = 34; goods 20; courier 41.5
  assert.deepStrictEqual([t.revenue, t.shipping_charged, t.commission, t.seller_earnings, t.goods, t.courier], [77, 17, 6, 34, 20, 41.5]);
  assert.strictEqual(t.profit, Math.round((77 - 34 - 20 - 41.5 - t.customer_credits) * 100) / 100);
  assert.strictEqual(rep.best[0].qty, 2); assert.strictEqual(rep.sellers[0].shop, 'Atlas'); assert.strictEqual(rep.countries[0].country, 'Saudi Arabia');
  const csv = await realFetch(`${base}/api/admin/reports/orders.csv?days=30&include_test=1`, { headers: { Authorization: `Bearer ${fin}` } });
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="kinan-orders-/);
  const lines = (await csv.text()).trim().split('\r\n');
  assert.strictEqual(lines.length, 2); assert.match(lines[1], /cust@x\.com,Saudi Arabia,Atlas,2,60,17,77,20,41\.5,34,demo/);

  // ---- price alerts ----
  db.listings.update(p.id, (l) => ({ ...l, skus: l.skus.map((s) => ({ ...s, cost_cny: 250 })) })); // supplier price up: 250¥ ≈ 34.72 > 30
  const { checkMargins } = require('../src/services/catalog');
  checkMargins(db.listings.get(p.id));
  let mine = (await api('GET', '/api/seller/products', null, sel)).body.find((x) => x.id === p.id);
  assert.strictEqual(mine.price_alert.skus[0].cost, 34.72);
  assert.strictEqual(mine.status, 'active', 'manual Taobao items are flagged, not paused');
  assert.ok((await api('GET', '/api/admin/overview', null, boss)).body.alerts.some((a) => /cost more than their price/.test(a.text)));
  await api('PATCH', `/api/seller/products/${p.id}`, { prices: { [p.skus[0].mp_sku_id]: 45 } }, sel);
  mine = (await api('GET', '/api/seller/products', null, sel)).body.find((x) => x.id === p.id);
  assert.strictEqual(mine.price_alert, null, 'cleared once the price covers the cost');

  // ---- share links ----
  const sh = await realFetch(`${base}/p/${p.id}`);
  const html = await sh.text();
  assert.strictEqual(sh.status, 200);
  assert.match(html, /<meta property="og:title" content="Hiking backpack — 45\.00 USD">/);
  assert.match(html, new RegExp(`<meta property="og:image" content="https://kinan\\.example/img/l/${p.id}/0\\?v=\\w+">`));
  assert.match(html, /og:description" content="Sold by Atlas on Kinan Shop\. Strong 30L bag"/);
  assert.match(html, new RegExp(`history.replaceState\\(null,'','/#/p/${p.id}'\\)`));
  const shop = await (await realFetch(`${base}/s/${reg.seller_id}`)).text();
  assert.match(shop, /og:title" content="Atlas on Kinan Shop"/);
  assert.strictEqual((await realFetch(`${base}/p/lst_nope`)).status, 200, 'unknown product still opens the shop');
  assert.ok(!/og:title/.test(await (await realFetch(`${base}/p/lst_nope`)).text()));
});

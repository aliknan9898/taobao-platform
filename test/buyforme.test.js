// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Buy for me: link reading, estimate, quote, accept → private product → checkout, no seller ledger. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bfm-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', CNY_PER_SALE_UNIT: '7', BFM_FEE_PCT: '10', BFM_CHINA_SHIP_CNY: '14' });
delete process.env.STRIPE_SECRET_KEY;

const auth = require('../src/auth');
const db = require('../src/db');
const bfm = require('../src/services/buyforme');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;

test('link parsing', () => {
  const share = '【淘宝】https://e.tb.cn/h.jisQjW97U1je5Ty?tk=G4nC62ND6AY HU006 「【防溅水】战术加绒冲锋衣」点击链接直接打开';
  const p = bfm.parse(share);
  assert.strictEqual(p.platform, 'taobao'); assert.strictEqual(p.title, '【防溅水】战术加绒冲锋衣');
  assert.strictEqual(bfm.parse('https://item.taobao.com/item.htm?id=123456789').item_id, '123456789');
  assert.strictEqual(bfm.parse('https://detail.1688.com/offer/987654321.html').platform, '1688');
  assert.strictEqual(bfm.parse('https://www.aliexpress.com/item/1005006123456789.html').item_id, '1005006123456789');
  assert.throws(() => bfm.parse('https://amazon.com/dp/123'), /We buy from/);
});

test('buy for me end to end', async () => {
  const est = (await api('POST', '/api/buyforme/estimate', { price_cny: 140, qty: 2, country_code: 'SA' })).body;
  assert.strictEqual(est.items, 40); assert.strictEqual(est.china_shipping, 2); assert.strictEqual(est.service_fee, 4);
  assert.ok(est.international_shipping > 0 && est.total === Math.round((46 + est.international_shipping) * 100) / 100);

  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'C' });
  const cust = await login('c@x.com', 'buyerpass1');
  const boss = await login('boss@x.com', 'adminpass1');
  const r = (await api('POST', '/api/buyer/requests', { link: 'https://item.taobao.com/item.htm?id=555666777', price_cny: 140, qty: 2, variant: 'Black XL', country_code: 'SA' }, cust)).body;
  assert.strictEqual(r.platform_name, 'Taobao'); assert.ok(r.estimate.total > 0);
  assert.strictEqual((await api('POST', `/api/buyer/requests/${r.id}/accept`, null, cust)).status, 409, 'no price yet');
  await api('PATCH', `/api/admin/requests/${r.id}`, { status: 'quoted', quote: 24, title: 'Fleece jacket', weight_kg: 0.8 }, boss);
  const it = (await api('POST', `/api/buyer/requests/${r.id}/accept`, null, cust)).body;
  assert.strictEqual(it.price, 24); assert.strictEqual(it.qty, 2);
  // private: not in catalog, but open by link
  assert.ok(!(await api('GET', '/api/catalog')).body.items.some((x) => x.id === it.listing_id));
  assert.strictEqual((await api('GET', `/api/catalog/${it.listing_id}`)).status, 200);
  // someone else cannot buy it
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'd@x.com', password: 'buyerpass1', name: 'D' });
  const other = await login('d@x.com', 'buyerpass1');
  const addr = { name: 'C', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' };
  assert.strictEqual((await api('POST', '/api/buyer/checkout', { items: [{ listing_id: it.listing_id, mp_sku_id: it.mp_sku_id, qty: 2 }], shipping_address: addr }, other)).status, 409);
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: it.listing_id, mp_sku_id: it.mp_sku_id, qty: 2 }], shipping_address: addr }, cust)).body;
  assert.strictEqual(o.subtotal, 48);
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, cust);
  assert.strictEqual(db.ledger.all((l) => l.order_id === o.id).length, 0, 'Kinan’s own shop has no seller earnings');
  const line = db.orders.get(o.id).lines[0];
  assert.strictEqual(line.manual, true); assert.strictEqual(line.cost_cny, 140);
  assert.strictEqual((await api('GET', `/api/shops/${bfm.SYSTEM_SELLER}`)).status, 404);
});

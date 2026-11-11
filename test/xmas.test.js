// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Christmas Shop: CJ products from European warehouses, collection browse, CSV, per-warehouse shipping and CJ orders. CJ API is mocked. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xmas-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', CJ_API_KEY: 'CJ123@api@abcdef123456', CJ_MIN_GAP_MS: '0', XMAS_AUTO: '0', XMAS_WAREHOUSES: 'DE,GB' });
delete process.env.STRIPE_SECRET_KEY; delete process.env.ANTHROPIC_API_KEY;

const realFetch = global.fetch;
const created = []; const freight = [];
const ok = (data) => ({ status: 200, json: async () => ({ code: 200, result: true, message: 'Success', data }) });
const PRODUCTS = {
  P1: { name: 'New 2025 Christmas Tree Ornaments Christmas Ball Pendant Hot Sale Cross-border', cost: 3, wh: 'DE', desc: 'Product information: Material: Plastic Size: 6cm Colour: Red, Gold Packing list: 12 x balls' },
  P2: { name: 'Christmas LED Fairy String Lights', cost: 5, wh: 'DE', desc: 'Power supply: battery Length: 3 m' },
  P3: { name: 'Sexy Christmas costume', cost: 6, wh: 'DE', desc: '' },
  P4: { name: 'Christmas Nativity scene figurine', cost: 8, wh: 'DE', desc: '' },
  P5: { name: 'Christmas Sweater Reindeer Knit', cost: 12, wh: 'GB', desc: 'Material: Acrylic' },
  P6: { name: 'Plain office chair', cost: 30, wh: 'DE', desc: '' },
  P7: { name: 'Christmas Mug Santa', cost: 4, wh: 'DE', desc: '', noShip: true },
  CN1: { name: 'Desk lamp', cost: 6, wh: 'CN', desc: 'Lamp' }
};
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  const p = u.pathname.replace('/api2.0/v1', ''); const body = opts.body ? JSON.parse(opts.body) : null;
  if (p === '/authentication/getAccessToken') return ok({ openId: 777, accessToken: 'tok-1', accessTokenExpiryDate: new Date(Date.now() + 180 * 86400e3).toISOString(), refreshToken: 'ref-1', refreshTokenExpiryDate: new Date(Date.now() + 180 * 86400e3).toISOString() });
  if (p === '/product/listV2') {
    const cc = u.searchParams.get('countryCode');
    const items = Object.entries(PRODUCTS).filter(([, x]) => x.wh === cc).map(([id, x]) => ({ id, nameEn: x.name, sellPrice: String(x.cost), bigImage: `https://cf.cjdropshipping.com/${id}.jpg`, listedNum: 10 }));
    return ok({ content: [{ productList: items }] });
  }
  if (p === '/product/query') {
    const id = u.searchParams.get('pid'); const x = PRODUCTS[id]; const cc = u.searchParams.get('countryCode');
    if (!x || (cc && x.wh !== cc)) return { status: 200, json: async () => ({ code: 1602001, result: false, message: 'Product not found' }) };
    return ok({ pid: id, productNameEn: x.name, productSku: `SKU${id}`, bigImage: `https://cf.cjdropshipping.com/${id}.jpg`, productWeight: 200, description: `<p>${x.desc}</p>`, sellPrice: x.cost,
      variants: [{ vid: `${id}-V1`, variantSku: `${id}-1`, variantKey: 'Red', variantSellPrice: x.cost, inventories: [{ countryCode: 'CN', totalInventory: 900 }, { countryCode: x.wh, totalInventory: x.wh === 'CN' ? 900 : 40 }] }] });
  }
  if (p === '/logistic/freightCalculate') {
    freight.push(`${body.startCountryCode}>${body.endCountryCode}`);
    if (body.products.some((it) => it.vid.startsWith('P7'))) return ok([]);
    return ok(body.startCountryCode === 'CN' ? [{ logisticName: 'CJPacket', logisticPrice: 4, logisticAging: '10-20' }] : [{ logisticName: 'DHL Paket DE', logisticPrice: 3.5, logisticAging: '2-5' }]);
  }
  if (p === '/shopping/order/createOrderV2') { created.push(body); return ok({ orderId: `CJ${created.length}`, orderNumber: body.orderNumber, shipmentOrderId: `SH${created.length}`, orderAmount: 10, orderStatus: 'CREATED' }); }
  if (p === '/shopping/pay/payBalanceV2') return ok(null);
  if (p === '/shopping/pay/getBalance') return ok({ amount: 50 });
  if (p === '/shopping/order/getOrderDetail') return ok({ orderStatus: 'CREATED' });
  throw new Error(`unexpected ${p}`);
};

const auth = require('../src/auth');
const db = require('../src/db');
const cj = require('../src/services/cj');
const seasonal = require('../src/services/seasonal');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (e, pw) => (await api('POST', '/api/auth/login', { email: e, password: pw })).body.token;

test('title clean-up and facts', () => {
  assert.strictEqual(seasonal.cleanTitle(PRODUCTS.P1.name), 'Christmas Tree Ornaments Ball Pendant');
  assert.deepStrictEqual(seasonal.facts(PRODUCTS.P1.desc), ['Material: Plastic', 'Size: 6cm', 'Colour: Red, Gold', 'In the box: 12 x balls']);
});

test('Christmas import → collection → checkout splits CJ orders by warehouse', async () => {
  const st = await seasonal.importCollection('christmas', { count: 10 });
  assert.strictEqual(st.error, null);
  const m = seasonal.members('christmas');
  assert.deepStrictEqual(m.map((l) => l.cj_pid).sort(), ['P1', 'P2', 'P5'], 'unsuitable, non-Christmas and unshippable products are left out');
  assert.strictEqual(db.listings.all((l) => l.cj_pid === 'P7').length, 0, 'the mug with no shipping method was removed');
  const ball = m.find((l) => l.cj_pid === 'P1');
  assert.strictEqual(ball.cj_from, 'DE'); assert.strictEqual(ball.skus[0].stock, 40, 'only the German stock counts');
  assert.strictEqual(ball.title, 'Christmas Tree Ornaments Ball Pendant');
  assert.match(ball.description, /Material: Plastic/); assert.match(ball.description, /European warehouse/);
  assert.strictEqual(ball.skus[0].price, 5.99, '100% markup'); assert.strictEqual(ball.collection_group, 'decor');
  assert.strictEqual(m.find((l) => l.cj_pid === 'P5').cj_from, 'GB');
  assert.ok(freight.includes('DE>FR') && freight.includes('GB>GB'));

  // Shop: public config, collection browse, group filter
  const cfg = (await api('GET', '/api/config/public')).body;
  assert.strictEqual(cfg.collections[0].id, 'christmas'); assert.strictEqual(cfg.collections[0].count, 3);
  assert.strictEqual((await api('GET', '/api/catalog?collection=christmas')).body.total, 3);
  const lights = (await api('GET', '/api/catalog?collection=christmas&group=lights')).body;
  assert.strictEqual(lights.total, 1); assert.strictEqual(lights.items[0].ships_from, 'DE');
  assert.strictEqual((await api('GET', '/christmas')).status, 200);

  // Admin table + CSV
  const boss = await login('boss@x.com', 'adminpass1');
  const t = (await api('GET', '/api/admin/collections/christmas', null, boss)).body;
  assert.strictEqual(t.rows.length, 3); const r = t.rows.find((x) => x.cj_link.includes('P1'));
  assert.strictEqual(r.cost_usd, 3); assert.strictEqual(r.price_usd, 5.99); assert.strictEqual(r.margin_pct, 50); assert.strictEqual(r.warehouse, 'Germany');
  const csv = await (await realFetch(`${base}/api/admin/collections/christmas/export.csv`, { headers: { Authorization: `Bearer ${boss}` } })).text();
  assert.match(csv, /^\uFEFF?group,title,description,cost_usd/); assert.strictEqual(csv.trim().split('\n').filter((x) => /^(Decorations|Lights|Clothing),/.test(x)).length >= 2, true);

  // Coupon for the ads
  seasonal.ensureCoupon(); assert.ok(db.coupons.find((c) => c.code === 'XMAS10'));

  // A cart with a German-warehouse item and a China item: shipping per warehouse, two CJ orders
  const kinan = require('../src/services/buyforme').systemSeller();
  const lamp = await cj.publish(kinan, { ref: { pid: 'CN1' } });
  assert.strictEqual(lamp.cj_from, null);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'C' });
  const cust = await login('c@x.com', 'buyerpass1');
  const addr = { name: 'Max Muster', phone: '+4917', country_code: 'DE', city: 'Berlin', line1: 'Hauptstr 1', postal_code: '10115' };
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: ball.id, mp_sku_id: ball.skus[0].mp_sku_id, qty: 1 }, { listing_id: lamp.id, mp_sku_id: lamp.skus[0].mp_sku_id, qty: 1 }], shipping_address: addr }, cust)).body;
  assert.strictEqual(o.shipping_fee, 7.5, '3.50 from Germany + 4.00 from China');
  assert.deepStrictEqual(db.orders.get(o.id).cj_shipping.methods, { DE: 'DHL Paket DE', CN: 'CJPacket' });
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, cust);
  for (let i = 0; i < 50 && created.length < 2; i++) await new Promise((res) => setTimeout(res, 20));
  assert.deepStrictEqual(created.map((c) => [c.fromCountryCode, c.logisticName, c.products[0].vid]).sort(), [['CN', 'CJPacket', 'CN1-V1'], ['DE', 'DHL Paket DE', 'P1-V1']]);
  const subs = db.orders.get(o.id).sub_orders.filter((s) => s.source === 'cj');
  assert.strictEqual(subs.length, 2); assert.notStrictEqual(subs[0].outer_purchase_id, subs[1].outer_purchase_id);
});

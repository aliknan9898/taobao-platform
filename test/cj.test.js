// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* CJdropshipping: sign-in, import, checkout shipping, sandbox order + wallet payment, webhooks, cancel. CJ API is mocked. */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', CJ_API_KEY: 'CJ123@api@abcdef123456', CJ_MIN_GAP_MS: '0' });
delete process.env.STRIPE_SECRET_KEY;

const realFetch = global.fetch;
const calls = []; const created = []; let orderStatus = 'CREATED'; let payFails = false; let notFound = false;
const PID = '1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809';
const ok = (data) => ({ status: 200, json: async () => ({ code: 200, result: true, message: 'Success', data }) });
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  const p = u.pathname.replace('/api2.0/v1', ''); const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push(`${opts.method} ${p}`);
  if (p !== '/authentication/getAccessToken') assert.strictEqual(opts.headers['CJ-Access-Token'], 'tok-1');
  if (p === '/authentication/getAccessToken') { assert.strictEqual(body.apiKey, process.env.CJ_API_KEY); return ok({ openId: 777, accessToken: 'tok-1', accessTokenExpiryDate: new Date(Date.now() + 180 * 86400e3).toISOString(), refreshToken: 'ref-1', refreshTokenExpiryDate: new Date(Date.now() + 180 * 86400e3).toISOString() }); }
  if (p === '/product/query') return ok({ pid: PID, productNameEn: 'LED Desk Lamp', productSku: 'CJLED001', bigImage: 'https://cf.cjdropshipping.com/a.jpg', productImageSet: ['https://cf.cjdropshipping.com/a.jpg', 'https://cf.cjdropshipping.com/b.jpg'], productWeight: 450, productKeyEn: 'Color-Size', description: '<p>Bright <b>lamp</b></p>', sellPrice: 6.5,
    variants: [{ vid: 'V1', variantSku: 'CJLED001-W', variantKey: 'Sky blue-S', variantSellPrice: 6.5, inventories: [{ totalInventory: 120 }] }, { vid: 'V2', variantSku: 'CJLED001-B', variantKey: 'T-shirt black-XL', variantSellPrice: 7, inventories: [{ totalInventory: 0 }] }] });
  if (p === '/product/listV2' && u.searchParams.get('productFlag') === '0') { assert.strictEqual(u.searchParams.get('orderBy'), '1'); return ok({ content: [{ productList: [{ id: 'BAD1', nameEn: 'Sexy lingerie set', sellPrice: '3', bigImage: 'https://x/a.jpg' }, { id: 'EXP1', nameEn: 'Massage chair', sellPrice: '300', bigImage: 'https://x/a.jpg' }, { id: PID, nameEn: 'LED Desk Lamp', sellPrice: '6.5', bigImage: 'https://x/a.jpg', listedNum: 900 }] }] }); }
  if (p === '/product/listV2') return ok({ totalRecords: 1, content: [{ productList: [{ id: PID, nameEn: 'LED Desk Lamp', sku: 'CJLED001', bigImage: 'https://cf.cjdropshipping.com/a.jpg', sellPrice: '6.5', warehouseInventoryNum: 120 }] }] });
  if (p === '/logistic/freightCalculate') { assert.strictEqual(body.endCountryCode, 'DE'); return ok([{ logisticName: 'CJPacket Ordinary', logisticPrice: 4.2, logisticAging: '10-20' }, { logisticName: 'DHL', logisticPrice: 19, logisticAging: '3-6' }]); }
  if (p === '/shopping/order/createOrderV2') { created.push(body); return ok({ orderId: 'CJORD1', orderNumber: body.orderNumber, shipmentOrderId: 'SH1', orderAmount: 17.2, orderStatus: 'CREATED' }); }
  if (p === '/shopping/order/confirmOrder') { assert.strictEqual(opts.method, 'PATCH'); assert.strictEqual(body.orderId, 'CJORD1'); return ok('CJORD1'); }
  if (p === '/shopping/pay/payBalance') { assert.strictEqual(body.orderId, 'CJORD1'); orderStatus = 'PENDING'; return ok(null); }
  if (p === '/shopping/pay/payBalanceV2' && notFound) return { status: 200, json: async () => ({ code: 1603100, result: false, message: 'Order not found, please check the CJ order id' }) };
  if (p === '/shopping/pay/payBalanceV2') { assert.strictEqual(body.shipmentOrderId, 'SH1'); if (payFails) return { status: 200, json: async () => ({ code: 1600500, result: false, message: 'Insufficient balance' }) }; orderStatus = 'PENDING'; return ok(null); }
  if (p === '/shopping/order/getOrderDetail') return ok({ orderId: 'CJORD1', orderStatus, trackNumber: orderStatus === 'SHIPPED' ? 'YT123' : null, logisticName: 'CJPacket Ordinary' });
  if (p === '/shopping/order/deleteOrder') { assert.strictEqual(u.searchParams.get('orderId'), 'CJORD1'); return ok('CJORD1'); }
  if (p === '/shopping/pay/getBalance') return ok({ amount: 50, noWithdrawalAmount: 0, freezeAmount: 0 });
  if (p === '/webhook/set') { assert.deepStrictEqual(body.order.callbackUrls, ['https://kinan.example/webhooks/cj']); return ok(true); }
  throw new Error(`unexpected ${p}`);
};

const auth = require('../src/auth');
const db = require('../src/db');
const cj = require('../src/services/cj');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token, headers = {}) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined || body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const signed = (obj) => { const raw = JSON.stringify(obj); return { raw, sign: crypto.createHmac('sha256', '777').update(raw).digest('base64') }; };

test('link parsing', () => {
  assert.deepStrictEqual(cj.parseRef(`https://cjdropshipping.com/product/led-lamp-p-${PID}.html`), { pid: PID });
  assert.deepStrictEqual(cj.parseRef('cjled001'), { productSku: 'CJLED001' });
  assert.throws(() => cj.parseRef('hello world'), /CJdropshipping/);
});

test('CJ end to end: import → checkout → sandbox order paid → shipped → delivered', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const st = (await api('GET', '/api/admin/cj', null, boss)).body;
  assert.strictEqual(st.connected, true); assert.strictEqual(st.balance.amount, 50); assert.strictEqual(st.open_id, '777');

  const found = (await api('GET', '/api/cj/search?q=lamp', null, boss)).body;
  assert.strictEqual(found.items[0].pid, PID); assert.ok(found.items[0].suggested_price > 6.5);

  const pv = (await api('POST', '/api/admin/cj/preview', { ref: PID }, boss)).body;
  assert.strictEqual(pv.skus.length, 2); assert.strictEqual(pv.description, 'Bright lamp'); assert.strictEqual(pv.weight_kg, 0.45);
  const l = (await api('POST', '/api/admin/cj/import', { ref: PID, prices: { cj_V1: 15 } }, boss)).body;
  assert.strictEqual(l.status, 'active'); assert.strictEqual(l.fulfillment, 'direct'); assert.strictEqual(l.skus[0].price, 15); assert.strictEqual(l.skus[1].stock, 0);
  assert.strictEqual(l.skus[1].price, 9.99, '40% markup rounded to .99');
  // Options are grouped like on CJ: Color and Size
  const view = (await api('GET', `/api/catalog/${l.id}`)).body;
  assert.deepStrictEqual(view.option_groups.map((g) => [g.name, g.values.map((v) => v.value)]), [['Color', ['Sky blue', 'T-shirt black']], ['Size', ['S', 'XL']]]);
  assert.deepStrictEqual(view.skus[0].pick, ['Sky blue', 'S']);

  // Shipping quote and checkout use CJ's price to the customer's country (cheapest by default)
  const q = (await api('POST', '/api/shipping/quote', { items: [{ listing_id: l.id, mp_sku_id: 'cj_V1', qty: 1 }], country_code: 'DE' })).body;
  assert.strictEqual(q.fee, 4.2); assert.strictEqual(q.cj.method, 'CJPacket Ordinary');

  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'C' });
  const cust = await login('c@x.com', 'buyerpass1');
  const addr = { name: 'Max Muster', phone: '+4917', country_code: 'DE', city: 'Berlin', line1: 'Hauptstr 1', postal_code: '10115' };
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: l.id, mp_sku_id: 'cj_V1', qty: 1 }], shipping_address: addr }, cust)).body;
  assert.strictEqual(o.shipping_fee, 4.2); assert.strictEqual(o.total, 19.2);
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, cust);

  // Demo payment → CJ sandbox order with the customer's address, then paid from the CJ balance
  assert.strictEqual(created.length, 1);
  const c = created[0];
  assert.strictEqual(c.isSandbox, 1); assert.strictEqual(c.shippingCountryCode, 'DE'); assert.strictEqual(c.shippingCustomerName, 'Max Muster');
  assert.strictEqual(c.logisticName, 'CJPacket Ordinary'); assert.deepStrictEqual(c.products.map((x) => [x.vid, x.quantity]), [['V1', 1]]);
  let sub = db.orders.get(o.id).sub_orders[0];
  assert.strictEqual(sub.source, 'cj'); assert.strictEqual(sub.status, 'AE_PAID'); assert.strictEqual(sub.purchase_ids[0], 'CJORD1');
  assert.strictEqual(db.orders.get(o.id).status, 'procuring');

  const orders = (await api('GET', '/api/admin/cj/orders', null, boss)).body;
  assert.strictEqual(orders[0].parts[0].sandbox, true);

  // Webhooks: bad signature refused; order shipped; logistics delivered
  const bad = { messageId: 'bad', type: 'ORDER', params: { cjOrderId: 'CJORD1', orderStatus: 'CANCELLED' } };
  assert.strictEqual((await api('POST', '/webhooks/cj', JSON.stringify(bad), null, { sign: 'nope' })).status, 200, 'answered, but ignored');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(db.orders.get(o.id).sub_orders[0].status, 'AE_PAID', 'unsigned message changed nothing');
  let m = signed({ messageId: 'm1', type: 'ORDER', messageType: 'UPDATE', params: { cjOrderId: 'CJORD1', orderNumber: c.orderNumber, orderStatus: 'SHIPPED', logisticName: 'CJPacket Ordinary', trackNumber: 'YT123', trackingUrl: 'https://t.17track.net/en#nums=YT123' } });
  assert.strictEqual((await api('POST', '/webhooks/cj', m.raw, null, { sign: m.sign })).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  sub = db.orders.get(o.id).sub_orders[0];
  assert.strictEqual(sub.status, 'AE_SHIPPED'); assert.strictEqual(sub.logistics[0].tracking, 'YT123');
  assert.strictEqual(db.orders.get(o.id).status, 'shipped');
  m = signed({ messageId: 'm2', type: 'LOGISTIC', params: { orderId: 'CJORD1', trackingNumber: 'YT123', trackingStatus: 12 } });
  await api('POST', '/webhooks/cj', m.raw, null, { sign: m.sign });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(db.orders.get(o.id).status, 'delivered');
  const bv = (await api('GET', `/api/buyer/orders/${o.id}`, null, cust)).body;
  assert.strictEqual(bv.direct[0].tracking[0].number, 'YT123');

  // Stock webhook
  m = signed({ messageId: 'm3', type: 'STOCK', params: { V1: [{ storageNum: 3, countryCode: 'CN' }] } });
  await api('POST', '/webhooks/cj', m.raw, null, { sign: m.sign });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(db.listings.get(l.id).skus[0].stock, 3);
});

test('low CJ balance: order waits, admin pays later; unpaid CJ order is deleted on cancel', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const cust = await login('c@x.com', 'buyerpass1');
  const l = db.listings.find((x) => x.source === 'cj');
  db.listings.update(l.id, (x) => ({ ...x, skus: x.skus.map((s) => ({ ...s, stock: 50 })), last_synced_at: Date.now() }));
  const addr = { name: 'Max', phone: '+49', country_code: 'DE', city: 'Berlin', line1: 'Str 2' };
  payFails = true;
  const o1 = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: l.id, mp_sku_id: 'cj_V1', qty: 1 }], shipping_address: addr }, cust)).body;
  await api('POST', `/api/buyer/orders/${o1.id}/demo-pay`, null, cust);
  let sub = db.orders.get(o1.id).sub_orders[0];
  assert.strictEqual(sub.status, 'AE_PLACED'); assert.match(sub.error, /Top up/);
  assert.strictEqual(db.orders.get(o1.id).status, 'attention');
  payFails = false;
  const r = await api('POST', `/api/admin/orders/${o1.id}/aliexpress`, { outer_purchase_id: sub.outer_purchase_id, pay: true }, boss);
  assert.strictEqual(r.status, 200); sub = db.orders.get(o1.id).sub_orders[0];
  assert.strictEqual(sub.status, 'AE_PAID'); assert.strictEqual(sub.error, null);
  assert.ok(calls.some((x) => x === 'PATCH /shopping/order/confirmOrder'), 'the CJ order is confirmed before paying');

  // CJ cannot find the order by its shipment number ("Order not found"): it is paid by its order number instead
  notFound = true;
  const o3 = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: l.id, mp_sku_id: 'cj_V1', qty: 1 }], shipping_address: addr }, cust)).body;
  await api('POST', `/api/buyer/orders/${o3.id}/demo-pay`, null, cust);
  const s3 = db.orders.get(o3.id).sub_orders[0];
  assert.strictEqual(s3.status, 'AE_PAID', s3.error); assert.ok(calls.includes('POST /shopping/pay/payBalance'));
  notFound = false;

  payFails = true;
  const o2 = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: l.id, mp_sku_id: 'cj_V1', qty: 1 }], shipping_address: addr }, cust)).body;
  await api('POST', `/api/buyer/orders/${o2.id}/demo-pay`, null, cust);
  const before = calls.filter((x) => x.includes('deleteOrder')).length;
  assert.strictEqual((await api('POST', `/api/admin/orders/${o2.id}/cancel`, {}, boss)).status, 200);
  assert.strictEqual(calls.filter((x) => x.includes('deleteOrder')).length, before + 1);
  assert.strictEqual(db.orders.get(o2.id).status, 'refunded');
  payFails = false;
});

test('best sellers: adds trending CJ products to the Kinan shop, skipping unsuitable, too expensive and existing ones', async () => {
  for (const l of db.listings.all((x) => x.source === 'cj')) db.listings.remove(l.id);
  const st = await cj.importBestSellers({ count: 5 }, 'test');
  assert.strictEqual(st.added, 1); assert.ok(st.skipped >= 2);
  const l = db.listings.find((x) => x.cj_auto);
  assert.strictEqual(l.status, 'active'); assert.strictEqual(l.seller_id, 'sel_kinan'); assert.strictEqual(l.category, 'electronics');
  assert.strictEqual((await cj.importBestSellers({ count: 5 }, 'test')).added, 0, 'never added twice');
  assert.strictEqual(cj.guessCategory('Phone case for iPhone 15'), 'phone');
  assert.ok(cj.BLOCK.test('Tactical knife')); assert.ok(!cj.BLOCK.test('Kitchen knife sharpener stone'.replace('knife', 'blade')));
});

test('saving an address works out CJ shipping for the whole shop; the list then shows delivered prices', async () => {
  const l = db.listings.find((x) => x.source === 'cj' && x.status === 'active');
  db.listings.update(l.id, { cj_ship: null });
  let d = (await api('GET', '/api/catalog?country=DE')).body;
  const first = d.items.find((x) => x.id === l.id);
  assert.ok(first.ship_pending || first.delivered_price != null);
  await api('POST', '/api/shipping/prepare', { country_code: 'DE' });
  await new Promise((r) => setTimeout(r, 100));
  d = (await api('GET', '/api/catalog?country=DE')).body;
  const after = d.items.find((x) => x.id === l.id);
  assert.strictEqual(after.ship_fee, 4.2); assert.strictEqual(after.delivered_price, Math.round((after.min_price + 4.2) * 100) / 100);
  assert.strictEqual(db.listings.get(l.id).cj_ship.DE.fee, 4.2, 'kept on the product for next time');
});

test('CJ tracking: every new stage is kept with its events, shown to the shopper, and notified once', async () => {
  const buyer = db.users.find((u) => u.email === 'c@x.com');
  const o = db.orders.insert({ buyer_id: buyer.id, status: 'shipped', currency: 'usd', total: 5, lines: [{ line_no: '1', listing_id: 'x', title: 'Moon Necklace', qty: 1, price: 5, direct: true, source: 'cj' }],
    sub_orders: [{ outer_purchase_id: 'OPTRK', order_id: 'ord_trk', seller_id: 'sel_x', source: 'cj', direct: true, status: 'AE_SHIPPED', purchase_ids: ['CJTRK1'], line_nos: ['1'], logistics: [{ carrier: 'CJPacket', tracking: 'SD1' }] }] });
  const pushes = []; const push = require('../src/push'); const keep = push.toUser; push.toUser = (u, m) => pushes.push(m);
  try {
    const ev = (st, text, place, at) => ({ status: st, activity: text, location: place, eventTime: at, statusDesc: text });
    const msg = (id, stage, events) => cj.handleWebhook({ messageId: id, type: 'LOGISTIC', params: { orderId: 'CJTRK1', storeOrderNumbers: [], logisticName: 'CJPacket', trackingNumber: 'SD1', trackingStatus: stage, logisticsTrackEvents: JSON.stringify(events) } });
    const e1 = ev(5, 'Departed from China', 'Shenzhen', '2026-11-16 10:00:00');
    assert.strictEqual(msg('t1', 5, [e1]).stage, 5);
    assert.strictEqual(msg('t2', 5, [e1]).stage, undefined, 'same stage again: no second notice');
    const e2 = ev(6, 'Arrived at destination', 'Malta', '2026-11-20 08:00:00');
    assert.strictEqual(msg('t3', 6, [e1, e2]).stage, 6);
    assert.deepStrictEqual(pushes.map((p) => p.title), ['Your parcel is flying to your country', 'Your parcel arrived in your country']);
    assert.match(pushes[1].body, /Malta/);
    const sub = db.orders.get(o.id).sub_orders[0];
    assert.strictEqual(sub.track.status, 6); assert.strictEqual(sub.track.events[0].text, 'Arrived at destination', 'newest first');
    // a webhook repeated for an old stage after a newer one (out of order) does not notify again
    cj.handleWebhook({ messageId: 't4', type: 'LOGISTIC', params: { orderId: 'CJTRK1', trackingNumber: 'SD1', trackingStatus: 5, logisticsTrackEvents: '[]' } });
    cj.handleWebhook({ messageId: 't5', type: 'LOGISTIC', params: { orderId: 'CJTRK1', trackingNumber: 'SD1', trackingStatus: 6, logisticsTrackEvents: '[]' } });
    assert.strictEqual(pushes.length, 2, 'each stage is announced once per order');
    assert.ok(db.orders.get(o.id).sub_orders[0].track.events.length >= 2, 'events kept when an update has none');
  } finally { push.toUser = keep; }
});

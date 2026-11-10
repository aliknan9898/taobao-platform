'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
Object.assign(process.env, {
  TAOBAO_APP_KEY: 'appk', TAOBAO_APP_SECRET: 'apps', TAOBAO_API_URL: 'http://taobao.mock/rest',
  ADMIN_EMAIL: 'admin@x.com', ADMIN_PASSWORD: 'adminpass1', SHIPPING_FLAT_FEE: '8',
  WAREHOUSE_NAME: 'WH', WAREHOUSE_MOBILE: '138', WAREHOUSE_CITY: 'Guangzhou', WAREHOUSE_DETAIL: 'road 1'
});

const { signRequest, messageSignature } = require('../src/taobao/sign');
const stripe = require('../src/payments/stripe');
const auth = require('../src/auth');
const db = require('../src/db');
const webhooks = require('../src/webhooks');
const { server } = require('../src/server');

// ---------- mock Taobao API ----------
const tb = { calls: [], poStatus: 'WAIT_BUYER_P', logistics: [] };
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'taobao.mock') return realFetch(url, opts);
  const params = Object.fromEntries(new URLSearchParams(opts.body));
  const apiPath = u.pathname.replace('/rest', '');
  assert.strictEqual(signRequest(apiPath, params, 'apps'), params.sign, `bad signature on ${apiPath}`);
  tb.calls.push({ apiPath, params });
  const ok = (data) => ({ status: 200, text: async () => JSON.stringify({ code: '0', ...data }) });
  switch (apiPath) {
    case '/auth/token/create': return ok({ access_token: `AT_${params.code}`, refresh_token: 'RT', expires_in: 2592000, refresh_expires_in: 5184000, seller_id: `TB_${params.code}`, account: `${params.code}@dist.com` });
    case '/product/get':
      if (params.item_id === '999999999') return ok({ code: 'SYSTEM_ERROR', message: '未查到淘宝商品' });
      return ok({ data: params.item_id === '680001112223'
        ? { item_type: 'WITHOUT_MATERIAL', mp_id: 'MP2', title: 'Earbuds', pic_urls: ['https://x/should-not-appear.jpg'], sku_list: [{ mp_sku_id: 'S2', price: '36.00', quantity: 50 }] }
        : { item_type: 'HAVE_MATERIAL', mp_id: 'MP1', title: 'Backpack', pic_urls: ['https://img/1.jpg'], sku_list: [{ mp_sku_id: 'S1', properties: 'Black', price: '72.00', quantity: 200 }, { mp_sku_id: 'S1b', properties: 'Brown', price: '72.00', quantity: 0 }] } });
    case '/purchase/order/create': return ok({ data: { purchase_order_id: `PID_${params.access_token}` } });
    case '/purchase/orders/query': return ok({ data: { purchase_orders: [{ purchase_id: `PID_${params.access_token}`, status: tb.poStatus, pay_timeout_time: Date.now() + 3600e3, sub_purchase_orders: [{ sku_id: 'S1', logistic_orders: tb.logistics }] }] } });
    case '/purchase/order/batch/pay': return ok({ data: { will_pay_purchase_order_ids: params.purchase_order_ids, pay_failure_purchase_order_ids: '' } });
    default: return ok({});
  }
};

let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

async function api(method, p, body, token) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}
const login = async (email, password) => (await api('POST', '/api/auth/login', { email, password })).body.token;

test('stripe webhook signature', () => {
  const body = '{"id":"evt_1"}'; const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex');
  assert.ok(stripe.verifyWebhook(body, `t=${t},v1=${sig}`, 'whsec_x'));
  assert.ok(!stripe.verifyWebhook(body, `t=${t},v1=${sig}`, 'whsec_y'));
  assert.ok(!stripe.verifyWebhook(body, `t=${t - 1000},v1=${sig}`, 'whsec_x'));
});

test('full marketplace flow: seller → buyer → Taobao → warehouse → delivered', async () => {
  // Seller registers (pending), admin approves
  const reg = await api('POST', '/api/auth/register', { role: 'seller', email: 's1@x.com', password: 'sellerpass', shop_name: 'Shop One' });
  assert.strictEqual(reg.status, 201);
  const sTok = await login('s1@x.com', 'sellerpass');
  const aTok = await login('admin@x.com', 'adminpass1');
  assert.strictEqual((await api('GET', '/api/admin/overview', null, sTok)).status, 403, 'seller cannot see admin');

  // Not approved yet → cannot publish
  const sellerId = reg.body.seller_id;
  const conn = await api('GET', '/api/seller/taobao/connect?return_to=myseller://connected', null, sTok);
  const state = new URL(conn.body.url).searchParams.get('state');
  assert.strictEqual(new URL(conn.body.url).searchParams.get('client_id'), 'appk');
  // Taobao redirects back with code
  const cb = await realFetch(`${base}/oauth/callback?code=seller1&state=${state}`, { redirect: 'manual' });
  assert.strictEqual(cb.status, 302);
  assert.strictEqual(cb.headers.get('location'), 'myseller://connected');
  assert.strictEqual((await api('GET', '/api/seller/me', null, sTok)).body.taobao.connected, true);
  assert.strictEqual((await api('POST', '/api/seller/products', { link: '723456789012' }, sTok)).status, 403);
  assert.strictEqual((await api('PATCH', `/api/admin/sellers/${sellerId}`, { status: 'active', commission_pct: 10 }, aTok)).status, 200);

  // Seller imports by link and prices it
  const prev = await api('POST', '/api/seller/products/preview', { link: 'https://item.taobao.com/item.htm?id=723456789012' }, sTok);
  assert.strictEqual(prev.body.skus[0].suggested_price, 13); // 72 CNY / 7.2 * 1.3
  const pub = await api('POST', '/api/seller/products', { link: 'https://item.taobao.com/item.htm?id=723456789012', prices: { S1: 19.99 } }, sTok);
  assert.strictEqual(pub.status, 201);
  // WITHOUT_MATERIAL: no Taobao pictures copied
  const pub2 = await api('POST', '/api/seller/products', { link: 'https://world.taobao.com/item/680001112223.htm' }, sTok);
  assert.deepStrictEqual(pub2.body.images, []);
  // Removed product → friendly error
  assert.match((await api('POST', '/api/seller/products/preview', { link: '999999999' }, sTok)).body.error, /deleted/);

  // Admin approval gate: nothing is visible to buyers until approved
  assert.strictEqual(pub.body.status, 'pending_review');
  assert.strictEqual((await api('GET', '/api/catalog')).body.total, 0, 'unapproved products are hidden');
  assert.strictEqual((await api('GET', `/api/catalog/${pub.body.id}`)).status, 404);
  assert.strictEqual((await api('PATCH', `/api/seller/products/${pub.body.id}`, { status: 'active' }, sTok)).status, 409, 'seller cannot self-approve');
  assert.strictEqual((await api('POST', `/api/admin/listings/${pub.body.id}/approve`, null, sTok)).status, 403, 'seller cannot call admin approve');
  const queue = await api('GET', '/api/admin/listings?status=pending_review', null, aTok);
  assert.strictEqual(queue.body.length, 2);
  assert.strictEqual(queue.body.find((l) => l.id === pub.body.id).skus[0].margin_pct, 50); // (19.99 − 10) / 19.99
  assert.strictEqual((await api('POST', `/api/admin/listings/${pub2.body.id}/reject`, {}, aTok)).status, 400, 'reason required');
  await api('POST', `/api/admin/listings/${pub2.body.id}/reject`, { reason: 'Add your own photos' }, aTok);
  const mine = await api('GET', '/api/seller/products', null, sTok);
  assert.strictEqual(mine.body.find((l) => l.id === pub2.body.id).review.reason, 'Add your own photos');
  await api('POST', `/api/admin/listings/${pub.body.id}/approve`, null, aTok);
  await api('POST', `/api/admin/listings/${pub2.body.id}/approve`, null, aTok);
  // Price change keeps approval; seller can pause/resume approved products
  const rep = await api('POST', '/api/seller/products', { link: '723456789012', prices: { S1: 19.99 } }, sTok);
  assert.strictEqual(rep.body.status, 'active');
  assert.strictEqual((await api('PATCH', `/api/seller/products/${pub.body.id}`, { status: 'paused' }, sTok)).body.status, 'paused');
  assert.strictEqual((await api('PATCH', `/api/seller/products/${pub.body.id}`, { status: 'active' }, sTok)).body.status, 'active');
  // Changing the title sends it back to review
  const retitled = await api('POST', '/api/seller/products', { link: '680001112223', title: 'New name' }, sTok);
  assert.strictEqual(retitled.body.status, 'pending_review');
  assert.strictEqual((await api('GET', '/api/catalog')).body.total, 1);
  await api('POST', `/api/admin/listings/${pub2.body.id}/approve`, null, aTok);

  // Buyer browses (cost never exposed) and checks out
  const cat = await api('GET', '/api/catalog');
  assert.strictEqual(cat.body.total, 2);
  assert.ok(!JSON.stringify(cat.body).includes('cost_cny'));
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'b@x.com', password: 'buyerpass', name: 'Sara' });
  const bTok = await login('b@x.com', 'buyerpass');
  assert.strictEqual((await api('POST', '/api/buyer/checkout', { items: [{ listing_id: pub.body.id, mp_sku_id: 'S1b', qty: 1 }], shipping_address: { name: 'Sara', phone: '1', country: 'MT', city: 'Valletta', line1: 'St 1' } }, bTok)).status, 409, 'out-of-stock rejected');
  const co = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: pub.body.id, mp_sku_id: 'S1', qty: 2 }], shipping_address: { name: 'Sara', phone: '+356', country: 'Malta', city: 'Valletta', line1: 'Republic St 1' } }, bTok);
  assert.strictEqual(co.status, 201);
  assert.strictEqual(co.body.total, 47.98); // 2×19.99 + 8 shipping
  const orderId = co.body.id;

  // Pay (demo) → procurement on Taobao with the SELLER's token, shipped to warehouse, PANAMA_DG
  const paid = await api('POST', `/api/buyer/orders/${orderId}/demo-pay`, null, bTok);
  assert.strictEqual(paid.body.status, 'procuring');
  const create = tb.calls.find((c) => c.apiPath === '/purchase/order/create');
  assert.strictEqual(create.params.access_token, 'AT_seller1');
  const payload = JSON.parse(create.params.purchase_request_param);
  assert.strictEqual(payload.channel_order_type, 'PANAMA_DG');
  assert.strictEqual(payload.order_line_list[0].itemId, 'MP1');
  assert.strictEqual(payload.receiver.name, 'WH', 'buyer address is not shared with Taobao sellers');
  assert.ok(!create.params.purchase_request_param.includes('Valletta'));

  // Seller sees their sub-order (no buyer address), pays it from their account
  const so = await api('GET', '/api/seller/orders', null, sTok);
  assert.strictEqual(so.body[0].purchase.status, 'WAIT_BUYER_P');
  assert.ok(!JSON.stringify(so.body).includes('Valletta'));
  const pay = await api('POST', `/api/seller/orders/${orderId}/pay`, null, sTok);
  assert.deepStrictEqual(pay.body.submitted, ['PID_AT_seller1']);

  // Taobao ships → signed webhook → re-query → expected parcel appears
  tb.poStatus = 'WAIT_BUYER_CONFIRM_GOODS';
  tb.logistics = [{ logistic_company_name: 'SF', logistic_number: 'SF123456' }];
  const raw = JSON.stringify({ seller_id: 'TB_seller1', message_type: 3, data: { purchase_id: 'PID_AT_seller1', status: 'X' } });
  const hook = await realFetch(`${base}/webhooks/taobao`, { method: 'POST', headers: { Authorization: messageSignature(raw, 'appk', 'apps') }, body: raw });
  assert.strictEqual(hook.status, 200);
  const bad = await realFetch(`${base}/webhooks/taobao`, { method: 'POST', headers: { Authorization: 'nope' }, body: raw });
  assert.strictEqual(bad.status, 401);
  await webhooks.processInbox();
  assert.strictEqual(db.orders.get(orderId).status, 'awaiting_parcels');

  // Warehouse staff receives the parcel by scanning, then ships internationally
  await api('POST', '/api/admin/staff', { email: 'wh@x.com', password: 'whpass123', name: 'Ali', role: 'warehouse' }, aTok);
  const wTok = await login('wh@x.com', 'whpass123');
  assert.strictEqual((await api('GET', '/api/admin/overview', null, wTok)).status, 403);
  const ov = await api('GET', '/api/warehouse/overview', null, wTok);
  assert.strictEqual(ov.body.counts.expected, 1);
  assert.strictEqual((await api('POST', `/api/warehouse/orders/${orderId}/ship`, { carrier: 'DHL', tracking: 'X' }, wTok)).status, 409, 'cannot ship before receiving');
  const rec = await api('POST', '/api/warehouse/receive', { tracking: ' sf123456 ', location: 'A-01', weight_g: 1200 }, wTok);
  assert.strictEqual(rec.body.matched, true);
  assert.strictEqual(db.orders.get(orderId).status, 'ready_to_ship');
  const unknown = await api('POST', '/api/warehouse/receive', { tracking: 'YT999' }, wTok);
  assert.strictEqual(unknown.body.matched, false);
  const ship = await api('POST', `/api/warehouse/orders/${orderId}/ship`, { carrier: 'DHL', tracking: 'DHL777', weight_g: 1300 }, wTok);
  assert.strictEqual(ship.status, 200);

  // Buyer sees tracking; delivery makes the seller's net payable
  const bo = await api('GET', `/api/buyer/orders/${orderId}`, null, bTok);
  assert.strictEqual(bo.body.tracking.number, 'DHL777');
  assert.ok(!JSON.stringify(bo.body).includes('cost_cny'));
  await api('POST', `/api/warehouse/orders/${orderId}/delivered`, null, wTok);
  const earn = await api('GET', '/api/seller/earnings', null, sTok);
  assert.strictEqual(earn.body.payable, 35.98); // 39.98 − 10%
  const adm = await api('GET', '/api/admin/overview', null, aTok);
  assert.strictEqual(adm.body.kpis.commission_total, 4);

  // Other buyers can't see this order
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'b2@x.com', password: 'buyerpass' });
  const b2 = await login('b2@x.com', 'buyerpass');
  assert.strictEqual((await api('GET', `/api/buyer/orders/${orderId}`, null, b2)).status, 404);
});

test('auth rules', async () => {
  assert.strictEqual((await api('POST', '/api/auth/register', { role: 'admin', email: 'h@x.com', password: 'longenough' })).status, 400, 'cannot self-register as admin');
  assert.strictEqual((await api('POST', '/api/auth/login', { email: 'b@x.com', password: 'wrong' })).status, 401);
  assert.strictEqual((await api('GET', '/api/buyer/orders')).status, 401);
});

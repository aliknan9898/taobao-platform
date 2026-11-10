// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
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
  ALIEXPRESS_APP_KEY: 'aek', ALIEXPRESS_APP_SECRET: 'aes', GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com', ADMIN_GOOGLE_EMAILS: 'Boss@Gmail.com', GOOGLE_CLIENT_SECRET: 'gsecret',
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
const googleUsers = {}; let googleNonce = null;
const aeMock = { calls: [], status: 'PLACE_ORDER_SUCCESS' };
const tb = { calls: [], poStatus: 'WAIT_BUYER_P', logistics: [] };
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === 'oauth2.googleapis.com') {
    const params = Object.fromEntries(new URLSearchParams(opts.body));
    assert.strictEqual(params.client_secret, 'gsecret');
    const g = googleUsers[params.code];
    if (!g) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const idt = `${b64({ alg: 'RS256' })}.${b64({ iss: 'https://accounts.google.com', aud: 'gid.apps.googleusercontent.com', exp: Math.floor(Date.now() / 1000) + 3600, email_verified: true, ...g, nonce: g.nonce ?? googleNonce })}.sig`;
    return { ok: true, status: 200, json: async () => ({ id_token: idt, access_token: 'x' }) };
  }
  if (u.hostname === 'api-sg.aliexpress.com') {
    const params = Object.fromEntries(new URLSearchParams(opts.body));
    const aeSign = require('../src/aliexpress/client').sign;
    const path = u.pathname.startsWith('/rest') ? u.pathname.slice(5) : '';
    assert.strictEqual(aeSign(params, path), params.sign, `bad AliExpress signature ${path || params.method}`);
    aeMock.calls.push(params.method || path);
    const ok = (j) => ({ status: 200, text: async () => JSON.stringify(j) });
    if (path === '/auth/token/create') return ok({ code: '0', access_token: 'AE_AT', refresh_token: 'AE_RT', expires_in: 2592000, account: 'kinan@ae' });
    if (params.method === 'aliexpress.ds.product.get') return ok({ aliexpress_ds_product_get_response: { result: { ae_item_base_info_dto: { subject: 'Silicone phone case', product_id: 1005006000111, detail: '<p>Soft case</p>' }, ae_multimedia_info_dto: { image_urls: 'https://ae01.alicdn.com/a.jpg;https://ae01.alicdn.com/b.jpg' }, ae_item_sku_info_dtos: { ae_item_sku_info_d_t_o: [{ sku_id: '111', sku_attr: '14:200#Red', offer_sale_price: '3.20', sku_available_stock: 50, ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_value: 'Red' }] } }] } }, rsp_code: 200 } });
    if (params.method === 'aliexpress.ds.order.create') { aeMock.lastOrder = JSON.parse(params.param_place_order_request4_open_api_d_t_o); return ok({ aliexpress_ds_order_create_response: { result: { is_success: true, order_list: { number: [8123456789] } } } }); }
    if (params.method === 'aliexpress.trade.ds.order.get') return ok({ aliexpress_trade_ds_order_get_response: { result: { order_status: aeMock.status, logistics_info_list: aeMock.status === 'WAIT_BUYER_ACCEPT_GOODS' ? { aeop_order_logistics_info: [{ logistics_no: 'LP0001', logistics_service: 'CAINIAO' }] } : {} } } });
    return ok({ error_response: { code: 'InvalidApi', msg: 'unknown' } });
  }
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
  // Seller's own description (HTML stripped) also goes back to review, and is kept on later price edits
  const described = await api('POST', '/api/seller/products', { link: '723456789012', description: '<b>Waterproof</b> 30L backpack', prices: { S1: 19.99 } }, sTok);
  assert.strictEqual(described.body.status, 'pending_review');
  assert.strictEqual(described.body.description, 'Waterproof 30L backpack');
  await api('POST', `/api/admin/listings/${pub.body.id}/approve`, null, aTok);
  const repriced = await api('POST', '/api/seller/products', { link: '723456789012', prices: { S1: 19.99 } }, sTok);
  assert.strictEqual(repriced.body.status, 'active', 'unchanged description keeps approval');
  assert.strictEqual(repriced.body.description, 'Waterproof 30L backpack');

  // Buyer browses (cost never exposed) and checks out
  const cat = await api('GET', '/api/catalog');
  assert.strictEqual(cat.body.total, 2);
  assert.ok(!JSON.stringify(cat.body).includes('cost_cny'));
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'b@x.com', password: 'buyerpass', name: 'Sara' });
  const bTok = await login('b@x.com', 'buyerpass');
  assert.strictEqual((await api('POST', '/api/buyer/checkout', { items: [{ listing_id: pub.body.id, mp_sku_id: 'S1b', qty: 1 }], shipping_address: { name: 'Sara', phone: '1', country: 'MT', city: 'Valletta', line1: 'St 1' } }, bTok)).status, 409, 'out-of-stock rejected');
  const co = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: pub.body.id, mp_sku_id: 'S1', qty: 2 }], shipping_address: { name: 'Sara', phone: '+356', country: 'Malta', city: 'Valletta', line1: 'Republic St 1' } }, bTok);
  assert.strictEqual(co.status, 201);
  assert.strictEqual(co.body.total, 52.48); // 2×19.99 + Europe 1 kg (9 first 0.5 kg + 3.5 extra 0.5 kg)
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

test('Kinan Shop: store profiles, filters, item requests and wallet', async () => {
  tb.poStatus = 'WAIT_BUYER_P'; tb.logistics = [];
  const aTok = await login('admin@x.com', 'adminpass1');
  const sTok = await login('s1@x.com', 'sellerpass');
  // Seller edits the public profile in the Seller Center
  assert.strictEqual((await api('PATCH', '/api/seller/me', { logo: 'javascript:alert(1)' }, sTok)).status, 400);
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  const me = await api('PATCH', '/api/seller/me', { logo, description: 'Bags and travel gear', return_policy: 'Damaged items only, 7 days.' }, sTok);
  assert.strictEqual(me.body.description, 'Bags and travel gear');
  // ...and it shows up in Kinan Shop
  const shops = (await api('GET', '/api/shops')).body;
  const s1 = shops.find((x) => x.name === 'Shop One');
  assert.ok(s1 && s1.products >= 1 && /^\/img\/s\/sel_\w+\?v=\w+$/.test(s1.logo), 'logo served as a link, not inline data');
  const lg = await realFetch(base + s1.logo);
  assert.deepStrictEqual([lg.status, lg.headers.get('content-type')], [200, 'image/png']);
  assert.strictEqual(s1.return_policy, undefined, 'policy only on the shop page');
  assert.strictEqual((await api('GET', `/api/shops/${s1.id}`)).body.return_policy, 'Damaged items only, 7 days.');
  const cat = (await api('GET', '/api/catalog?sort=price_desc')).body;
  assert.ok(cat.items.every((p, i, a) => !i || a[i - 1].min_price >= p.min_price));
  assert.strictEqual(cat.items[0].shop.logo, s1.logo);
  assert.ok(cat.items.every((p) => !('cost_cny' in p.skus[0])), 'no cost in buyer view');
  assert.strictEqual((await api('GET', '/api/catalog?min_price=100000')).body.total, 0);
  assert.strictEqual((await api('GET', `/api/catalog/${cat.items[0].id}`)).body.return_policy, 'Damaged items only, 7 days.');

  // Buyer asks for an item that is not listed; admin answers
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'w1@x.com', password: 'buyerpass1', name: 'W' });
  const bTok = await login('w1@x.com', 'buyerpass1');
  assert.strictEqual((await api('POST', '/api/buyer/requests', { link: 'https://evil.example/x' }, bTok)).status, 400);
  const req = await api('POST', '/api/buyer/requests', { link: 'https://item.taobao.com/item.htm?id=611122233344', note: 'Blue, size M', qty: 2 }, bTok);
  assert.strictEqual(req.status, 201);
  assert.strictEqual((await api('GET', '/api/admin/requests', null, bTok)).status, 403);
  assert.ok((await api('GET', '/api/admin/overview', null, aTok)).body.alerts.some((a) => a.kind === 'requests'));
  await api('PATCH', `/api/admin/requests/${req.body.id}`, { status: 'quoted', quote: 24.5, reply: 'We can get it in 10 days' }, aTok);
  const mineReq = (await api('GET', '/api/buyer/requests', null, bTok)).body[0];
  assert.strictEqual(mineReq.quote, 24.5); assert.strictEqual(mineReq.status, 'quoted');

  // Wallet: admin credit → buyer pays an order from the wallet → cancel refunds to the wallet
  const users = (await api('GET', '/api/admin/users', null, aTok)).body;
  const buyer = users.find((u) => u.email === 'w1@x.com');
  assert.strictEqual(buyer.wallet, 0);
  assert.strictEqual((await api('POST', `/api/admin/wallet/${buyer.id}`, { amount: -5, reason: 'x' }, aTok)).status, 409, 'no negative balance');
  assert.strictEqual((await api('POST', `/api/admin/wallet/${buyer.id}`, { amount: 100 }, aTok)).status, 400, 'reason required');
  await api('POST', `/api/admin/wallet/${buyer.id}`, { amount: 100, reason: 'Shipping overpayment' }, aTok);
  const p = cat.items.find((x) => x.skus.some((k) => k.in_stock));
  const sku = p.skus.find((k) => k.in_stock);
  const order = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: sku.mp_sku_id, qty: 1 }], shipping_address: { name: 'W', phone: '1', country: 'Malta', city: 'Valletta', line1: 'St 1' } }, bTok)).body;
  const paid = await api('POST', `/api/buyer/orders/${order.id}/pay-wallet`, null, bTok);
  assert.strictEqual(paid.status, 200, JSON.stringify(paid.body));
  assert.notStrictEqual(paid.body.status, 'pending_payment');
  assert.strictEqual((await api('GET', '/api/buyer/wallet', null, bTok)).body.balance, Math.round((100 - order.total) * 100) / 100);
  assert.strictEqual((await api('POST', `/api/buyer/orders/${order.id}/pay-wallet`, null, bTok)).status, 409, 'no double payment');
  const cx = await api('POST', `/api/admin/orders/${order.id}/cancel`, null, aTok);
  assert.strictEqual(cx.status, 200, JSON.stringify(cx.body));
  assert.strictEqual((await api('GET', '/api/buyer/wallet', null, bTok)).body.balance, 100);
});


test('Continue with Google: shop and Seller Center', async () => {
  assert.strictEqual((await api('GET', '/api/config/public')).body.google_signin, true);
  const start = async (app, next = '') => {
    const r = await realFetch(`${base}/auth/google?app=${app}&next=${encodeURIComponent(next)}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.strictEqual(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.strictEqual(loc.searchParams.get('client_id'), 'gid.apps.googleusercontent.com');
    googleNonce = loc.searchParams.get('nonce');
    return loc.searchParams.get('state');
  };
  const back = (code, state) => realFetch(`${base}/auth/google/callback?code=${code}&state=${state}`, { redirect: 'manual' });
  const sid = (r) => decodeURIComponent((r.headers.get('set-cookie') || '').match(/sid=([^;]+)/)?.[1] || '');

  // New customer is created and signed in, then lands where they were going
  googleUsers.c1 = { sub: 'g-111', email: 'Gina@Gmail.com', name: 'Gina' };
  let st = await start('shop', '#/checkout');
  let r = await back('c1', st);
  assert.strictEqual(r.headers.get('location'), '/#/checkout');
  const tok = sid(r); assert.ok(tok);
  const me = (await api('GET', '/api/me', null, tok)).body;
  assert.deepStrictEqual([me.role, me.email], ['buyer', 'gina@gmail.com']);
  // State is single-use; replay fails
  r = await back('c1', st);
  assert.match(decodeURIComponent(r.headers.get('location')), /login_error=Sign-in link expired/);
  // Same Google account signs in again → same user; password login explains
  st = await start('shop'); r = await back('c1', st);
  assert.strictEqual((await api('GET', '/api/me', null, sid(r))).body.id, me.id);
  assert.match((await api('POST', '/api/auth/login', { email: 'gina@gmail.com', password: 'whatever1' })).body.error, /Google/);
  // Unsafe "next" is ignored
  st = await start('shop', 'https://evil.example'); r = await back('c1', st);
  assert.strictEqual(r.headers.get('location'), '/#/');
  // Wrong nonce is rejected
  googleUsers.bad = { sub: 'g-x', email: 'x@gmail.com', nonce: 'other' };
  st = await start('shop'); r = await back('bad', st);
  assert.match(decodeURIComponent(r.headers.get('location')), /^\/\?login_error=Google sign-in could not be verified/);
  // Unverified email rejected
  googleUsers.unv = { sub: 'g-u', email: 'u@gmail.com', email_verified: false };
  st = await start('shop'); r = await back('unv', st);
  assert.match(decodeURIComponent(r.headers.get('location')), /not verified/);

  // Existing seller (registered with a password) links Google by email
  st = await start('seller'); googleUsers.s = { sub: 'g-s1', email: 's1@x.com', name: 'S' };
  r = await back('s', st);
  assert.strictEqual(r.headers.get('location'), '/seller');
  assert.strictEqual((await api('GET', '/api/seller/me', null, sid(r))).body.shop_name, 'Shop One');
  // A customer Google account cannot open the Seller Center, errors go back to /seller
  st = await start('seller'); r = await back('c1', st);
  assert.match(decodeURIComponent(r.headers.get('location')), /^\/seller\?login_error=.*customer account/);
  // New seller via Google starts pending
  googleUsers.ns = { sub: 'g-ns', email: 'newseller@gmail.com', given_name: 'Omar', name: 'Omar K' };
  st = await start('seller'); r = await back('ns', st);
  const ns = (await api('GET', '/api/seller/me', null, sid(r))).body;
  assert.deepStrictEqual([ns.shop_name, ns.status], ["Omar's Shop", 'pending']);
  // The owner (ADMIN_EMAIL) has full access, so Google opens the shop too
  googleUsers.adm = { sub: 'g-admin', email: 'admin@x.com' };
  st = await start('shop'); r = await back('adm', st);
  assert.strictEqual(r.headers.get('location'), '/#/');
});

test('manual product: seller types it in, Kinan buys it by hand, warehouse receives it', async () => {
  const aTok = await login('admin@x.com', 'adminpass1');
  const sTok = await login('s1@x.com', 'sellerpass');
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const body = { source_link: '【淘宝】https://c.tb.cn/h.jisQjW97U1je5Ty?tk=G4nC62ND6AY HU006 「战术加绒冲锋衣」', title: 'Tactical fleece jacket', images: [img],
    variants: [{ name: 'Black / L', price: 49, stock: 10, cost_cny: 199 }, { name: 'Black / XL', price: 52, stock: 5 }] };
  assert.strictEqual((await api('POST', '/api/seller/products/manual', { ...body, images: [] }, sTok)).status, 400, 'photo required');
  assert.strictEqual((await api('POST', '/api/seller/products/manual', { ...body, variants: [{ name: '', price: 0 }] }, sTok)).status, 400, 'price required');
  const pub = await api('POST', '/api/seller/products/manual', body, sTok);
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.body));
  assert.strictEqual(pub.body.status, 'pending_review');
  const q = (await api('GET', '/api/admin/listings?status=pending_review', null, aTok)).body.find((l) => l.id === pub.body.id);
  assert.strictEqual(q.skus[1].margin_pct, null, 'no cost → no margin');
  await api('POST', `/api/admin/listings/${pub.body.id}/approve`, null, aTok);
  const item = (await api('GET', `/api/catalog/${pub.body.id}`)).body;
  assert.match(item.images[0], /^\/img\/l\/lst_\w+\/0\?v=\w+$/);
  const ph = await realFetch(base + item.images[0]);
  assert.deepStrictEqual([ph.status, ph.headers.get('content-type'), ph.headers.get('cache-control')], [200, 'image/jpeg', 'public, max-age=31536000, immutable']);
  assert.strictEqual((await realFetch(base + '/img/l/lst_nope/0')).status, 404);
  assert.ok(!JSON.stringify(item).includes('c.tb.cn'), 'Taobao link is hidden from buyers');
  // Price edit keeps approval; resync is a no-op
  const ed = await api('PUT', `/api/seller/products/${pub.body.id}/manual`, { ...body, variants: [{ ...body.variants[0], price: 45 }, body.variants[1]] }, sTok);
  assert.strictEqual(ed.body.status, 'active');
  assert.strictEqual((await api('POST', `/api/seller/products/${pub.body.id}/resync`, null, sTok)).status, 200);

  // Buyer orders it
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'm1@x.com', password: 'buyerpass1', name: 'M' });
  const bTok = await login('m1@x.com', 'buyerpass1');
  const calls = tb.calls.length;
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: item.id, mp_sku_id: item.skus[0].mp_sku_id, qty: 1 }], shipping_address: { name: 'M', phone: '1', country: 'Jordan', city: 'Amman', line1: 'St 2' } }, bTok)).body;
  const paid = (await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, bTok)).body;
  assert.strictEqual(paid.status, 'procuring');
  assert.strictEqual(tb.calls.length, calls, 'no Taobao API call for manual items');
  let full = (await api('GET', `/api/admin/orders/${o.id}`, null, aTok)).body;
  assert.strictEqual(full.sub_orders[0].status, 'MANUAL_TO_BUY');
  assert.match(full.sub_orders[0].links[0].link, /c\.tb\.cn/);
  // Admin buys it, then adds the tracking number
  full = (await api('POST', `/api/admin/orders/${o.id}/manual-bought`, { taobao_order_no: '4012345678' }, aTok)).body;
  assert.strictEqual(full.sub_orders[0].status, 'MANUAL_BOUGHT');
  full = (await api('POST', `/api/admin/orders/${o.id}/manual-bought`, { tracking: 'YT123456789CN', carrier: 'YTO' }, aTok)).body;
  assert.strictEqual(full.status, 'awaiting_parcels');
  // Warehouse scans it → ready to ship
  const rc = await api('POST', '/api/warehouse/receive', { tracking: 'YT123456789CN', weight_g: 900 }, aTok);
  assert.strictEqual(rc.body.matched, true);
  assert.strictEqual((await api('GET', `/api/buyer/orders/${o.id}`, null, bTok)).body.status, 'ready_to_ship');
});

test('Continue with Google: admin dashboard only for allowlisted Gmail', async () => {
  const start = async () => {
    const r = await realFetch(`${base}/auth/google?app=admin`, { redirect: 'manual' });
    const loc = new URL(r.headers.get('location')); googleNonce = loc.searchParams.get('nonce'); return loc.searchParams.get('state');
  };
  const back = async (code) => realFetch(`${base}/auth/google/callback?code=${code}&state=${await start()}`, { redirect: 'manual' });
  const sid = (r) => decodeURIComponent((r.headers.get('set-cookie') || '').match(/sid=([^;]+)/)?.[1] || '');
  // ADMIN_EMAIL links to the existing admin
  googleUsers.a1 = { sub: 'g-admin', email: 'admin@x.com' };
  let r = await back('a1');
  assert.strictEqual(r.headers.get('location'), '/admin');
  assert.strictEqual((await api('GET', '/api/me', null, sid(r))).body.role, 'admin');
  // An extra allowlisted Gmail gets an admin account
  googleUsers.boss = { sub: 'g-boss', email: 'boss@gmail.com', name: 'Boss' };
  r = await back('boss');
  assert.strictEqual((await api('GET', '/api/admin/overview', null, sid(r))).status, 200);
  // Anyone else is refused and sent back to /admin with the reason
  googleUsers.rnd = { sub: 'g-rnd', email: 'random@gmail.com' };
  r = await back('rnd');
  assert.match(decodeURIComponent(r.headers.get('location')), /^\/admin\?login_error=.*not allowed/);
  // A customer Google account can't open the admin either, even if someone allowlists it later
  googleUsers.c1b = { sub: 'g-111', email: 'gina@gmail.com' };
  r = await back('c1b');
  assert.match(decodeURIComponent(r.headers.get('location')), /not allowed/);
  // An allowlisted owner who is already a seller keeps the shop and still gets every app
  googleUsers.os = { sub: 'g-os', email: 'boss2@gmail.com', given_name: 'Owner' };
  const sst = await realFetch(`${base}/auth/google?app=seller`, { redirect: 'manual' });
  const sloc = new URL(sst.headers.get('location')); googleNonce = sloc.searchParams.get('nonce');
  r = await realFetch(`${base}/auth/google/callback?code=os&state=${sloc.searchParams.get('state')}`, { redirect: 'manual' });
  assert.strictEqual((await api('GET', '/api/seller/me', null, sid(r))).status, 200);
  // The allowlist is read at start-up, so add this owner through the live config
  require('../src/config').config.adminGoogleEmails.push('boss2@gmail.com');
  r = await back('os');
  assert.strictEqual(r.headers.get('location'), '/admin');
  const tok = sid(r);
  const me = (await api('GET', '/api/me', null, tok)).body;
  assert.deepStrictEqual([me.role, me.owner], ['seller', true]);
  for (const path of ['/api/admin/overview', '/api/seller/me', '/api/warehouse/couriers']) assert.strictEqual((await api('GET', path, null, tok)).status, 200, path);
});


test('AliExpress, manual mode: typed-in product ships direct, admin orders it by hand', async () => {
  const aTok = await login('admin@x.com', 'adminpass1');
  const sTok = await login('s1@x.com', 'sellerpass');
  assert.strictEqual((await api('GET', '/api/admin/aliexpress', null, aTok)).body.mode, 'manual');
  assert.strictEqual((await api('GET', '/api/config/public')).body.aliexpress.import, false);
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const pub = await api('POST', '/api/seller/products/manual', { source: 'aliexpress', source_link: 'https://www.aliexpress.com/item/1005005551234.html', title: 'LED desk lamp', images: [img], variants: [{ name: 'White', price: 20, stock: 30, cost_cny: 8 }] }, sTok);
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.body));
  assert.deepStrictEqual([pub.body.source, pub.body.fulfillment, pub.body.ae_product_id, pub.body.skus[0].cost_sale], ['aliexpress', 'direct', '1005005551234', 8]);
  await api('POST', `/api/admin/listings/${pub.body.id}/approve`, null, aTok);
  const lst = (await api('GET', '/api/admin/listings?status=active', null, aTok)).body.find((l) => l.id === pub.body.id);
  assert.strictEqual(lst.skus[0].margin_pct, 60, 'margin from the USD cost');
  const item = (await api('GET', `/api/catalog/${pub.body.id}`)).body;
  assert.strictEqual(item.fulfillment, 'direct');

  await api('POST', '/api/auth/register', { role: 'buyer', email: 'ae1@x.com', password: 'buyerpass1', name: 'Sara' });
  const bTok = await login('ae1@x.com', 'buyerpass1');
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: item.id, mp_sku_id: item.skus[0].mp_sku_id, qty: 2 }], shipping_address: { name: 'Sara', phone: '+966500000000', country_code: 'SA', city: 'Riyadh', line1: 'King Fahd Rd 1' } }, bTok)).body;
  assert.strictEqual(o.shipping_address.country, 'Saudi Arabia');
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, bTok);
  let full = (await api('GET', `/api/admin/orders/${o.id}`, null, aTok)).body;
  assert.deepStrictEqual([full.status, full.sub_orders[0].status, full.sub_orders[0].direct], ['procuring', 'AE_TO_BUY', true]);
  assert.ok((await api('GET', '/api/admin/overview', null, aTok)).body.alerts.some((a) => /AliExpress item to order/.test(a.text)));
  assert.strictEqual((await api('POST', `/api/admin/orders/${o.id}/aliexpress`, { place: true }, aTok)).status, 503, 'no API connection yet');
  full = (await api('POST', `/api/admin/orders/${o.id}/aliexpress`, { ae_order_no: '3001234567' }, aTok)).body;
  assert.strictEqual(full.sub_orders[0].status, 'AE_PAID');
  // Once ordered on AliExpress, Kinan can't silently cancel
  assert.strictEqual((await api('POST', `/api/buyer/orders/${o.id}/cancel`, null, bTok)).status, 409);
  full = (await api('POST', `/api/admin/orders/${o.id}/aliexpress`, { tracking: 'LX123456789CN', carrier: 'Cainiao' }, aTok)).body;
  assert.strictEqual(full.status, 'shipped');
  const bv = (await api('GET', `/api/buyer/orders/${o.id}`, null, bTok)).body;
  assert.deepStrictEqual([bv.all_direct, bv.direct[0].tracking[0].number], [true, 'LX123456789CN']);
  assert.ok(!JSON.stringify(bv).includes('3001234567'), 'AliExpress order no. stays internal');
  full = (await api('POST', `/api/admin/orders/${o.id}/aliexpress`, { delivered: true }, aTok)).body;
  assert.strictEqual(full.status, 'delivered');
  // Seller earnings: 40 gross − 10% commission − 16 AliExpress cost = 20, now payable
  const led = (await api('GET', '/api/seller/earnings', null, sTok)).body.entries.find((e) => e.order_id === o.id);
  assert.deepStrictEqual([led.cost, led.net, led.status], [16, 20, 'payable']);
});

test('AliExpress, API mode: connect, import by link, order placed and synced automatically', async () => {
  const aTok = await login('admin@x.com', 'adminpass1');
  const sTok = await login('s1@x.com', 'sellerpass');
  const auth = new URL((await api('POST', '/api/admin/aliexpress/connect', null, aTok)).body.url);
  assert.strictEqual(auth.origin + auth.pathname, 'https://api-sg.aliexpress.com/oauth/authorize');
  const cb = await realFetch(`${base}/oauth/aliexpress/callback?code=c1&state=${auth.searchParams.get('state')}`, { redirect: 'manual' });
  assert.strictEqual(cb.headers.get('location'), '/admin?aliexpress=connected');
  assert.strictEqual((await api('GET', '/api/admin/aliexpress', null, aTok)).body.mode, 'api');
  assert.strictEqual((await api('GET', '/api/config/public')).body.aliexpress.import, true);

  const prev = (await api('POST', '/api/seller/products/aliexpress/preview', { link: 'https://ar.aliexpress.com/item/1005006000111.html?spm=x' }, sTok)).body;
  assert.deepStrictEqual([prev.title, prev.skus[0].props, prev.skus[0].cost_sale, prev.skus[0].suggested_price], ['Silicone phone case', 'Red', 3.2, 4.16]);
  const pub = await api('POST', '/api/seller/products/aliexpress', { link: 'https://ar.aliexpress.com/item/1005006000111.html', prices: { [prev.skus[0].mp_sku_id]: 9.99 } }, sTok);
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.body));
  await api('POST', `/api/admin/listings/${pub.body.id}/approve`, null, aTok);

  await api('POST', '/api/auth/register', { role: 'buyer', email: 'ae2@x.com', password: 'buyerpass1', name: 'Omar' });
  const bTok = await login('ae2@x.com', 'buyerpass1');
  const item = (await api('GET', `/api/catalog/${pub.body.id}`)).body;
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: item.id, mp_sku_id: item.skus[0].mp_sku_id, qty: 1 }], shipping_address: { name: 'Omar', phone: '+971500000000', country: 'الإمارات', city: 'Dubai', line1: 'Marina 5' } }, bTok)).body;
  assert.strictEqual(o.shipping_address.country, 'United Arab Emirates', 'Arabic country name understood');
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, bTok);
  let full = (await api('GET', `/api/admin/orders/${o.id}`, null, aTok)).body;
  assert.deepStrictEqual([full.sub_orders[0].status, full.sub_orders[0].purchase_ids], ['AE_PLACED', ['8123456789']]);
  assert.deepStrictEqual([aeMock.lastOrder.logistics_address.country, aeMock.lastOrder.logistics_address.full_name, aeMock.lastOrder.product_items[0].sku_attr], ['AE', 'Omar', '14:200#Red'], 'placed with the customer address');
  // AliExpress ships it → sync picks up tracking
  aeMock.status = 'WAIT_BUYER_ACCEPT_GOODS';
  full = (await api('POST', `/api/admin/orders/${o.id}/sync`, null, aTok)).body;
  assert.deepStrictEqual([full.status, full.sub_orders[0].logistics[0].tracking], ['shipped', 'LP0001']);
  aeMock.status = 'FINISH';
  full = (await api('POST', `/api/admin/orders/${o.id}/sync`, null, aTok)).body;
  assert.strictEqual(full.status, 'delivered');
});

test('password reset and email log', async () => {
  const aTok = await login('admin@x.com', 'adminpass1');
  // Unknown email: same answer, nothing sent
  assert.deepStrictEqual((await api('POST', '/api/auth/forgot', { email: 'nobody@x.com' })).body, { ok: true, email_enabled: false });
  await api('POST', '/api/auth/forgot', { email: 'W1@x.com' });
  let mail = (await api('GET', '/api/admin/mail', null, aTok)).body;
  assert.strictEqual(mail.enabled, false);
  assert.ok(mail.recent.some((m) => m.kind === 'reset' && m.to === 'w1@x.com' && m.status === 'not_sent'));
  // Emails were queued along the way for orders, sales and approvals (once each)
  for (const k of ['order', 'sale', 'seller', 'request']) assert.ok(mail.recent.some((m) => m.kind === k), `has ${k} email`);
  const keys = mail.recent.map((m) => m.key).filter(Boolean);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate emails');
  // Admin creates a reset link for a user without email set up
  const users = (await api('GET', '/api/admin/users', null, aTok)).body;
  const w1 = users.find((u) => u.email === 'w1@x.com');
  const old = await login('w1@x.com', 'buyerpass1');
  const { url } = (await api('POST', `/api/admin/users/${w1.id}/reset-link`, null, aTok)).body;
  const token = url.split('#t=')[1];
  assert.ok(token && url.startsWith('http'));
  assert.strictEqual((await api('POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
  const r = await api('POST', '/api/auth/reset', { token, password: 'newpass123' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.user.email, 'w1@x.com');
  assert.strictEqual((await api('GET', '/api/me', null, old)).status, 401, 'old sessions signed out');
  assert.strictEqual((await api('POST', '/api/auth/reset', { token, password: 'another123' })).status, 400, 'single use');
  assert.strictEqual((await api('POST', '/api/auth/login', { email: 'w1@x.com', password: 'buyerpass1' })).status, 401);
  assert.ok(await login('w1@x.com', 'newpass123'));
  assert.strictEqual((await realFetch(base + '/reset')).status, 200);
});

test('seller withdrawals and customer returns', async () => {
  const aTok = await login('admin@x.com', 'adminpass1');
  const sTok = await login('s1@x.com', 'sellerpass');
  let e = (await api('GET', '/api/seller/earnings', null, sTok)).body;
  assert.ok(e.available >= 20, `has earnings (${e.available})`);
  const start = e.available;
  assert.strictEqual((await api('POST', '/api/seller/payouts', { amount: start + 1, details: { method: 'bank', holder: 'Ali', iban: 'MT84MALT011000012345MTLCAST001S' } }, sTok)).status, 409);
  assert.strictEqual((await api('POST', '/api/seller/payouts', { amount: 15, details: { method: 'bank', holder: 'Ali', iban: 'nope' } }, sTok)).status, 400);
  const p = await api('POST', '/api/seller/payouts', { amount: 15, details: { method: 'bank', holder: 'Ali', iban: 'MT84 MALT 0110 0001 2345 MTLC AST0 01S' } }, sTok);
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  assert.strictEqual(p.body.details.iban, 'MT84MALT011000012345MTLCAST001S');
  assert.strictEqual((await api('POST', '/api/seller/payouts', { amount: 10 }, sTok)).status, 409, 'one at a time');
  e = (await api('GET', '/api/seller/earnings', null, sTok)).body;
  assert.deepStrictEqual([e.available, e.requested], [Math.round((start - 15) * 100) / 100, 15]);
  assert.ok((await api('GET', '/api/admin/overview', null, aTok)).body.alerts.some((a) => a.kind === 'payouts'));
  assert.strictEqual((await api('POST', `/api/admin/payouts/${p.body.id}`, { action: 'decline' }, aTok)).status, 400, 'reason needed');
  await api('POST', `/api/admin/payouts/${p.body.id}`, { action: 'paid', reference: 'WISE-123' }, aTok);
  e = (await api('GET', '/api/seller/earnings', null, sTok)).body;
  assert.deepStrictEqual([e.requested, e.withdrawn, e.payouts[0].status], [0, 15, 'paid']);

  // Return on the delivered AliExpress order from earlier
  const bTok = await login('ae1@x.com', 'buyerpass1');
  const o = (await api('GET', '/api/buyer/orders', null, bTok)).body.find((x) => x.status === 'delivered');
  assert.strictEqual((await api('POST', `/api/buyer/orders/${o.id}/returns`, { lines: ['1'] }, bTok)).status, 400, 'reason needed');
  const r = await api('POST', `/api/buyer/orders/${o.id}/returns`, { lines: ['1'], reason: 'damaged', note: 'Cracked' }, bTok);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await api('POST', `/api/buyer/orders/${o.id}/returns`, { lines: ['1'], reason: 'other' }, bTok)).status, 409, 'one open return');
  const before = (await api('GET', '/api/buyer/wallet', null, bTok)).body.balance;
  assert.strictEqual((await api('POST', `/api/admin/returns/${r.body.id}`, { action: 'refund', amount: 9999 }, aTok)).status, 400);
  await api('POST', `/api/admin/returns/${r.body.id}`, { action: 'refund', amount: 10, refund_to: 'wallet', charge_seller: true, note: 'Sorry about that' }, aTok);
  assert.strictEqual((await api('GET', '/api/buyer/wallet', null, bTok)).body.balance, before + 10);
  const view = (await api('GET', `/api/buyer/orders/${o.id}`, null, bTok)).body;
  assert.deepStrictEqual([view.returns[0].status, view.returns[0].refund_amount], ['refunded', 10]);
  e = (await api('GET', '/api/seller/earnings', null, sTok)).body;
  assert.ok(e.entries.some((x) => x.type === 'refund' && x.net === -10), 'charged to the seller');
  assert.strictEqual(e.available, Math.round((start - 15 - 10) * 100) / 100);
});

test('categories and shipping by weight and country', async () => {
  const aTok = await login('admin@x.com', 'adminpass1');
  const sTok = await login('s1@x.com', 'sellerpass');
  const cats = (await api('GET', '/api/categories')).body;
  assert.ok(cats.length >= 10 && cats.every((c) => c.en && c.ar));
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const pub = (await api('POST', '/api/seller/products/manual', { title: 'Hiking boots', category: 'shoes_bags', weight_kg: 1.2, images: [img], variants: [{ name: '42', price: 30, stock: 9 }] }, sTok)).body;
  await api('POST', `/api/admin/listings/${pub.id}/approve`, null, aTok);
  const inCat = (await api('GET', '/api/catalog?category=shoes_bags')).body;
  assert.ok(inCat.items.some((p) => p.id === pub.id) && inCat.items.every((p) => p.category === 'shoes_bags'));
  // 2 × 1.2 kg = 2.4 → 2.5 kg chargeable; Gulf 8 + 4 × 3 = 20
  let q = (await api('POST', '/api/shipping/quote', { items: [{ listing_id: pub.id, qty: 2 }], country_code: 'SA' })).body;
  assert.deepStrictEqual([q.fee, q.weight_kg, q.chargeable_kg, q.zone], [20, 2.4, 2.5, 'gulf']);
  assert.strictEqual((await api('POST', '/api/shipping/quote', { items: [{ listing_id: pub.id, qty: 1 }], country: 'Egypt' })).body.zone, 'africa');
  // Admin changes the Gulf rate
  const st = (await api('GET', '/api/admin/settings/shipping', null, aTok)).body;
  await api('PUT', '/api/admin/settings/shipping', { ...st, rates: { ...st.rates, gulf: { first: 6, extra: 2 } } }, aTok);
  q = (await api('POST', '/api/shipping/quote', { items: [{ listing_id: pub.id, qty: 2 }], country_code: 'SA' })).body;
  assert.strictEqual(q.fee, 14);

  // Order, then the parcel weighs less at dispatch → difference back to the wallet
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'sh1@x.com', password: 'buyerpass1', name: 'H' });
  const bTok = await login('sh1@x.com', 'buyerpass1');
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: pub.id, mp_sku_id: pub.skus[0].mp_sku_id, qty: 2 }], shipping_address: { name: 'H', phone: '1', country_code: 'SA', city: 'Jeddah', line1: 'St 3' } }, bTok)).body;
  assert.deepStrictEqual([o.shipping_fee, o.total], [14, 74]);
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, bTok);
  await api('POST', `/api/admin/orders/${o.id}/manual-bought`, { tracking: 'SHW1' }, aTok);
  await api('POST', '/api/warehouse/receive', { tracking: 'SHW1', weight_g: 1300 }, aTok);
  const sh = await api('POST', `/api/warehouse/orders/${o.id}/ship`, { carrier: 'DHL', tracking: 'DHL1', weight_g: 1400 }, aTok);
  assert.strictEqual(sh.status, 200, JSON.stringify(sh.body));
  // 1.4 kg → 1.5 kg → 6 + 2×2 = 10 → customer overpaid 4
  const bv = (await api('GET', `/api/buyer/orders/${o.id}`, null, bTok)).body;
  assert.deepStrictEqual([bv.shipping_settled.result, bv.shipping_settled.diff], ['credited', -4]);
  assert.strictEqual((await api('GET', '/api/buyer/wallet', null, bTok)).body.balance, 4);
  await api('PUT', '/api/admin/settings/shipping', st, aTok); // restore
});

test('review fixes: stock, photo access, test payments, cleanup, client IP', async () => {
  const aTok = await login('admin@x.com', 'adminpass1');
  const sTok = await login('s1@x.com', 'sellerpass');
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const pub = (await api('POST', '/api/seller/products/manual', { title: 'Limited mug', images: [img], variants: [{ name: 'Blue', price: 9, stock: 3 }] }, sTok)).body;
  assert.strictEqual((await realFetch(`${base}/img/l/${pub.id}/0`)).status, 404, 'photos hidden until approved');
  await api('POST', `/api/admin/listings/${pub.id}/approve`, null, aTok);
  assert.strictEqual((await realFetch(`${base}/img/l/${pub.id}/0`)).status, 200);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'st1@x.com', password: 'buyerpass1', name: 'S' });
  const bTok = await login('st1@x.com', 'buyerpass1');
  const addr = { name: 'S', phone: '1', country_code: 'JO', city: 'Amman', line1: 'St 9' };
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: pub.id, mp_sku_id: pub.skus[0].mp_sku_id, qty: 2 }], shipping_address: addr }, bTok)).body;
  assert.match(o.lines[0].image, /^\/img\/l\//, 'orders keep a photo link, not the photo itself');
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, bTok);
  let stock = (await api('GET', `/api/catalog/${pub.id}`)).body.skus[0].stock;
  assert.strictEqual(stock, 1, 'typed-in stock goes down when paid');
  assert.strictEqual((await api('POST', '/api/buyer/checkout', { items: [{ listing_id: pub.id, mp_sku_id: pub.skus[0].mp_sku_id, qty: 2 }], shipping_address: addr }, bTok)).status, 409, 'cannot oversell');
  const list = (await api('GET', '/api/admin/orders', null, aTok)).body;
  assert.strictEqual(list.find((x) => x.id === o.id).test_payment, true);
  assert.ok((await api('GET', '/api/admin/overview', null, aTok)).body.alerts.some((a) => a.kind === 'test_payments'));
  await api('POST', `/api/admin/orders/${o.id}/cancel`, null, aTok);
  stock = (await api('GET', `/api/catalog/${pub.id}`)).body.skus[0].stock;
  assert.strictEqual(stock, 3, 'stock comes back on cancel');

  const { cleanup, clientIp } = require('../src/server');
  db.sessions.insert({ token_hash: 'old', user_id: 'x', expires_at: Date.now() - 1000 });
  assert.ok(cleanup() >= 1);
  assert.ok(!db.sessions.find((x) => x.token_hash === 'old'));
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }, socket: { remoteAddress: '10.0.0.1' } }), '9.9.9.9');
  assert.strictEqual(clientIp({ headers: { 'cf-connecting-ip': '5.5.5.5', 'x-forwarded-for': '1.1.1.1' }, socket: {} }), '5.5.5.5');
  assert.strictEqual(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
});

'use strict';
/* Task 05: role matrix (each account sees only what it may) and the admin audit trail. Synthetic accounts, demo payments. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', AI_AUTO_REVIEW: 'off', CAMPAIGNS_JSON: '[]', XMAS_AUTO: '0' });
for (const k of ['STRIPE_SECRET_KEY', 'CJ_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL']) delete process.env[k];

const auth = require('../src/auth');
const db = require('../src/db');
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
const addr = { name: 'C', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' };
const T = {}; const ids = {};

test('setup: admin, staff of each role, two sellers with a product each, two buyers with an order each', async () => {
  T.boss = await login('boss@x.com', 'adminpass1');
  for (const role of ['support', 'finance', 'warehouse', 'procurement']) {
    const r = await api('POST', '/api/admin/staff', { email: `${role}@x.com`, password: `${role}pass1`, name: role, role }, T.boss);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    T[role] = await login(`${role}@x.com`, `${role}pass1`);
  }
  for (const n of ['a', 'b']) {
    const reg = (await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email: `sel${n}@x.com`, password: 'sellerpass', shop_name: `Shop ${n}` })).body;
    await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, T.boss);
    T[`seller_${n}`] = await login(`sel${n}@x.com`, 'sellerpass');
    const p = (await api('POST', '/api/seller/products/manual', { title: `Lamp ${n}`, category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants: [{ name: 'One', price: 20, stock: 10 }] }, T[`seller_${n}`])).body;
    await api('POST', `/api/admin/listings/${p.id}/approve`, null, T.boss);
    ids[`product_${n}`] = p.id;
    await api('POST', '/api/auth/register', { role: 'buyer', email: `buy${n}@x.com`, password: 'buyerpass1', name: `B${n}` });
    T[`buyer_${n}`] = await login(`buy${n}@x.com`, 'buyerpass1');
    const l = db.listings.get(p.id);
    const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: l.id, mp_sku_id: l.skus[0].mp_sku_id, qty: 1 }], shipping_address: addr }, T[`buyer_${n}`])).body;
    await require('../src/services/orders').markPaid(o.id, { provider: 'demo' });
    ids[`order_${n}`] = o.id;
  }
});

test('buyers: only their own orders; no seller or admin pages', async () => {
  assert.equal((await api('GET', `/api/buyer/orders/${ids.order_a}`, null, T.buyer_a)).status, 200);
  assert.equal((await api('GET', `/api/buyer/orders/${ids.order_a}`, null, T.buyer_b)).status, 404);
  assert.equal((await api('POST', `/api/buyer/orders/${ids.order_a}/cancel`, null, T.buyer_b)).status, 404);
  assert.equal((await api('POST', `/api/buyer/orders/${ids.order_a}/returns`, { lines: [1], reason: 'x' }, T.buyer_b)).status, 404);
  assert.ok(!(await api('GET', '/api/buyer/orders', null, T.buyer_b)).body.some((o) => o.id === ids.order_a));
  assert.equal((await api('GET', '/api/seller/orders', null, T.buyer_a)).status, 403);
  assert.equal((await api('GET', '/api/admin/users', null, T.buyer_a)).status, 403);
  assert.equal((await api('GET', '/api/warehouse/overview', null, T.buyer_a)).status, 403);
});

test('sellers: only their own products and orders, no customer addresses of others', async () => {
  assert.equal((await api('PATCH', `/api/seller/products/${ids.product_a}`, { status: 'paused' }, T.seller_b)).status, 404);
  assert.equal((await api('PUT', `/api/seller/products/${ids.product_a}/manual`, { title: 'Hijack' }, T.seller_b)).status, 404);
  assert.equal((await api('GET', `/api/seller/orders/${ids.order_a}/messages`, null, T.seller_b)).status, 404);
  const mine = (await api('GET', '/api/seller/orders', null, T.seller_b)).body;
  assert.deepEqual(mine.map((o) => o.id), [ids.order_b]);
  assert.equal((await api('GET', '/api/admin/sellers', null, T.seller_a)).status, 403);
  assert.equal((await api('GET', '/api/buyer/orders', null, T.seller_a)).status, 403);
});

test('staff: each role reaches only its part of Admin', async () => {
  assert.equal((await api('GET', '/api/admin/users', null, T.support)).status, 200);
  assert.equal((await api('POST', '/api/admin/staff', { email: 'x@x.com', password: 'xxxxxxxx1', name: 'x', role: 'admin' }, T.support)).status, 403);
  assert.equal((await api('POST', '/api/admin/staff', { email: 'y@x.com', password: 'yyyyyyyy1', name: 'y', role: 'admin' }, T.finance)).status, 403);
  const admin = db.users.find((u) => u.email === 'boss@x.com');
  const buyer = db.users.find((u) => u.email === 'buya@x.com');
  assert.equal((await api('POST', `/api/admin/users/${admin.id}/reset-link`, null, T.support)).status, 403, 'support cannot take over an admin');
  assert.equal((await api('POST', `/api/admin/users/${buyer.id}/reset-link`, null, T.support)).status, 200);
  assert.equal((await api('GET', '/api/admin/users', null, T.warehouse)).status, 403);
  assert.equal((await api('GET', '/api/admin/backup', null, T.finance)).status, 403);
  assert.equal((await api('PUT', '/api/admin/settings/shipping', {}, T.procurement)).status, 403);
  assert.equal((await api('GET', '/api/admin/audit', null, T.finance)).status, 403);
  assert.equal((await api('GET', '/api/admin/users', null, null)).status, 401);
  // no password hashes in the people list
  assert.ok(!JSON.stringify((await api('GET', '/api/admin/users', null, T.boss)).body).includes('scrypt'));
  assert.ok((await api('GET', '/api/admin/users', null, T.boss)).body.every((u) => !('pass' in u)));
});

test('audit trail: changes and sensitive reads are recorded with who, what and result — never secrets', async () => {
  const before = db.audit.all().length;
  await api('POST', '/api/admin/staff', { email: 'aud@x.com', password: 'secretpass9', name: 'Aud', role: 'support' }, T.boss);
  await api('GET', '/api/admin/backup', null, T.boss);
  await api('POST', '/api/admin/staff', { email: 'no@x.com', password: 'secretpass9', name: 'No', role: 'admin' }, T.finance); // refused
  const list = (await api('GET', '/api/admin/audit?limit=50', null, T.boss)).body;
  assert.ok(db.audit.all().length >= before + 3);
  const created = list.find((a) => a.path === '/api/admin/staff' && a.status === 200 && a.actor.email === 'boss@x.com');
  assert.ok(created);
  assert.deepEqual(created.fields.sort(), ['email', 'name', 'role']);
  assert.ok(!JSON.stringify(list).includes('secretpass9'), 'no password in the audit trail');
  assert.ok(list.some((a) => a.path === '/api/admin/backup' && a.method === 'GET' && a.actor.role === 'admin'));
  const refused = list.find((a) => a.actor?.email === 'finance@x.com' && a.status === 403);
  assert.ok(refused, 'a refused attempt is recorded too');
  // ordinary reads are not recorded (keeps the trail useful)
  const n = db.audit.all().length;
  await api('GET', '/api/admin/sellers', null, T.boss);
  assert.equal(db.audit.all().length, n);
});

test('owner can provision, monitor and suspend an operator without exposing financial data or personal email', async (t) => {
  const body = { email: 'operator@x.com', password: 'staff-pass-long', name: 'Operator', role: 'operator', mailboxes: ['support@kinan.shop'] };
  assert.equal((await api('POST', '/api/admin/staff', { ...body, mailboxes: ['other@example.com'] }, T.boss)).status, 400);
  const employee = await api('POST', '/api/admin/staff', body, T.boss);
  assert.equal(employee.status, 201);
  const id = employee.body.id;
  const token = await login(body.email, body.password);
  assert.ok(token);

  for (const endpoint of ['overview', 'orders', `orders/${ids.order_a}`, 'users', 'audit', 'backup', 'payouts', 'team', `team/${id}/activity`]) {
    assert.equal((await api('GET', '/api/admin/' + endpoint, null, token)).status, 403, endpoint);
  }
  const orderList = await api('GET', '/api/admin/team-orders', null, token);
  assert.equal(orderList.status, 200);
  assert.equal(orderList.body.length, 2);
  assert.deepEqual(Object.keys(orderList.body[0]).sort(), ['created_at', 'id', 'status']);
  assert.equal((await api('POST', '/api/admin/team/presence', null, token)).status, 200);
  const team = await api('GET', '/api/admin/team', null, T.boss);
  assert.equal(team.body.find((member) => member.id === id).online, true);

  const mailboxStatus = await api('GET', '/api/admin/mailbox/status', null, token);
  assert.deepEqual(mailboxStatus.body, { configured: false, addresses: ['support@kinan.shop'] });
  assert.equal((await api('GET', '/api/admin/mailbox/inbox?address=hello@kinan.shop', null, token)).status, 403);
  assert.equal((await api('POST', '/api/admin/mailbox/send', { from: 'support@kinan.shop' }, token)).status, 503);

  Object.assign(process.env, {
    ADMIN_MAIL_GOOGLE_CLIENT_ID: 'test-client', ADMIN_MAIL_GOOGLE_CLIENT_SECRET: 'test-secret',
    ADMIN_MAIL_GMAIL_REFRESH_TOKEN: 'test-refresh', ADMIN_MAIL_STAFF_ACCOUNT: 'team@kinan.shop'
  });
  t.after(() => {
    for (const key of ['ADMIN_MAIL_GOOGLE_CLIENT_ID', 'ADMIN_MAIL_GOOGLE_CLIENT_SECRET', 'ADMIN_MAIL_GMAIL_REFRESH_TOKEN', 'ADMIN_MAIL_STAFF_ACCOUNT']) delete process.env[key];
  });
  const localFetch = global.fetch;
  let primary = 'personal@gmail.com';
  t.mock.method(global, 'fetch', (input, options) => {
    const url = new URL(input);
    const reply = (data) => Promise.resolve({ ok: true, json: async () => data });
    if (url.hostname === 'oauth2.googleapis.com') return reply({ access_token: 'test-token', expires_in: 3600 });
    if (url.pathname.endsWith('/profile')) return reply({ emailAddress: primary });
    if (url.pathname.endsWith('/settings/sendAs')) return reply({ sendAs: [{ sendAsEmail: 'support@kinan.shop', verificationStatus: 'accepted' }] });
    if (url.pathname.endsWith('/messages/send')) return reply({ id: 'provider-message' });
    return localFetch(input, options);
  });
  const draft = { from: 'support@kinan.shop', to: 'customer@x.com', subject: 'Private subject', text: 'Private contents' };
  assert.equal((await api('POST', '/api/admin/mailbox/send', draft, token)).status, 503);
  primary = 'team@kinan.shop';
  assert.equal((await api('POST', '/api/admin/mailbox/send', draft, token)).status, 200);
  const activity = (await api('GET', `/api/admin/team/${id}/activity`, null, T.boss)).body;
  assert.ok(activity.some((event) => event.path === '/api/auth/login'));
  assert.ok(activity.some((event) => event.mailbox === draft.from && event.message_id === 'provider-message'));
  assert.doesNotMatch(JSON.stringify(activity), /Private subject|Private contents|staff-pass-long|customer@x\.com/);

  assert.equal((await api('PATCH', `/api/admin/team/${id}`, { status: 'suspended' }, T.boss)).status, 200);
  assert.equal((await api('GET', '/api/admin/team-orders', null, token)).status, 401);
  assert.equal((await api('PATCH', `/api/admin/team/${id}`, { status: 'active' }, T.boss)).status, 200);
  assert.equal((await api('GET', '/api/admin/team-orders', null, token)).status, 401);
});

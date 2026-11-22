'use strict';
/*
 * Restricted employee (operator) workspace — acceptance tests from the Admin staff handoff.
 * Synthetic accounts only: owner, operator A (support@), operator B (hello@), a legacy support employee, a legacy
 * admin who is not the owner, a buyer, and anonymous. Gmail is mocked; no live mail is read or sent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'staffws-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', AI_AUTO_REVIEW: 'off', CAMPAIGNS_JSON: '[]', XMAS_AUTO: '0' });
for (const k of ['STRIPE_SECRET_KEY', 'CJ_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL']) delete process.env[k];
const MAIL_ENV = { ADMIN_MAIL_GOOGLE_CLIENT_ID: 'test-client', ADMIN_MAIL_GOOGLE_CLIENT_SECRET: 'test-secret', ADMIN_MAIL_GMAIL_REFRESH_TOKEN: 'test-refresh', ADMIN_MAIL_STAFF_ACCOUNT: 'team@kinan.shop' };
Object.assign(process.env, MAIL_ENV);

// ---- fake Gmail: one dedicated business mailbox that receives all four KINAN aliases ----
const gmail = { primary: 'team@kinan.shop', sent: [], failSend: 0, profileCalls: 0 };
const msg = (id, headers, text = 'Body ' + id) => ({ id, threadId: 'thr_' + id, internalDate: String(Date.now()), snippet: text.slice(0, 40),
  payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: Buffer.from(text).toString('base64url') } } });
const MESSAGES = {
  m_support: msg('m_support', { From: 'Ann <ann@customer.example>', To: 'support@kinan.shop', Subject: 'Where is my parcel', 'Message-ID': '<a1@customer.example>' }),
  m_hello: msg('m_hello', { From: 'Bob <bob@partner.example>', To: 'hello@kinan.shop', Subject: 'Partnership', 'Message-ID': '<b1@partner.example>' }),
  m_both: msg('m_both', { From: 'Cy <cy@customer.example>', To: 'hello@kinan.shop', Cc: 'support@kinan.shop', Subject: 'Both', 'Message-ID': '<c1@customer.example>' })
};
const realFetch = global.fetch;
global.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (url.hostname === 'oauth2.googleapis.com') return ok({ access_token: 'test-token', expires_in: 3600 });
  if (url.hostname !== 'gmail.googleapis.com') return realFetch(input, options);
  const p = url.pathname.replace('/gmail/v1/users/me/', '');
  if (p === 'profile') { gmail.profileCalls++; return ok({ emailAddress: gmail.primary }); }
  if (p === 'settings/sendAs') return ok({ sendAs: ['hello', 'info', 'sellers', 'support'].map((n) => ({ sendAsEmail: n + '@kinan.shop', verificationStatus: 'accepted' })) });
  if (p === 'messages/send') {
    if (gmail.failSend > 0) { gmail.failSend--; return { ok: false, status: 500, json: async () => ({}) }; }
    const body = JSON.parse(options.body); gmail.sent.push(body); return ok({ id: 'sent_' + gmail.sent.length });
  }
  if (p === 'messages') {
    const q = url.searchParams.get('q') || '';
    return ok({ messages: Object.values(MESSAGES).filter((m) => m.payload.headers.some((h) => q.includes(h.value))).map(({ id }) => ({ id })) });
  }
  const id = decodeURIComponent(p.replace('messages/', ''));
  return MESSAGES[id] ? ok(MESSAGES[id]) : { ok: false, status: 404, json: async () => ({}) };
};

const auth = require('../src/auth');
const db = require('../src/db');
const adminMail = require('../src/services/adminMail');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await realFetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (email, password) => (await api('POST', '/api/auth/login', { email, password, app: 'admin' })).body.token;
const T = {}; const ids = {};
const OP_A = { email: 'op.a@x.com', password: 'operator-A-pass', name: 'Operator A', role: 'operator', mailboxes: ['support@kinan.shop'] };
const OP_B = { email: 'op.b@x.com', password: 'operator-B-pass', name: 'Operator B', role: 'operator', mailboxes: ['hello@kinan.shop'] };

test('setup: owner, two operators, legacy support and legacy admin, one paid order', async () => {
  T.owner = await login('boss@x.com', 'adminpass1');
  for (const [k, body] of [['a', OP_A], ['b', OP_B]]) {
    const r = await api('POST', '/api/admin/staff', body, T.owner);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids[k] = r.body.id; T[k] = await login(body.email, body.password);
    assert.ok(T[k], 'operator can sign in to Admin');
  }
  for (const role of ['support', 'admin']) {
    const r = await api('POST', '/api/admin/staff', { email: `legacy.${role}@x.com`, password: `legacy-${role}-1`, name: `Legacy ${role}`, role, mailboxes: [] }, T.owner);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    T[role] = await login(`legacy.${role}@x.com`, `legacy-${role}-1`);
  }
  // a buyer with one paid order (demo payment) for the order-access checks
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, T.owner);
  const sel = (await api('POST', '/api/auth/login', { email: 'sel@x.com', password: 'sellerpass', app: 'seller' })).body.token;
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Lamp', category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants: [{ name: 'One', price: 20, stock: 10 }] }, sel)).body;
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, T.owner);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'buyer@x.com', password: 'buyerpass1', name: 'Buyer Person' });
  const buyer = (await api('POST', '/api/auth/login', { email: 'buyer@x.com', password: 'buyerpass1', app: 'shop' })).body.token;
  const l = db.listings.get(p.id);
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: l.id, mp_sku_id: l.skus[0].mp_sku_id, qty: 1 }], shipping_address: { name: 'Buyer Person', phone: '+356 7900 0000', country_code: 'MT', city: 'Valletta', line1: 'Secret Street 1' } }, buyer)).body;
  await require('../src/services/orders').markPaid(o.id, { provider: 'demo' });
  ids.order = o.id;
});

test('provisioning: only the proven owner manages employees', async () => {
  const body = { email: 'op.c@x.com', password: 'operator-C-pass', name: 'C', role: 'operator', mailboxes: ['info@kinan.shop'] };
  for (const who of ['admin', 'support', 'a']) {
    assert.equal((await api('POST', '/api/admin/staff', body, T[who])).status, 403, `${who} cannot create staff`);
    assert.equal((await api('GET', '/api/admin/team', null, T[who])).status, 403, `${who} cannot list staff`);
    assert.equal((await api('PATCH', `/api/admin/team/${ids.b}`, { status: 'suspended' }, T[who])).status, 403, `${who} cannot suspend`);
    assert.equal((await api('GET', `/api/admin/team/${ids.b}/activity`, null, T[who])).status, 403, `${who} cannot read activity`);
    assert.equal((await api('DELETE', `/api/admin/team/${ids.b}`, null, T[who])).status, 403, `${who} cannot delete`);
  }
  assert.equal((await api('POST', '/api/admin/staff', body)).status, 401, 'anonymous');
  assert.equal((await api('POST', '/api/admin/staff', { ...body, password: 'short-pass' }, T.owner)).status, 400, 'operator password needs 12+');
  assert.equal((await api('POST', '/api/admin/staff', { ...body, mailboxes: ['ceo@gmail.com'] }, T.owner)).status, 400, 'only KINAN aliases');
  assert.equal((await api('POST', '/api/admin/staff', { ...body, email: 'boss@x.com' }, T.owner)).status, 400, 'not the owner login');
  assert.equal((await api('POST', '/api/admin/staff', { ...body, email: 'op.a@x.com' }, T.owner)).status, 409, 'unique individual accounts');
  // the owner sees which older roles still have broad access
  const team = (await api('GET', '/api/admin/team', null, T.owner)).body;
  assert.deepEqual(team.map((m) => m.role).sort(), ['admin', 'operator', 'operator', 'support']);
  assert.ok(!team.some((m) => m.email === 'boss@x.com'), 'the owner is not listed as an employee');
});

test('default deny: every Admin, Seller, Warehouse and Buyer route not meant for operators refuses them', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const routes = [...src.matchAll(/^\s*r\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)', ([^,]+?|\[[^\]]*\]), async/gm)]
    .map(([, method, p, roles]) => ({ method, p, roles: roles.trim() }))
    .filter(({ roles }) => roles !== 'null' && roles !== 'auth.ROLES' && !/OPERATOR|'operator'/.test(roles));
  assert.ok(routes.length > 250, `found ${routes.length} protected routes`);
  const leaks = [];
  for (const { method, p } of routes) {
    const r = await api(method, p.replace(/:(\w+)/g, 'x1'), method === 'GET' || method === 'DELETE' ? undefined : {}, T.a);
    if (r.status !== 403) leaks.push(`${method} ${p} → ${r.status}`);
  }
  assert.deepEqual(leaks, [], 'operator reached a route that is not theirs');
  // full order documents stay closed too (served outside the route table)
  assert.equal((await api('GET', `/invoice/${ids.order}.pdf`, null, T.a)).status, 404, 'no invoice for operators');
  assert.equal((await api('GET', `/invoice/${ids.order}`, null, T.a)).status, 404);
  assert.equal((await api('GET', `/invoice/${ids.order}.pdf`, null, T.support)).status, 200, 'legacy support keeps invoices');
  // what operators do get: reference, status and date only
  const orders = await api('GET', '/api/admin/team-orders', null, T.a);
  assert.equal(orders.status, 200);
  assert.deepEqual(Object.keys(orders.body[0]).sort(), ['created_at', 'id', 'status']);
  assert.ok(!JSON.stringify(orders.body).includes('Secret Street'));
  assert.equal((await api('GET', '/api/admin/team-orders')).status, 401, 'anonymous');
  assert.equal((await api('GET', '/api/me', null, T.a)).body.role, 'operator');
});

test('mail: each operator reads and replies only through their own alias', async () => {
  adminMail._resetStaffCheck();
  assert.deepEqual((await api('GET', '/api/admin/mailbox/status', null, T.a)).body, { addresses: ['support@kinan.shop'], configured: true });
  assert.equal((await api('GET', '/api/admin/mailbox/status', null, T.support)).status, 403, 'legacy support has no business email');
  assert.equal((await api('GET', '/api/admin/mailbox/status', null, T.admin)).status, 403, 'legacy admin (not owner) has no business email');
  assert.equal((await api('GET', '/api/admin/mailbox/status', null, T.owner)).body.addresses.length, 4, 'owner sees every alias');

  const inboxA = await api('GET', '/api/admin/mailbox/inbox?address=support@kinan.shop', null, T.a);
  assert.deepEqual(inboxA.body.messages.map((m) => m.id).sort(), ['m_both', 'm_support']);
  assert.equal((await api('GET', '/api/admin/mailbox/inbox?address=hello@kinan.shop', null, T.a)).status, 403, 'alias not assigned');
  assert.equal((await api('GET', '/api/admin/mailbox/messages/m_hello?address=hello@kinan.shop', null, T.a)).status, 403);
  assert.equal((await api('GET', '/api/admin/mailbox/messages/m_hello?address=support@kinan.shop', null, T.a)).status, 404, 'message id of another alias');
  assert.equal((await api('GET', '/api/admin/mailbox/messages/m_support?address=support@kinan.shop', null, T.a)).status, 200);
  assert.equal((await api('GET', '/api/admin/mailbox/messages/m_support?address=hello@kinan.shop', null, T.b)).status, 404, 'B cannot read A\'s message');
  assert.equal((await api('GET', '/api/admin/mailbox/messages/m_both?address=hello@kinan.shop', null, T.b)).status, 200, 'a message sent to both is visible to both');

  // replies: same alias, same thread; another alias's thread is refused
  const draft = { from: 'support@kinan.shop', subject: 'Re: parcel', text: 'It ships today.' };
  assert.equal((await api('POST', '/api/admin/mailbox/send', { ...draft, reply_to_id: 'm_hello', client_send_id: 'reply-0001' }, T.a)).status, 404);
  assert.equal((await api('POST', '/api/admin/mailbox/send', { ...draft, from: 'hello@kinan.shop', to: 'x@customer.example', client_send_id: 'reply-0002' }, T.a)).status, 403, 'cannot send as another alias');
  const reply = await api('POST', '/api/admin/mailbox/send', { ...draft, reply_to_id: 'm_support', client_send_id: 'reply-0003' }, T.a);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const last = gmail.sent.at(-1); const raw = Buffer.from(last.raw, 'base64url').toString();
  assert.equal(last.threadId, 'thr_m_support', 'stays in the customer thread');
  assert.match(raw, /^From: support@kinan\.shop/m); assert.match(raw, /^To: ann@customer\.example/m); assert.match(raw, /^In-Reply-To: <a1@customer\.example>/m);
});

test('mail: duplicate sends, provider errors, revoked aliases and missing setup', async () => {
  const draft = { from: 'support@kinan.shop', to: 'cust@customer.example', subject: 'Hello', text: 'Text' };
  const before = gmail.sent.length;
  const [one, two] = await Promise.all([api('POST', '/api/admin/mailbox/send', { ...draft, client_send_id: 'dup-000001' }, T.a), api('POST', '/api/admin/mailbox/send', { ...draft, client_send_id: 'dup-000001' }, T.a)]);
  assert.equal(gmail.sent.length, before + 1, 'a double click sends once');
  assert.equal(one.body.id, two.body.id);
  assert.equal((await api('POST', '/api/admin/mailbox/send', { ...draft, client_send_id: 'dup-000001' }, T.a)).body.duplicate, true, 'a retry later returns the first send');
  assert.equal((await api('POST', '/api/admin/mailbox/send', { ...draft, client_send_id: 'dup-000001' }, T.b)).status, 403, 'B cannot replay A\'s send from support@');
  assert.equal((await api('POST', '/api/admin/mailbox/send', { ...draft, client_send_id: 'bad id!' }, T.a)).status, 400);

  gmail.failSend = 1;
  assert.equal((await api('POST', '/api/admin/mailbox/send', { ...draft, client_send_id: 'fail-00001' }, T.a)).status, 502, 'provider error is reported');
  const retry = await api('POST', '/api/admin/mailbox/send', { ...draft, client_send_id: 'fail-00001' }, T.a);
  assert.equal(retry.status, 200, 'a failed send can be retried with the same id'); assert.ok(!retry.body.duplicate);

  // the connected Gmail is not the dedicated business account → employees are refused, the owner is not
  adminMail._resetStaffCheck(); gmail.primary = 'owner.personal@gmail.com';
  assert.equal((await api('GET', '/api/admin/mailbox/inbox?address=support@kinan.shop', null, T.a)).status, 503);
  assert.equal((await api('GET', '/api/admin/mailbox/status', null, T.a)).body.configured, false);
  assert.equal((await api('GET', '/api/admin/mailbox/inbox?address=support@kinan.shop', null, T.owner)).status, 200, 'owner keeps access');
  gmail.primary = 'team@kinan.shop';
  delete process.env.ADMIN_MAIL_STAFF_ACCOUNT; adminMail._resetStaffCheck();
  assert.equal((await api('GET', '/api/admin/mailbox/inbox?address=support@kinan.shop', null, T.a)).status, 503, 'no dedicated account set → employee mail off');
  process.env.ADMIN_MAIL_STAFF_ACCOUNT = MAIL_ENV.ADMIN_MAIL_STAFF_ACCOUNT;
  // the check is remembered (no Gmail call per request) once confirmed
  adminMail._resetStaffCheck(); const calls = gmail.profileCalls;
  await api('GET', '/api/admin/mailbox/status', null, T.a); await api('GET', '/api/admin/mailbox/status', null, T.a);
  assert.equal(gmail.profileCalls, calls + 1);

  // revoking an alias takes effect on the next request
  assert.equal((await api('PATCH', `/api/admin/team/${ids.a}`, { status: 'active', mailboxes: ['info@kinan.shop'] }, T.owner)).status, 200);
  assert.equal((await api('GET', '/api/admin/mailbox/inbox?address=support@kinan.shop', null, T.a)).status, 403);
  assert.equal((await api('PATCH', `/api/admin/team/${ids.a}`, { status: 'active', mailboxes: ['support@kinan.shop'] }, T.owner)).status, 200);
});

test('audit: employee sign-in/out, failed sign-ins, mail and order access, refused attempts — no contents', async () => {
  assert.equal((await api('POST', '/api/auth/login', { email: OP_A.email, password: 'wrong-password-1', app: 'admin' })).status, 401);
  assert.equal((await api('GET', '/api/admin/overview', null, T.a)).status, 403);
  await api('POST', '/api/admin/team/presence', null, T.a);
  const extra = await login(OP_A.email, OP_A.password); await api('POST', '/api/auth/logout', null, extra);
  const log = (await api('GET', `/api/admin/team/${ids.a}/activity`, null, T.owner)).body;
  const has = (fn, what) => assert.ok(log.some(fn), what);
  has((e) => e.path === '/api/auth/login' && e.status === 200, 'sign-in');
  has((e) => e.path === '/api/auth/login' && e.status === 401, 'failed sign-in');
  has((e) => e.path === '/api/auth/logout', 'sign-out');
  has((e) => e.path === '/api/admin/mailbox/inbox' && e.mailbox === 'support@kinan.shop', 'mailbox read with alias');
  has((e) => e.path === '/api/admin/mailbox/messages/:id' || (e.path.startsWith('/api/admin/mailbox/messages/') && e.mailbox), 'message opened');
  has((e) => e.path === '/api/admin/mailbox/send' && e.mailbox === 'support@kinan.shop' && /^sent_/.test(e.message_id || ''), 'send with provider id');
  has((e) => e.path === '/api/admin/team-orders' && e.status === 200, 'order status access');
  has((e) => e.path === '/api/admin/overview' && e.status === 403, 'refused attempt');
  assert.ok(!log.some((e) => e.path === '/api/admin/team/presence'), 'heartbeats are not logged');
  assert.doesNotMatch(JSON.stringify(log), /It ships today|Where is my parcel|cust@customer\.example|ann@customer|operator-A-pass|wrong-password|test-token/, 'no bodies, subjects, recipients, passwords or tokens');
  // B's log holds only B
  const logB = (await api('GET', `/api/admin/team/${ids.b}/activity`, null, T.owner)).body;
  assert.ok(logB.every((e) => e.actor?.id === ids.b));
});

test('presence and suspension: online, multiple sessions, suspend revokes, old tokens stay dead after reactivation', async () => {
  const second = await login(OP_B.email, OP_B.password);
  assert.equal((await api('POST', '/api/admin/team/presence', null, second)).status, 200);
  let b = (await api('GET', '/api/admin/team', null, T.owner)).body.find((m) => m.id === ids.b);
  assert.equal(b.online, true); assert.ok(b.last_seen);
  assert.equal((await api('PATCH', `/api/admin/team/${ids.b}`, { status: 'suspended' }, T.owner)).status, 200);
  for (const tok of [T.b, second]) assert.equal((await api('GET', '/api/admin/team-orders', null, tok)).status, 401, 'every session revoked');
  b = (await api('GET', '/api/admin/team', null, T.owner)).body.find((m) => m.id === ids.b);
  assert.equal(b.online, false); assert.equal(b.status, 'suspended');
  assert.equal((await api('POST', '/api/auth/login', { email: OP_B.email, password: OP_B.password, app: 'admin' })).status, 403, 'cannot sign in while suspended');
  assert.equal((await api('PATCH', `/api/admin/team/${ids.b}`, { status: 'active' }, T.owner)).status, 200);
  for (const tok of [T.b, second]) assert.equal((await api('GET', '/api/admin/team-orders', null, tok)).status, 401, 'old tokens stay invalid');
  const fresh = await login(OP_B.email, OP_B.password);
  assert.equal((await api('GET', '/api/admin/team-orders', null, fresh)).status, 200, 'a new sign-in works');
  assert.equal((await api('PATCH', `/api/admin/team/${ids.b}`, { status: 'deleted' }, T.owner)).status, 400);
  assert.equal((await api('PATCH', `/api/admin/team/${db.users.find((u) => u.email === 'legacy.support@x.com').id}`, { status: 'suspended' }, T.owner)).status, 404, 'this screen manages operators only');
});

test('deletion: only the owner deletes an operator; sessions end, sign-in stops, the email is free again, the audit trail stays', async () => {
  const body = { email: 'op.d@x.com', password: 'operator-D-pass', name: 'Operator D', role: 'operator', mailboxes: ['info@kinan.shop'] };
  const id = (await api('POST', '/api/admin/staff', body, T.owner)).body.id;
  const first = await login(body.email, body.password); const second = await login(body.email, body.password);
  assert.equal((await api('GET', '/api/admin/team-orders', null, first)).status, 200);
  assert.equal((await api('POST', '/api/admin/team/presence', null, first)).status, 200);
  db.tokens.insert({ kind: 'mail-send', token_hash: 'x', user_id: id, expires_at: Date.now() + 1e6 });
  assert.equal((await api('DELETE', `/api/admin/team/${id}`, null, first)).status, 403, 'an operator cannot delete anyone, not even themself');
  assert.equal((await api('DELETE', `/api/admin/team/${id}`)).status, 401, 'anonymous');
  const r = await api('DELETE', `/api/admin/team/${id}`, null, T.owner);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.deleted, true);
  for (const tok of [first, second]) assert.equal((await api('GET', '/api/admin/team-orders', null, tok)).status, 401, 'every session ended');
  assert.equal((await api('POST', '/api/auth/login', { email: body.email, password: body.password, app: 'admin' })).status, 401, 'cannot sign in again');
  assert.equal(db.users.get(id), undefined); assert.equal(db.sessions.all((s) => s.user_id === id).length, 0);
  assert.equal(db.tokens.all((t) => t.user_id === id).length, 0, 'pending send keys removed');
  assert.ok(!(await api('GET', '/api/admin/team', null, T.owner)).body.some((m) => m.id === id), 'gone from the list');
  const kept = (await api('GET', `/api/admin/audit?actor=${id}`, null, T.owner)).body;
  assert.ok(kept.some((e) => e.path === '/api/admin/team-orders' && e.actor.email === body.email), 'past activity stays in the audit log');
  assert.ok(db.audit.all((e) => e.path === `/api/admin/team/${id}` && e.method === 'DELETE' && e.actor?.owner).length, 'the deletion itself is audited');
  assert.equal((await api('DELETE', `/api/admin/team/${id}`, null, T.owner)).status, 404, 'already deleted');
  const legacy = db.users.find((u) => u.email === 'legacy.support@x.com').id;
  assert.equal((await api('DELETE', `/api/admin/team/${legacy}`, null, T.owner)).status, 404, 'operators only: older roles are untouched');
  const owner = db.users.find((u) => u.email === 'boss@x.com').id;
  assert.equal((await api('DELETE', `/api/admin/team/${owner}`, null, T.owner)).status, 404, 'never the owner');
  assert.ok(db.users.get(legacy) && db.users.get(owner));
  assert.equal((await api('POST', '/api/admin/staff', body, T.owner)).status, 201, 'the email can be used for a new employee');
});

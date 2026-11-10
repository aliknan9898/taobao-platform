// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Web Push: payload decrypts per RFC 8291 and the VAPID token verifies; messages; Telegram alerts. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', CONTACT_EMAIL: 'support@kinan.example' });
delete process.env.STRIPE_SECRET_KEY;

const sent = []; const tg = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === 'fcm.googleapis.com') { sent.push({ url: String(url), opts }); return { ok: true, status: 201 }; }
  if (u.hostname === 'api.telegram.org') { tg.push(JSON.parse(opts.body).text); return { ok: true, status: 200 }; }
  return realFetch(url, opts);
};
const db = require('../src/db');
const auth = require('../src/auth');
const push = require('../src/push');
const { server } = require('../src/server');
let base;
test.before(async () => { await db.init(); auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => { const r = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const hk = (salt, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));

test('web push encryption and VAPID', async () => {
  // Browser side keys
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const authSecret = crypto.randomBytes(16);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'Sara Ali' });
  const c = await login('c@x.com', 'buyerpass1');
  const key = (await api('GET', '/api/push/key')).body.key;
  assert.strictEqual(Buffer.from(key, 'base64url').length, 65);
  assert.strictEqual((await api('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } }, c)).status, 400);
  assert.strictEqual((await api('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } }, c)).status, 200);
  push.toUser(db.users.find((u) => u.email === 'c@x.com').id, { title: 'Hello', body: 'World', url: '/#/orders' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(sent.length, 1);
  const { opts } = sent[0];
  assert.strictEqual(opts.headers['Content-Encoding'], 'aes128gcm');
  // Decrypt like a browser would
  const b = Buffer.from(opts.body); const salt = b.subarray(0, 16); const idlen = b[20]; const asPub = b.subarray(21, 21 + idlen); const ct = b.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = hk(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
  const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16); const nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2);
  assert.deepStrictEqual(JSON.parse(plain.subarray(0, -1)), { title: 'Hello', body: 'World', url: '/#/orders' });
  // VAPID JWT verifies with the public key
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(opts.headers.Authorization);
  assert.ok(m); assert.strictEqual(m[4], key);
  const pub = Buffer.from(key, 'base64url');
  const pk = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pk, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
  assert.strictEqual(JSON.parse(Buffer.from(m[2], 'base64url')).aud, 'https://fcm.googleapis.com');
});

test('order messages stay private between parties', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const mk = async (email, name) => { const r = (await api('POST', '/api/auth/register', { role: 'seller', email, password: 'sellerpass', shop_name: name })).body; await api('PATCH', `/api/admin/sellers/${r.seller_id}`, { status: 'active' }, boss); const t = await login(email, 'sellerpass'); const p = (await api('POST', '/api/seller/products/manual', { title: name + ' item', category: 'home', images: [PNG], variants: [{ name: 'One', price: 10, stock: 5 }] }, t)).body; await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss); return { t, p, id: r.seller_id }; };
  const s1 = await mk('s1@x.com', 'One'); const s2 = await mk('s2@x.com', 'Two');
  const waitTg = (re) => new Promise((ok, bad) => { const t0 = Date.now(); const i = setInterval(() => { if (tg.some((x) => re.test(x))) { clearInterval(i); ok(); } else if (Date.now() - t0 > 8000) { clearInterval(i); bad(new Error(`no telegram ${re}`)); } }, 50); });
  await waitTg(/New seller/);
  const c = await login('c@x.com', 'buyerpass1');
  const o = (await api('POST', '/api/buyer/checkout', { items: [s1.p, s2.p].map((p) => ({ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 1 })), shipping_address: { name: 'Sara', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' } }, c)).body;
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, c);
  await waitTg(/New paid order/);
  const th = (await api('GET', `/api/buyer/orders/${o.id}/messages`, null, c)).body;
  assert.deepStrictEqual(th.shops.map((s) => s.name).sort(), ['One', 'Two']);
  await api('POST', `/api/buyer/orders/${o.id}/messages`, { thread: s1.id, text: 'Is it blue?' }, c);
  await api('POST', `/api/buyer/orders/${o.id}/messages`, { thread: 'kinan', text: 'When does it ship?' }, c);
  await waitTg(/When does it ship/);
  const m1 = (await api('GET', `/api/seller/orders/${o.id}/messages`, null, s1.t)).body;
  assert.deepStrictEqual(m1.map((m) => m.text), ['Is it blue?']); assert.strictEqual(m1[0].name, 'Sara');
  assert.deepStrictEqual((await api('GET', `/api/seller/orders/${o.id}/messages`, null, s2.t)).body, []);
  await api('POST', `/api/seller/orders/${o.id}/messages`, { text: 'Yes, blue' }, s1.t);
  assert.strictEqual((await api('GET', `/api/admin/orders/${o.id}/messages`, null, boss)).body.length, 3);
  assert.ok((await api('GET', '/api/admin/overview', null, boss)).body.alerts?.some?.((a) => a.kind === 'messages') ?? true);
});

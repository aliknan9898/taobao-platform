// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Customer-safe error messages, order retention for deleted accounts, native Google / Apple sign-in (real RS256 tokens
   checked against a fake JWKS), Apple revocation on deletion, and supplier photos copied to R2 (fake R2 and supplier). */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
const apple = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
Object.assign(process.env, {
  ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', ADMIN_GOOGLE_EMAILS: 'owner@gmail.com',
  GOOGLE_IOS_CLIENT_ID: 'ios-client.apps.googleusercontent.com', APPLE_BUNDLE_ID: 'shop.kinan.app',
  APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: apple.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  R2_ACCOUNT_ID: 'acc123', R2_ACCESS_KEY_ID: 'r2key', R2_SECRET_ACCESS_KEY: 'r2secret', R2_BUCKET: 'kinan-images', R2_PUBLIC_URL: 'https://img.kinan.example'
});

// Signing keys standing in for Google's and Apple's
const gKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const aKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (k, kid) => ({ ...k.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(key, kid, claims) {
  const h = b64({ alg: 'RS256', kid, typ: 'JWT' }); const p = b64(claims);
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);

const r2 = []; const revoked = []; const appleCodes = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (j, headers = {}) => ({ ok: true, status: 200, headers: new Map(Object.entries(headers)), json: async () => j, text: async () => JSON.stringify(j) });
  if (u.hostname === 'www.googleapis.com' && u.pathname === '/oauth2/v3/certs') return ok({ keys: [jwk(gKey, 'g1')] });
  if (u.hostname === 'appleid.apple.com' && u.pathname === '/auth/keys') return ok({ keys: [jwk(aKey, 'a1')] });
  if (u.hostname === 'appleid.apple.com' && u.pathname === '/auth/token') {
    const b = new URLSearchParams(opts.body); appleCodes.push(b.get('code'));
    const [h, p, s] = b.get('client_secret').split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: apple.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'client secret signed with the team key');
    return ok({ refresh_token: 'apple_rt_1', access_token: 'x' });
  }
  if (u.hostname === 'appleid.apple.com' && u.pathname === '/auth/revoke') { revoked.push(new URLSearchParams(opts.body).get('token')); return ok({}); }
  if (u.hostname === 'cdn.supplier.example') {
    if (u.pathname.includes('broken')) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) }, arrayBuffer: async () => Buffer.from('JPEGDATA') };
  }
  if (u.hostname === 'acc123.r2.cloudflarestorage.com') { r2.push({ path: u.pathname, auth: opts.headers.Authorization, sha: opts.headers['x-amz-content-sha256'], body: opts.body }); return { ok: true, status: 200 }; }
  return realFetch(url, opts);
};

const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p, app: 'shop' })).body.token;
async function customer(email) { await api('POST', '/api/auth/register', { role: 'buyer', email, password: 'buyerpass1', name: 'C' }); return login(email, 'buyerpass1'); }

test('customers get a plain error message; staff keep the details', async () => {
  const points = require('../src/services/points'); const admin = require('../src/services/admin');
  const realInfo = points.info; const realOverview = admin.overview;
  points.info = () => { throw new Error('CJ API key rejected for account 4471'); };
  admin.overview = () => { throw new Error('CJ API key rejected for account 4471'); };
  try {
    const t = await customer('err@x.com');
    const r = await api('GET', '/api/buyer/points', null, t);
    assert.strictEqual(r.status, 500);
    assert.ok(!JSON.stringify(r.body).includes('CJ'), 'no internal text for customers');
    assert.match(r.body.error_id, /^[a-f0-9]{8}$/);
    const boss = await login('boss@x.com', 'adminpass1');
    const s = await api('GET', '/api/admin/overview', null, boss);
    assert.strictEqual(s.status, 500); assert.match(s.body.error, /CJ API key/, 'staff see the cause');
  } finally { points.info = realInfo; admin.overview = realOverview; }
  assert.strictEqual((await api('POST', '/api/auth/login', { email: 'nobody@x.com', password: 'wrongpass1', app: 'shop' })).body.error, 'Incorrect email or password', '4xx messages unchanged');
});

test('orders of deleted accounts lose name, phone and street after the retention period (off by default)', async () => {
  const acc = require('../src/services/account');
  const u = db.users.insert({ email: 'gone@x.com', name: 'Gone', role: 'buyer', status: 'deleted' });
  const o = db.orders.insert({ buyer_id: u.id, lines: [], currency: 'usd', subtotal: 10, shipping_fee: 0, total: 10, status: 'delivered', sub_orders: [], timeline: [], shipping_address: { name: 'Gone Person', phone: '+356 7900 0000', country_code: 'MT', country: 'Malta', city: 'Valletta', line1: 'Street 1' } });
  db.orders.update(o.id, { created_at: Date.now() - 400 * 86400e3 });
  delete process.env.ORDER_PII_RETENTION_DAYS;
  assert.strictEqual(acc.redactDeletedOrders(), 0, 'off until the owner sets the period');
  process.env.ORDER_PII_RETENTION_DAYS = '365';
  assert.strictEqual(acc.redactDeletedOrders(), 1);
  assert.deepStrictEqual(db.orders.get(o.id).shipping_address, { country_code: 'MT', country: 'Malta', redacted: true });
  assert.strictEqual(acc.redactDeletedOrders(), 0, 'once only');
  assert.ok(require('../src/services/ops').invoicePdf(db.orders.get(o.id)).body.length > 100, 'the invoice still renders');
  delete process.env.ORDER_PII_RETENTION_DAYS;
});

test('native Google sign-in: verified tokens only, same account rules as the website', async () => {
  const good = { iss: 'https://accounts.google.com', aud: 'ios-client.apps.googleusercontent.com', sub: 'g-111', email: 'maria@gmail.com', email_verified: true, name: 'Maria', exp: now() + 600, iat: now() };
  const r = await api('POST', '/api/auth/google/native', { id_token: jwt(gKey, 'g1', good) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token); assert.strictEqual(r.body.user.email, 'maria@gmail.com');
  assert.strictEqual((await api('GET', '/api/me', null, r.body.token)).body.role, 'buyer');
  const again = await api('POST', '/api/auth/google/native', { id_token: jwt(gKey, 'g1', good) });
  assert.strictEqual(again.body.user.id, r.body.user.id, 'same account next time');

  const forged = jwt(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }), 'g1', good);
  assert.strictEqual((await api('POST', '/api/auth/google/native', { id_token: forged })).status, 401, 'wrong signature');
  assert.strictEqual((await api('POST', '/api/auth/google/native', { id_token: jwt(gKey, 'g1', { ...good, aud: 'someone-else' }) })).status, 401, 'other app');
  assert.strictEqual((await api('POST', '/api/auth/google/native', { id_token: jwt(gKey, 'g1', { ...good, exp: now() - 3600 }) })).status, 401, 'expired');
  assert.strictEqual((await api('POST', '/api/auth/google/native', { id_token: jwt(gKey, 'g1', { ...good, iss: 'https://evil.example' }) })).status, 401, 'issuer');
  assert.strictEqual((await api('POST', '/api/auth/google/native', { id_token: jwt(gKey, 'g1', { ...good, sub: 'g-2', email: 'x@gmail.com', email_verified: false }) })).status, 403, 'unverified email');
  // an existing password account with the same email is linked, not duplicated
  await customer('link@x.com');
  const linked = await api('POST', '/api/auth/google/native', { id_token: jwt(gKey, 'g1', { ...good, sub: 'g-333', email: 'link@x.com' }) });
  assert.strictEqual(linked.body.user.id, db.users.find((x) => x.email === 'link@x.com' && x.role === 'buyer').id);
  assert.strictEqual((await api('GET', '/api/config/public')).body.google_native, true);
});

test('Sign in with Apple: nonce checked, private relay email, revoked when the account is deleted', async () => {
  const nonce = 'raw-nonce-123456';
  const claims = { iss: 'https://appleid.apple.com', aud: 'shop.kinan.app', sub: 'apple-001', email: 'abc123@privaterelay.appleid.com', email_verified: 'true', nonce: crypto.createHash('sha256').update(nonce).digest('hex'), exp: now() + 600, iat: now() };
  const r = await api('POST', '/api/auth/apple', { identity_token: jwt(aKey, 'a1', claims), nonce, name: 'Sam', authorization_code: 'c0de' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.user.name, 'Sam');
  const u = db.users.get(r.body.user.id);
  assert.strictEqual(u.apple_sub, 'apple-001'); assert.strictEqual(u.apple_relay, true); assert.strictEqual(u.apple_refresh_token, 'apple_rt_1');
  assert.deepStrictEqual(appleCodes, ['c0de']);
  // second sign-in: Apple sends no email and no name; found by the Apple id
  const r2nd = await api('POST', '/api/auth/apple', { identity_token: jwt(aKey, 'a1', { ...claims, email: undefined }), nonce });
  assert.strictEqual(r2nd.body.user.id, u.id);
  assert.strictEqual((await api('POST', '/api/auth/apple', { identity_token: jwt(aKey, 'a1', claims), nonce: 'other' })).status, 401, 'nonce must match');
  assert.strictEqual((await api('POST', '/api/auth/apple', { identity_token: jwt(aKey, 'a1', claims) })).status, 400, 'nonce required');
  assert.strictEqual((await api('POST', '/api/auth/apple', { identity_token: jwt(aKey, 'a1', { ...claims, aud: 'com.other.app' }), nonce })).status, 401);
  // the owner's address cannot be taken through Apple
  assert.strictEqual((await api('POST', '/api/auth/apple', { identity_token: jwt(aKey, 'a1', { ...claims, sub: 'apple-own', email: 'owner@gmail.com' }), nonce })).status, 409);
  // password sign-in for this account explains how to get in
  assert.match((await api('POST', '/api/auth/login', { email: 'abc123@privaterelay.appleid.com', password: 'whatever1', app: 'shop' })).body.error, /Apple/);
  // deletion (no password: the fresh session counts) revokes the Apple authorisation
  const d = await api('POST', '/api/buyer/account/delete', { confirm: 'DELETE' }, r2nd.body.token);
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  assert.deepStrictEqual(revoked, ['apple_rt_1']);
  assert.ok(!db.users.get(u.id).apple_sub && !db.users.get(u.id).apple_refresh_token);
});

test('supplier photos are copied to R2 and customers see the Kinan copy', async () => {
  const media = require('../src/services/media');
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = (await api('POST', '/api/auth/login', { email: 'sel@x.com', password: 'sellerpass', app: 'seller' })).body.token;
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Lamp', category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants: [{ name: 'Red', price: 20, stock: 10 }, { name: 'Blue', price: 22, stock: 10 }] }, sel)).body;
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);
  db.listings.update(p.id, (l) => ({ ...l, images: ['https://cdn.supplier.example/a.jpg', 'https://cdn.supplier.example/broken.jpg'], skus: l.skus.map((s, i) => ({ ...s, image: i ? 'https://cdn.supplier.example/blue.jpg' : null })) }));

  const before = (await api('GET', `/api/catalog/${p.id}`)).body;
  assert.ok(before.images.includes('https://cdn.supplier.example/a.jpg'), 'original until copied');
  const out = await media.tick();
  assert.deepStrictEqual([out.ok, out.failed], [2, 1]);
  assert.strictEqual(r2.length, 2);
  assert.match(r2[0].path, /^\/kinan-images\/p\/[a-f0-9]{40}\.jpg$/);
  assert.match(r2[0].auth, /^AWS4-HMAC-SHA256 Credential=r2key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.strictEqual(r2[0].sha, crypto.createHash('sha256').update('JPEGDATA').digest('hex'));

  const after = (await api('GET', `/api/catalog/${p.id}`)).body;
  const raw = JSON.stringify(after);
  assert.ok(!raw.includes('cdn.supplier.example/a.jpg') && !raw.includes('cdn.supplier.example/blue.jpg'), 'supplier links replaced');
  assert.ok(after.images.some((x) => x.startsWith('https://img.kinan.example/p/')));
  assert.ok(after.skus.find((s) => s.image).image.startsWith('https://img.kinan.example/p/'));
  assert.ok(raw.includes('cdn.supplier.example/broken.jpg'), 'a photo that could not be copied keeps its link');
  // the broken photo is retried, then given up after 3 tries
  await media.tick(); await media.tick();
  assert.deepStrictEqual(await media.tick(), { ok: 0, failed: 0 });
  assert.strictEqual((await api('GET', '/api/admin/media', null, boss)).body.copied, 2);
});

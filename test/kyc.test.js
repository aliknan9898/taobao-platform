// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Seller identity verification: details + document + live selfie → pending → admin approves or asks for a correction. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example' });
const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j, type: res.headers.get('content-type') };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const PNG = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '../public/assets/icon-192.png')).toString('base64')}`;
const form = { full_name: 'Ali Kinan', date_of_birth: '1990-05-01', nationality: 'SY', country: 'MT', city: 'Valletta', address: 'Main St 1', phone: '+356 7900 0000', shop_name: 'Ali Store', business_type: 'individual', id_type: 'national_id', id_number: 'A123456', agree: true, id_front: PNG, id_back: PNG, selfie: PNG, selfie_live: true };

test('seller verifies identity, admin asks for a correction, then approves', async () => {
  await api('POST', '/api/auth/register', { role: 'seller', email: 's@x.com', password: 'sellerpass', shop_name: 'Tmp', name: 'S' });
  const t = await login('s@x.com', 'sellerpass');
  const boss = await login('boss@x.com', 'adminpass1');
  assert.strictEqual((await api('GET', '/api/seller/me', null, t)).body.verification.state, 'none');

  assert.match((await api('POST', '/api/seller/verification', { ...form, selfie: null }, t)).body.error, /selfie/);
  assert.match((await api('POST', '/api/seller/verification', { ...form, date_of_birth: '2015-01-01' }, t)).body.error, /18/);
  assert.match((await api('POST', '/api/seller/verification', { ...form, id_front: 'data:text/html;base64,AAAA' }, t)).body.error, /photo/);
  const r = await api('POST', '/api/seller/verification', form, t);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.state, 'submitted'); assert.strictEqual(r.body.has.selfie, true);
  const me = (await api('GET', '/api/seller/me', null, t)).body;
  assert.strictEqual(me.status, 'pending'); assert.strictEqual(me.shop_name, 'Ali Store');
  assert.strictEqual(JSON.stringify(db.sellers.all()).includes('base64'), false, 'photos are not stored on the seller record');

  // Only admins open the photos
  assert.strictEqual((await api('GET', `/api/admin/sellers/${me.id}/verification/selfie`, null, t)).status, 403);
  const ph = await api('GET', `/api/admin/sellers/${me.id}/verification/selfie`, null, boss);
  assert.strictEqual(ph.status, 200); assert.strictEqual(ph.type, 'image/png');
  const list = (await api('GET', '/api/admin/sellers', null, boss)).body;
  assert.strictEqual(list.find((x) => x.id === me.id).verification.state, 'submitted');
  assert.ok((await api('GET', '/api/admin/overview', null, boss)).body.alerts.some((a) => a.kind === 'seller_kyc'));

  assert.strictEqual((await api('POST', `/api/admin/sellers/${me.id}/verification`, { approve: false }, boss)).status, 400, 'a reason is needed');
  await api('POST', `/api/admin/sellers/${me.id}/verification`, { approve: false, reason: 'The document photo is blurry' }, boss);
  let v = (await api('GET', '/api/seller/verification', null, t)).body;
  assert.strictEqual(v.state, 'rejected'); assert.strictEqual(v.reason, 'The document photo is blurry'); assert.strictEqual(v.details.id_number, 'A123456');

  // Correction: send only a new front photo, earlier back photo and selfie are kept
  const r2 = await api('POST', '/api/seller/verification', { ...form, id_back: null, selfie: null, selfie_live: false }, t);
  assert.strictEqual(r2.body.state, 'submitted'); assert.strictEqual(r2.body.has.id_back, true);
  await api('POST', `/api/admin/sellers/${me.id}/verification`, { approve: true }, boss);
  assert.strictEqual((await api('GET', '/api/seller/me', null, t)).body.status, 'active');
  assert.strictEqual((await api('POST', '/api/seller/verification', form, t)).status, 409);
});

test('admin cannot activate an unverified seller; unverified active shops go back to pending', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 'u@x.com', password: 'sellerpass', shop_name: 'U' })).body;
  assert.strictEqual((await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active' }, boss)).status, 409);
  db.sellers.update(reg.seller_id, { status: 'active' }); // a shop approved before verification existed
  assert.strictEqual(require('../src/services/kyc').enforce(), 1);
  assert.strictEqual(db.sellers.get(reg.seller_id).status, 'pending');
});

test('emails: seller under review, seller approved (with app notice), customer welcome — all with the Kinan logo', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  await api('POST', '/api/auth/register', { role: 'seller', email: 'm@x.com', password: 'sellerpass', shop_name: 'M' });
  const t = await login('m@x.com', 'sellerpass');
  await api('POST', '/api/seller/verification', { ...form, shop_name: 'Mona Shop' }, t);
  const id = (await api('GET', '/api/seller/me', null, t)).body.id;
  const mail = () => db.mail.all((m) => m.to === 'm@x.com').map((m) => m.subject);
  assert.ok(mail().some((x) => /under review/.test(x) && /قيد المراجعة/.test(x)));
  await api('POST', `/api/admin/sellers/${id}/verification`, { approve: true }, boss);
  assert.ok(mail().some((x) => /تم فتح حسابك بنجاح/.test(x)));
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'cust@x.com', password: 'buyerpass1', name: 'Sara Ali' });
  assert.ok(db.mail.all((m) => m.to === 'cust@x.com').some((m) => /Welcome to Kinan/.test(m.subject)));
  const html = require('../src/mailer').layout({ title: 'T', lines: ['a'], ar: { title: 'مرحبا', lines: ['ب'] }, highlight: { label: 'Code', value: 'WELCOME10' }, app: 'seller' });
  assert.match(html, /https:\/\/kinan\.example\/assets\/icon-seller-192\.png/); assert.match(html, /dir="rtl"/); assert.match(html, /WELCOME10/);
});

'use strict';
/* Control centre: maintenance and pauses block the right things and never the webhooks, staff apps or sign-in. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
const db = require('../src/db');
const C = require('../src/services/appControl');
const { server } = require('../src/server');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const admin = db.users.insert({ email: 'a@kinan.test', role: 'admin', name: 'A', status: 'active' });
const nobody = () => null; const staff = () => ({ role: 'admin' }); const buyer = () => ({ role: 'buyer' });

test('defaults: everything open', () => {
  const s = C.status();
  assert.deepStrictEqual([s.shop, s.seller, s.checkout, s.signups], ['open', 'open', true, true]);
  assert.strictEqual(C.gate('GET', '/', nobody), null);
});

test('shop maintenance: pages and shop API held, webhooks, staff apps, sign-in and seller untouched', () => {
  C.set({ shop: 'maintenance' }, admin);
  assert.strictEqual(C.gate('GET', '/', nobody).kind, 'maintenance');
  assert.strictEqual(C.gate('GET', '/p/lst_1', buyer).kind, 'maintenance');
  assert.strictEqual(C.gate('GET', '/api/catalog', nobody).api, true);
  for (const p of ['/webhooks/stripe', '/webhooks/taobao', '/webhooks/cj', '/admin', '/api/admin/orders', '/warehouse', '/api/warehouse/receive', '/api/auth/login', '/oauth/callback', '/healthz', '/assets/kinan.css', '/terms', '/api/app-status'])
    assert.strictEqual(C.gate('POST', p, nobody), null, p);
  assert.strictEqual(C.gate('GET', '/seller', nobody), null, 'Seller Center stays open');
  assert.strictEqual(C.gate('GET', '/', staff), null, 'staff can check the shop');
  C.set({ shop: 'open' }, admin);
});

test('checkout pause holds only paying; sign-up pause holds only new accounts', () => {
  C.set({ checkout: false, signups: false }, admin);
  assert.strictEqual(C.gate('GET', '/api/catalog', nobody), null);
  assert.strictEqual(C.gate('POST', '/api/buyer/checkout', buyer).kind, 'checkout');
  assert.strictEqual(C.gate('POST', '/api/buyer/orders/ord_1/card-payment', buyer).kind, 'checkout');
  assert.strictEqual(C.gate('POST', '/api/auth/register', nobody).kind, 'signups');
  assert.strictEqual(C.gate('POST', '/api/auth/login', nobody), null);
  C.set({ checkout: true, signups: true }, admin);
});

test('validation and the maintenance page', () => {
  assert.throws(() => C.set({ shop: 'closed' }, admin), /open or maintenance/);
  assert.throws(() => C.set({ until: 'not a date' }, admin), /valid date/);
  C.set({ message_en: 'Back at <b>10</b>', message_ar: 'نعود الساعة 10', until: '2026-12-01T10:00:00Z' }, admin);
  const html = C.page('shop');
  assert.match(html, /Back at &lt;b&gt;10&lt;\/b&gt;/, 'message is escaped');
  assert.match(html, /نعود الساعة 10/);
  assert.match(html, /2026-12-01 10:00 UTC/);
  assert.match(C.page('seller'), /logo-seller\.png/);
});

test('over HTTP: 503 page with Retry-After, JSON for the API, webhooks still answered', async () => {
  C.set({ shop: 'maintenance' }, admin);
  const r = await fetch(base + '/'); assert.strictEqual(r.status, 503); assert.ok(r.headers.get('retry-after'));
  assert.match(await r.text(), /We’ll be right back/);
  const a = await fetch(base + '/api/catalog'); assert.strictEqual(a.status, 503); assert.strictEqual((await a.json()).maintenance, true);
  assert.notStrictEqual((await fetch(base + '/webhooks/ebay/deletion', { method: 'POST', body: '{}' })).status, 503);
  assert.strictEqual((await fetch(base + '/healthz')).status, 200);
  assert.strictEqual((await (await fetch(base + '/api/app-status')).json()).shop, 'maintenance');
  C.set({ shop: 'open' }, admin);
  assert.strictEqual((await fetch(base + '/')).status, 200);
});

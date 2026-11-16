// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Coupons, referral reward, saved items alerts, reviews, cart reminders. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grow-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', REFERRAL_REWARD: '5' });
delete process.env.STRIPE_SECRET_KEY;

const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j, headers: res.headers };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('seller selects and removes products', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email: 'r@x.com', password: 'sellerpass', shop_name: 'R' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('r@x.com', 'sellerpass');
  const mk = async (t) => (await api('POST', '/api/seller/products/manual', { title: t, category: 'home', weight_kg: 0.5, images: [PNG], variants: [{ name: 'One', price: 50, stock: 5 }] }, sel)).body;
  const a = await mk('Lamp'); const b = await mk('Mug'); const c = await mk('Bowl');
  const other = (await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email: 'o@x.com', password: 'sellerpass', shop_name: 'O' })).body;
  const r = (await api('POST', '/api/seller/products/remove', { ids: [a.id, b.id, 'nope'] }, sel)).body;
  assert.strictEqual(r.removed, 2);
  const left = (await api('GET', '/api/seller/products', null, sel)).body.map((x) => x.id);
  assert.deepStrictEqual(left, [c.id]);
  assert.strictEqual(db.listings.get(a.id).status, 'removed');
  // cannot remove another seller's product
  const osel = await login('o@x.com', 'sellerpass');
  assert.strictEqual((await api('POST', '/api/seller/products/remove', { ids: [c.id] }, osel)).body.removed, 0);
  assert.ok(other.seller_id);
});
test('admin uploads a site verification file, served at the root', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const r = await api('POST', '/api/admin/verify-files', { name: 'banggood_verify_abc123.html', content: 'bg-token-xyz' }, boss);
  assert.strictEqual(r.status, 200);
  const res = await fetch(`${base}/banggood_verify_abc123.html`);
  assert.strictEqual(await res.text(), 'bg-token-xyz');
  assert.strictEqual((await api('POST', '/api/admin/verify-files', { name: 'evil.js', content: 'x' }, boss)).status, 400);
});

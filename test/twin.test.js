// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* One email, two accounts: a Kinan Shop customer and a Seller Center seller, signed in at the same time. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example' });
const auth = require('../src/auth');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

test('same email: customer and seller accounts, separate sign-ins', async () => {
  const E = 'Same@Gmail.com';
  assert.strictEqual((await call('POST', '/api/auth/register', { role: 'buyer', email: E, password: 'buyerpass1', name: 'Sam' })).status < 300, true);
  assert.strictEqual((await call('POST', '/api/auth/register', { role: 'seller', email: E, password: 'sellerpass9', shop_name: 'Sam Shop' })).status < 300, true);
  assert.strictEqual((await call('POST', '/api/auth/register', { role: 'seller', email: E, password: 'x12345678', shop_name: 'Again' })).status, 409, 'one seller account per email');
  // Staff emails stay unique
  assert.strictEqual((await call('POST', '/api/auth/register', { role: 'buyer', email: 'boss@x.com', password: 'whatever12' })).status, 409);

  const shop = await call('POST', '/api/auth/login', { email: E, password: 'buyerpass1', app: 'shop' });
  const seller = await call('POST', '/api/auth/login', { email: E, password: 'sellerpass9', app: 'seller' });
  assert.match(cookieOf(shop), /^sid=/); assert.match(cookieOf(seller), /^ssid=/);
  const both = `${cookieOf(shop)}; ${cookieOf(seller)}`;
  // The browser holds both cookies: each app sees its own account
  assert.strictEqual((await (await call('GET', '/api/me', null, { cookie: both })).json()).role, 'buyer');
  assert.strictEqual((await (await call('GET', '/api/me', null, { cookie: both, 'X-Kinan-App': 'seller' })).json()).role, 'seller');
  assert.strictEqual((await (await call('GET', '/api/seller/me', null, { cookie: both })).json()).shop_name, 'Sam Shop');
  // Wrong app password does not open the other account
  assert.strictEqual((await call('POST', '/api/auth/login', { email: E, password: 'buyerpass1', app: 'seller' })).status, 401);
  // Signing out of the Seller Center keeps the customer signed in
  const out = await call('POST', '/api/auth/logout', null, { cookie: both, 'X-Kinan-App': 'seller' });
  assert.match(out.headers.get('set-cookie'), /^ssid=;/);
  assert.strictEqual((await (await call('GET', '/api/me', null, { cookie: both })).json()).role, 'buyer');
  assert.strictEqual((await call('GET', '/api/me', null, { cookie: both, 'X-Kinan-App': 'seller' })).status, 401);
});

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Seller account statement PDF: balances add up, only the seller can download it. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example' });
const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), r };
};
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;

test('seller downloads an account statement PDF', async () => {
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, await login('boss@x.com', 'adminpass1'));
  const sel = await login('sel@x.com', 'sellerpass');
  db.ledger.insert({ seller_id: reg.seller_id, order_id: 'ord_1111222233334444', type: 'sale', currency: 'usd', gross: 50, commission: 5, cost: 20, net: 25, status: 'payable' });
  db.payouts.insert({ seller_id: reg.seller_id, amount: 10, currency: 'usd', details: { method: 'paypal', email: 'p@x.com' }, status: 'paid', paid_at: Date.now() });
  const r = await fetch(`${base}/api/seller/statement.pdf`, { headers: { Authorization: `Bearer ${sel}` } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /Kinan-statement-Atlas-\d{4}-\d{2}-01_\d{4}-\d{2}-\d{2}\.pdf/);
  const buf = Buffer.from(await r.arrayBuffer()); assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  const ops = require('../src/services/ops');
  assert.throws(() => ops.statementPeriod('2026-12-01', '2026-11-01'), /start date/);
  assert.strictEqual((await fetch(`${base}/api/seller/statement.pdf?from=2026-12-01&to=2026-11-01`, { headers: { Authorization: `Bearer ${sel}` } })).status, 400);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'b@x.com', password: 'buyerpass1', name: 'B' });
  assert.strictEqual((await fetch(`${base}/api/seller/statement.pdf`, { headers: { Authorization: `Bearer ${await login('b@x.com', 'buyerpass1')}` } })).status, 403);
});

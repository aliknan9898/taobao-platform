// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Backups (download + daily email), invoices, product views, bulk CSV upload. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opsp-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', BREVO_API_KEY: 'k', MAIL_FROM: 'noreply@kinan.example' });
delete process.env.STRIPE_SECRET_KEY;
let mailed = null;
const realFetch = global.fetch;
global.fetch = async (url, opts) => { if (/api\.brevo\.com\/v3\/smtp/.test(String(url))) { const b = JSON.parse(opts.body); if (b.attachment) mailed = b; return { ok: true, status: 201, text: async () => '{}' }; } if (/api\.brevo\.com/.test(String(url))) return { ok: false, status: 404, text: async () => '{}' }; return realFetch(url, opts); };

const auth = require('../src/auth');
const db = require('../src/db');
const ops = require('../src/services/ops');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer()); let j; try { j = JSON.parse(buf.toString()); } catch { j = buf; }
  return { status: res.status, body: j, headers: res.headers };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;

test('ops features', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 's@x.com', password: 'sellerpass', shop_name: 'S' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('s@x.com', 'sellerpass');

  // bulk: two rows same title → one product with 2 options; one bad row
  const r = (await api('POST', '/api/seller/products/bulk', { rows: [
    { title: 'Jacket', price: '39', stock: '5', option: 'L', image_urls: 'https://img.alicdn.com/a.jpg', category: 'men' },
    { title: 'Jacket', price: '', cost_cny: '144', option: 'XL', image_urls: '' },
    { title: 'No photo item', price: '10' }
  ] }, sel)).body;
  assert.strictEqual(r.created, 1); assert.strictEqual(r.failed, 1);
  const l = db.listings.get(r.results.find((x) => x.ok).id);
  assert.strictEqual(l.skus.length, 2); assert.ok(l.skus[1].price > 0, 'price from markup');
  await api('POST', `/api/admin/listings/${l.id}/approve`, null, boss);

  // views
  for (let i = 0; i < 3; i++) await api('GET', `/api/catalog/${l.id}`);
  const st = (await api('GET', '/api/seller/stats', null, sel)).body;
  assert.strictEqual(st.views, 1, 'one view per visitor per hour'); assert.strictEqual(st.products[0].views, 1);

  // invoice
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'Sara' });
  const c = await login('c@x.com', 'buyerpass1');
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: l.id, mp_sku_id: l.skus[0].mp_sku_id, qty: 1 }], shipping_address: { name: 'Sara', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' } }, c)).body;
  assert.strictEqual((await api('GET', `/invoice/${o.id}`, null, c)).status, 404, 'unpaid');
  await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, c);
  const inv = await api('GET', `/invoice/${o.id}`, null, c);
  assert.strictEqual(inv.status, 200); assert.match(inv.body.toString(), /Invoice[\s\S]*Jacket[\s\S]*Total/);
  assert.strictEqual((await api('GET', `/invoice/${o.id}`, null, sel)).status, 404, 'sellers cannot open customer invoices');

  // backup download + email
  const bk = await api('GET', '/api/admin/backup', null, boss);
  assert.strictEqual(bk.status, 200);
  const data = JSON.parse(zlib.gunzipSync(bk.body));
  assert.ok(data.collections.orders.length === 1 && !data.collections.sessions);
  const sent = await ops.dailyBackup();
  assert.strictEqual(sent.status, 'sent'); assert.match(mailed.attachment[0].name, /kinan-backup-.*\.zip$/); assert.strictEqual(Buffer.from(mailed.attachment[0].content, 'base64').readUInt32LE(0), 0x04034b50, 'a real zip (Brevo refuses .gz)');
  assert.strictEqual((await ops.dailyBackup()).skipped, 'already sent today');
});

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* PDF invoice: sent with the order confirmation, downloadable only by the buyer, Arabic text shaped. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example' });

const mailer = require('../src/mailer');
const sent = []; const realSend = mailer.send;
mailer.send = async (m) => { sent.push(m); return realSend(m); };
const auth = require('../src/auth');
const { server } = require('../src/server');
const { visual } = require('../src/pdf');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;

test('Arabic is joined and laid out right to left', () => {
  // "كنان" → presentation forms, drawn right to left (final noon stands alone after alef)
  assert.deepStrictEqual(visual('كنان'), [0xFEE5, 0xFE8E, 0xFEE8, 0xFEDB]);
  assert.deepStrictEqual(visual('لا'), [0xFEFB], 'lam-alef ligature');
  // Latin and numbers inside Arabic keep their order
  const v = String.fromCodePoint(...visual('طلب 123 Kinan'));
  assert.ok(v.startsWith('Kinan 123 '), v);
  assert.deepStrictEqual(visual('abc'), [97, 98, 99]);
});

test('after payment the buyer gets the PDF invoice and can download it', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('sel@x.com', 'sellerpass');
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Lamp', category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants: [{ name: 'One', price: 20, stock: 10 }] }, sel)).body;
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'سارة' });
  const cust = await login('c@x.com', 'buyerpass1');
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: p.id, mp_sku_id: p.skus[0].mp_sku_id, qty: 2 }], shipping_address: { name: 'سارة أحمد', phone: '+35679000000', country_code: 'MT', city: 'Valletta', line1: 'Triq il-Kbira 10' } }, cust)).body;
  assert.strictEqual((await fetch(`${base}/invoice/${o.id}.pdf`, { headers: { Authorization: `Bearer ${cust}` } })).status, 404, 'no invoice before payment');
  assert.strictEqual((await api('POST', `/api/buyer/orders/${o.id}/demo-pay`, null, cust)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const conf = sent.find((m) => m.key === `paid:${o.id}`);
  assert.ok(conf, 'confirmation sent');
  assert.strictEqual(conf.attachments.length, 1);
  assert.match(conf.attachments[0].name, /^Kinan-invoice-KN-\d{4}-[A-F0-9]{8}\.pdf$/);
  const pdf = Buffer.from(conf.attachments[0].content, 'base64');
  assert.strictEqual(pdf.slice(0, 8).toString('latin1'), '%PDF-1.7');
  assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'));
  const r = await fetch(`${base}/invoice/${o.id}.pdf`, { headers: { Authorization: `Bearer ${cust}` } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
  // another customer cannot download it
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'd@x.com', password: 'buyerpass1', name: 'D' });
  assert.strictEqual((await fetch(`${base}/invoice/${o.id}.pdf`, { headers: { Authorization: `Bearer ${await login('d@x.com', 'buyerpass1')}` } })).status, 404);
});

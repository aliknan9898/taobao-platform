// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* robots.txt, sitemap, Google Merchant feed, product JSON-LD, analytics CSP + verification tag. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', GA_MEASUREMENT_ID: 'G-ABC123', CLARITY_PROJECT_ID: 'abcd1234', GOOGLE_SITE_VERIFICATION: 'verify-me_1' });

const auth = require('../src/auth');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text(), headers: r.headers }; };
async function api(method, p, body, token) { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }

test('seo and analytics', async () => {
  const boss = (await api('POST', '/api/auth/login', { email: 'boss@x.com', password: 'adminpass1' })).token;
  const reg = await api('POST', '/api/auth/register', { role: 'seller', email: 's@x.com', password: 'sellerpass', shop_name: 'Atlas & Co' });
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active' }, boss);
  const sel = (await api('POST', '/api/auth/login', { email: 's@x.com', password: 'sellerpass' })).token;
  const p = await api('POST', '/api/seller/products/manual', { title: 'Jacket <b>warm</b>', category: 'men', images: ['https://img.alicdn.com/a.jpg'], variants: [{ name: 'L', price: 39, stock: 3 }, { name: 'XL', price: 42, stock: 0 }] }, sel);
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);

  const rb = await get('/robots.txt'); assert.match(rb.text, /Disallow: \/admin/); assert.match(rb.text, /Sitemap: https:\/\/kinan\.example\/sitemap\.xml/);
  const sm = await get('/sitemap.xml'); assert.match(sm.text, new RegExp(`/p/${p.id}`)); assert.match(sm.text, new RegExp(`/s/${reg.seller_id}`));
  const feed = await get('/feeds/google.xml');
  assert.match(feed.text, /<g:price>39\.00 USD<\/g:price>/); assert.match(feed.text, /<g:brand>Atlas &amp; Co<\/g:brand>/); assert.match(feed.text, /in_stock/);
  const page = await get(`/p/${p.id}`);
  const ld = JSON.parse(page.text.match(/<script type="application\/ld\+json">(.+?)<\/script>/)[1]);
  assert.strictEqual(ld['@type'], 'Product'); assert.strictEqual(ld.offers.lowPrice, '39.00'); assert.strictEqual(ld.offers.highPrice, '42.00');
  assert.match(page.text, /google-site-verification" content="verify-me_1"/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /googletagmanager\.com/); assert.match(csp, /clarity\.ms/);
  assert.doesNotMatch((await fetch(base + '/admin')).headers.get('content-security-policy'), /googletagmanager/, 'no analytics on admin');
  const cfg = await api('GET', '/api/config/public');
  assert.deepStrictEqual(cfg.analytics, { ga: 'G-ABC123', clarity: 'abcd1234', meta: null, tiktok: null });
});

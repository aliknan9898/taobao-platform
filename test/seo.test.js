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
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', GA_MEASUREMENT_ID: 'G-ABC123', CLARITY_PROJECT_ID: 'abcd1234', GOOGLE_SITE_VERIFICATION: 'verify-me_1', BING_SITE_VERIFICATION: 'BING123', INDEXNOW_KEY: 'abcdef1234567890' });

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
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
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
  // Readable without JavaScript (Bing / ChatGPT / Perplexity crawlers), titles, AI files and feeds
  assert.match(page.text, /<main id="view" class="wrap"><nav aria-label="Breadcrumb">/); assert.match(page.text, /<h1>Jacket warm<\/h1>|<h1>Jacket &lt;b&gt;warm/);
  assert.match(page.text, /<title>Jacket.*\| Kinan Shop<\/title>/); assert.strictEqual((page.text.match(/name="description"/g) || []).length, 1);
  assert.match(page.text, /msvalidate\.01" content="BING123"/);
  assert.match(rb.text, /User-agent: OAI-SearchBot\nAllow: \//);
  assert.match(sm.text, /\/c\/men/);
  const home = await get('/'); assert.match(home.text, new RegExp(`href="/p/${p.id}"`)); assert.match(home.text, /"@type":"Organization"/);
  const cat = await get('/c/men'); assert.strictEqual(cat.status, 200); assert.match(cat.text, /<h1>Men’s fashion<\/h1>/); assert.match(cat.text, /"ItemList"/);
  const llms = await get('/llms.txt'); assert.match(llms.text, /^# Kinan Shop/); assert.match(llms.text, new RegExp(`/p/${p.id}\\): from 39\\.00 USD`));
  const oa = (await get('/feeds/openai.jsonl')).text.trim().split('\n').map((x) => JSON.parse(x));
  assert.strictEqual(oa.length, 2); assert.strictEqual(oa[0].group_id, p.id); assert.strictEqual(oa[0].price, '39.00 USD'); assert.strictEqual(oa[1].availability, 'out_of_stock');
  for (const k of ['item_id', 'title', 'description', 'url', 'brand', 'seller_name', 'image_url', 'availability', 'price']) assert.ok(oa[0][k], k);
  assert.strictEqual((await get('/abcdef1234567890.txt')).text, 'abcdef1234567890');
  const realFetch = global.fetch; let sentTo = null;
  global.fetch = async (u, o) => { if (String(u).includes('indexnow')) { sentTo = JSON.parse(o.body); return { status: 200 }; } return realFetch(u, o); };
  const seo = require('../src/seo');
  assert.strictEqual(await seo.indexNowTick(), 1); assert.strictEqual(sentTo.key, 'abcdef1234567890'); assert.ok(sentTo.urlList.includes(`https://kinan.example/p/${p.id}`));
  assert.strictEqual(await seo.indexNowTick(), 0, 'unchanged pages are not sent again');
  global.fetch = realFetch;
  const cfg = await api('GET', '/api/config/public');
  assert.deepStrictEqual(cfg.analytics, { ga: 'G-ABC123', clarity: 'abcd1234', meta: null, tiktok: null });
});

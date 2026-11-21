'use strict';
/* Task 22: search engines see live products only; an unavailable product page says noindex and has no product data. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://kinan.example', AI_AUTO_REVIEW: 'off', XMAS_AUTO: '0' });
delete process.env.DATABASE_URL;
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };

test('sitemap and product pages: live products indexed, paused and removed ones not', async () => {
  const s = db.sellers.insert({ shop_name: 'Atlas', status: 'active', kyc: { state: 'approved' } });
  const sku = [{ mp_sku_id: '1', price: 12, stock: 5, props: 'One' }];
  const live = db.listings.insert({ seller_id: s.id, title: 'Live Lamp', status: 'active', category: 'home', images: ['https://x/1.jpg'], skus: sku });
  const paused = db.listings.insert({ seller_id: s.id, title: 'Paused Lamp', status: 'paused', category: 'home', images: ['https://x/2.jpg'], skus: sku });
  const removed = db.listings.insert({ seller_id: s.id, title: 'Removed Lamp', status: 'removed', category: 'home', images: ['https://x/3.jpg'], skus: sku });
  const map = (await get('/sitemap.xml')).text;
  assert.match(map, new RegExp(`/p/${live.id}`));
  assert.doesNotMatch(map, new RegExp(`/p/(${paused.id}|${removed.id})`));
  const lp = (await get(`/p/${live.id}`)).text;
  assert.match(lp, /application\/ld\+json/); assert.doesNotMatch(lp, /name="robots" content="noindex"/);
  for (const id of [paused.id, removed.id]) {
    const r = await get(`/p/${id}`);
    if (r.status === 200) { assert.match(r.text, /name="robots" content="noindex"/); assert.doesNotMatch(r.text, /"@type":"Product"/); }
    else assert.equal(r.status, 404);
  }
  const robots = (await get('/robots.txt')).text;
  for (const p of ['/admin', '/seller', '/warehouse', '/api/']) assert.match(robots, new RegExp(`Disallow: ${p.replace('/', '\\/')}`));
});

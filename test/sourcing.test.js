// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* AI catalog builder: CJ European/UK warehouse products, demand + fast-delivery filters, AI photo/product check, departments, shop info. CJ and the AI are mocked. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-'));
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://kinan.example', CJ_API_KEY: 'CJ123@api@abcdef123456', CJ_MIN_GAP_MS: '0', XMAS_AUTO: '0', GEMINI_API_KEY: 'g-test', AI_AUTO_REVIEW: 'off' });
delete process.env.STRIPE_SECRET_KEY; delete process.env.ANTHROPIC_API_KEY;

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ code: 200, result: true, message: 'Success', data }), text: async () => '' });
// D1 good (DE), D2 low demand, D3 slow delivery, D4 bad photos (AI says no), D5 good (GB), D6 brand copy (filtered by words)
const P = {
  D1: { name: 'Dog Harness No Pull Reflective', wh: 'DE', listed: 900, days: '2-5' },
  D2: { name: 'Dog Leash Rope', wh: 'DE', listed: 3, days: '2-5' },
  D3: { name: 'Dog Bed Calming Round', wh: 'DE', listed: 500, days: '12-20' },
  D4: { name: 'Dog Toy Squeaky Ball', wh: 'DE', listed: 400, days: '3-6' },
  D5: { name: 'Dog Grooming Brush Self Cleaning', wh: 'GB', listed: 300, days: '1-3' },
  D6: { name: 'Disney Dog Bowl', wh: 'DE', listed: 999, days: '2-4' }
};
let aiCalls = 0;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes('generativelanguage')) {
    aiCalls++;
    const body = JSON.parse(opts.body); const text = body.contents[0].parts.map((x) => x.text || '').join(' ');
    const bad = /Squeaky/.test(text);
    const out = { keep: !bad, reason: bad ? 'Photos are a collage with text' : 'Clean photos, strong demand', quality: bad ? 3 : 8, photos_ok: !bad, photo_issues: bad ? 'collage' : '', department: 'pets', section: /Brush/.test(text) ? 'pets:care' : 'pets:dogs', ebay_ok: true, ebay_title: 'No Pull Dog Harness Reflective Adjustable Vest for Small Medium Large Dogs Walking Extra', keywords: ['dog harness', 'no pull harness'] };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: {} }) };
  }
  if (/\.(jpg|png)$/.test(u.pathname)) return { ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new ArrayBuffer(10) };
  const p = u.pathname.replace('/api2.0/v1', ''); const body = opts.body ? JSON.parse(opts.body) : null;
  if (p === '/authentication/getAccessToken') return ok({ openId: 7, accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 9e9).toISOString(), refreshToken: 'r', refreshTokenExpiryDate: new Date(Date.now() + 9e9).toISOString() });
  if (p === '/product/listV2') {
    const cc = u.searchParams.get('countryCode'); const kw = u.searchParams.get('keyWord');
    if (!/^dog/.test(kw)) return ok({ content: [{ productList: [] }] });
    return ok({ content: [{ productList: Object.entries(P).filter(([, x]) => x.wh === cc).map(([id, x]) => ({ id, nameEn: x.name, sellPrice: '5', bigImage: `https://cf.cjdropshipping.com/${id}.jpg`, listedNum: x.listed })) }] });
  }
  if (p === '/product/query') {
    const id = u.searchParams.get('pid'); const x = P[id];
    return ok({ pid: id, productNameEn: x.name, productSku: `S${id}`, bigImage: `https://cf.cjdropshipping.com/${id}.jpg`, productImageSet: [`https://cf.cjdropshipping.com/${id}.jpg`, `https://cf.cjdropshipping.com/${id}-2.jpg`], productWeight: 300, description: '<p>Material: Nylon</p>', sellPrice: 5,
      variants: [{ vid: `${id}-V1`, variantSku: `${id}-1`, variantKey: 'Black', variantSellPrice: 5, inventories: [{ countryCode: x.wh, totalInventory: 80, stock: [{ stockId: `${x.wh}-s` }] }] }] });
  }
  if (p === '/logistic/freightCalculate') {
    const id = body.products[0].vid.split('-')[0];
    const m = /(\d+)-(\d+)/.exec(P[id].days);
    return ok([{ logisticName: 'DHL', logisticPrice: 4, logisticAging: P[id].days, min: Number(m[1]), max: Number(m[2]) }]);
  }
  throw new Error(`unexpected ${u.href}`);
};

const db = require('../src/db');
const sourcing = require('../src/services/sourcing');

test('catalog builder: picks best sellers in EU/UK warehouses, fast delivery, AI-checked, into departments', async () => {
  require('../src/services/buyforme').systemSeller();
  sourcing.savePrefs({ departments: ['pets'], warehouses: 'DE,GB', min_listed: 20, per_keyword: 5, max_days_eu: 7, max_days_gb: 10, daily: false });
  assert.ok(sourcing.queue(sourcing.prefs()).every((x) => x.dept === 'pets'));
  const st = await sourcing.run({ count: 10 });
  const added = db.listings.all((l) => l.sourcing);
  const titles = added.map((l) => l.sourcing.supplier_title).sort();
  assert.deepStrictEqual(titles, ['Dog Grooming Brush Self Cleaning', 'Dog Harness No Pull Reflective'], JSON.stringify(st.reasons));
  assert.ok(st.reasons['AI: photos not good enough'] >= 1, JSON.stringify(st.reasons));
  assert.ok(Object.keys(st.reasons).some((k) => /no delivery in 7 days/.test(k)), JSON.stringify(st.reasons));
  assert.ok(!db.listings.all((l) => /Leash|Disney/.test(l.title)).length, 'low demand and brand copies are left out');
  const harness = added.find((l) => /Harness/.test(l.sourcing.supplier_title));
  assert.deepStrictEqual(harness.collections, ['pets']);
  assert.strictEqual(harness.collection_group, 'dogs');
  assert.strictEqual(harness.category, 'home');
  assert.strictEqual(harness.cj_from, 'DE');
  assert.strictEqual(harness.sourcing.quality, 8);
  assert.ok(harness.sourcing.ebay_title.length <= 80);
  assert.ok(harness.sourcing.ebay_ok);
  const brush = added.find((l) => /Brush/.test(l.sourcing.supplier_title));
  assert.strictEqual(brush.collection_group, 'care');
  assert.ok(aiCalls >= 3);

  // the shop shows departments with live products only
  for (const l of added) db.listings.update(l.id, { status: 'pending_review' });
  assert.strictEqual(sourcing.publicDepartments().length, 0);
  db.listings.update(harness.id, { status: 'active' });
  const deps = sourcing.publicDepartments();
  assert.strictEqual(deps[0].id, 'pets');
  assert.strictEqual(deps[0].kind, 'department');
  assert.deepStrictEqual(deps[0].groups.map((g) => g.id), ['dogs']);

  // eBay uses the AI's eBay title
  const s = sourcing.status();
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.departments.find((d) => d.id === 'pets').live, 1);

  // a second run does not add the same products again
  const again = await sourcing.run({ count: 10 });
  assert.strictEqual(again.added, 0);
});

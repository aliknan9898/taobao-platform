// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Kinan points, search by photo, French/German/Italian/Spanish. The AI (Gemini) is mocked. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stage1-'));
Object.assign(process.env, { GEMINI_API_KEY: 'g-test', AI_AUTO_REVIEW: 'off', XMAS_AUTO: '0' });
delete process.env.STRIPE_SECRET_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.CJ_API_KEY;

let AI = () => ({});
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes('generativelanguage')) {
    const body = JSON.parse(opts.body);
    const text = body.contents[0].parts.map((x) => x.text || '').join('\n');
    const out = AI(text, body);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: {} }) };
  }
  throw new Error(`unexpected ${u.href}`);
};

const db = require('../src/db');
const points = require('../src/services/points');
const growth = require('../src/services/growth');

test('Kinan points: earned on delivery, taken back on refund, turned into a personal code', () => {
  const u = db.users.insert({ email: 'p@x.com', role: 'buyer', name: 'P' });
  const other = db.users.insert({ email: 'q@x.com', role: 'buyer', name: 'Q' });
  const o = db.orders.insert({ buyer_id: u.id, lines: [], subtotal: 80, discount: 5, total: 90, status: 'delivered', paid_at: Date.now() });
  db.orders.insert({ buyer_id: u.id, lines: [], subtotal: 20, total: 25, status: 'shipped', paid_at: Date.now() });
  db.orders.insert({ buyer_id: u.id, channel: 'ebay', lines: [], subtotal: 50, total: 50, status: 'delivered', paid_at: Date.now() });
  assert.deepStrictEqual(points.settle(), { given: 1, taken: 0 });
  assert.deepStrictEqual(points.settle(), { given: 0, taken: 0 }, 'once only');
  let i = points.info(u.id);
  assert.strictEqual(i.balance, 750); // (80 − 5) × 10
  assert.strictEqual(i.pending, 200);
  assert.strictEqual(i.value, 2.25);
  assert.throws(() => points.redeem(u.id, 100), /at least 500/);
  assert.throws(() => points.redeem(u.id, 800), /that many points/);
  const r = points.redeem(u.id, 600);
  assert.match(r.code, /^PTS-[A-F0-9]{6}$/);
  assert.strictEqual(r.value, 1.8);
  assert.strictEqual(r.balance, 150);
  assert.strictEqual(r.codes.length, 1);
  // the code works for its owner only, once
  assert.strictEqual(growth.couponFor(r.code, db.users.get(u.id), 30).discount, 1.8);
  assert.throws(() => growth.couponFor(r.code, db.users.get(other.id), 30), /not valid/);
  // refund after delivery takes the points back (never below zero)
  db.orders.update(o.id, { status: 'refunded' });
  assert.deepStrictEqual(points.settle(), { given: 0, taken: 1 });
  assert.strictEqual(points.info(u.id).balance, 0);
});

test('search by photo: the AI names the product, the closest live products come first', async () => {
  const seller = require('../src/services/buyforme').systemSeller();
  const mk = (title, keywords = [], category = 'home') => db.listings.insert({ seller_id: seller.id, status: 'active', title, keywords, category, images: ['https://x/1.jpg'], skus: [{ mp_sku_id: title, price: 10, stock: 5 }] });
  mk('Reflective No Pull Dog Harness Vest', ['dog harness']);
  mk('Dog Leash Nylon Rope', ['dog leash']);
  mk('LED Strip Lights 10m RGB', ['led lights'], 'electronics');
  AI = () => ({ found: true, query: 'dog harness', alternatives: ['pet vest', 'dog leash'], colour: 'black', category: 'home' });
  const visual = require('../src/services/visual');
  await assert.rejects(visual.search('not a photo'), /Choose a photo/);
  const r = await visual.search('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  assert.strictEqual(r.query, 'dog harness');
  assert.deepStrictEqual(r.items.map((p) => p.title), ['Reflective No Pull Dog Harness Vest', 'Dog Leash Nylon Rope']);
  AI = () => ({ found: false, query: '', alternatives: [], colour: '', category: '' });
  assert.strictEqual((await visual.search('data:image/png;base64,iVBORw0KGgo=')).items.length, 0);
});

test('languages: phrases translated by the AI (blanks kept), served per language, used by the page', async () => {
  const ui = require('../src/services/uilang');
  const src = ui.source();
  assert.ok(src.keys.length > 900);
  assert.ok(src.keys.includes('Only {0} left'));
  assert.ok(src.keys.includes('Pet Supplies'), 'department names are translated too');
  AI = (text) => {
    const lines = text.split('\n').filter((l) => /^\d+\t/.test(l));
    return { items: lines.map((l) => { const [i, k] = l.split('\t'); return { i: Number(i), t: k === 'Only {0} left' ? 'Plus que {0}' : k === 'Hello, {0}' ? 'Bonjour' : `FR:${k}` }; }) };
  };
  const t = await ui.translateBatch('fr', ['Cart', 'Only {0} left', 'Hello, {0}']);
  assert.deepStrictEqual(t, { Cart: 'FR:Cart', 'Only {0} left': 'Plus que {0}' }, 'a translation that lost {0} is dropped');
  const done = await ui.tick({ batches: 1 });
  assert.deepStrictEqual(Object.keys(done).sort(), ['de', 'es', 'fr', 'it']);
  assert.strictEqual(done.fr, 60);
  const served = ui.serve('fr');
  assert.strictEqual(served.done, 60);
  assert.strictEqual(ui.serve('xx'), null);

  // the browser side: a French phone gets French text, numbers kept
  const code = fs.readFileSync(path.join(__dirname, '../public/assets/i18n.js'), 'utf8');
  const noop = () => {};
  const store = { kinan_i18n_fr: JSON.stringify({ v: '1', dict: { Cart: 'Panier', 'Only {0} left': 'Plus que {0}', 'Pet Supplies': 'Animalerie' } }) };
  const sb = { window: {}, navigator: { language: 'fr-FR', languages: ['fr-FR', 'en'] }, localStorage: { getItem: (k) => store[k] ?? null, setItem: noop, removeItem: noop },
    document: { documentElement: { setAttribute: noop }, readyState: 'loading', addEventListener: noop, body: null, title: '' }, location: { reload: noop }, fetch: () => new Promise(noop), console };
  vm.runInNewContext(code, sb);
  const K = sb.window.KinanLang;
  assert.strictEqual(K.lang, 'fr');
  assert.strictEqual(K.t('Cart'), 'Panier');
  assert.strictEqual(K.t('  Pet Supplies '), '  Animalerie ');
  assert.strictEqual(K.t('Only 3 left'), 'Plus que 3');
  assert.strictEqual(K.t('Not translated yet'), 'Not translated yet');
  assert.deepStrictEqual([...K.langs], ['en', 'ar', 'fr', 'de', 'it', 'es']);
  // a German phone with no copy yet: English until the dictionary arrives
  const sb2 = { ...sb, window: {}, navigator: { language: 'de-AT', languages: ['de-AT'] }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop } };
  vm.runInNewContext(code, sb2);
  assert.strictEqual(sb2.window.KinanLang.lang, 'de');
  assert.strictEqual(sb2.window.KinanLang.t('Cart'), 'Cart');
  // a Japanese phone: English
  const sb3 = { ...sb, window: {}, navigator: { language: 'ja', languages: ['ja'] }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop } };
  vm.runInNewContext(code, sb3);
  assert.strictEqual(sb3.window.KinanLang.lang, 'en');
});

test('free delivery from European warehouses above the threshold; similar and recently viewed', () => {
  const cj = require('../src/services/cj');
  const catalog = require('../src/services/catalog');
  const seller = require('../src/services/buyforme').systemSeller();
  const eu = db.listings.insert({ seller_id: seller.id, source: 'cj', fulfillment: 'direct', status: 'active', cj_from: 'DE', title: 'Garden Solar Lights Warm White', keywords: ['solar lights'], category: 'home', collections: ['garden-outdoor'], collection_group: 'solar', images: ['https://x/1.jpg'], skus: [{ mp_sku_id: 'e1', price: 20, stock: 9, cj_vid: 'V' }] });
  const cn = db.listings.insert({ seller_id: seller.id, source: 'cj', fulfillment: 'direct', status: 'active', cj_from: 'CN', title: 'Solar Lights Outdoor Garden Path', keywords: ['solar lights'], category: 'home', collections: ['garden-outdoor'], collection_group: 'solar', images: ['https://x/2.jpg'], skus: [{ mp_sku_id: 'c1', price: 30, stock: 9, cj_vid: 'W' }] });
  const q = { fee: 11, fees: { DE: 4, CN: 7 } };
  assert.strictEqual(cj.prefs().free_ship_over, 45);
  assert.deepStrictEqual(cj.freeEu([{ listing_id: eu.id, mp_sku_id: 'e1', qty: 2 }, { listing_id: cn.id, mp_sku_id: 'c1', qty: 1 }], q), { over: 45, eu_subtotal: 40, free: 0 });
  assert.deepStrictEqual(cj.freeEu([{ listing_id: eu.id, mp_sku_id: 'e1', qty: 3 }, { listing_id: cn.id, mp_sku_id: 'c1', qty: 1 }], q), { over: 45, eu_subtotal: 60, free: 4 }, 'only the European parcel is free');
  cj.savePrefs({ free_ship_over: 0 });
  assert.strictEqual(cj.freeEu([{ listing_id: eu.id, mp_sku_id: 'e1', qty: 9 }], q).free, 0, '0 switches it off');
  assert.deepStrictEqual(catalog.similar(eu.id).items.map((p) => p.id), [cn.id]);
  assert.deepStrictEqual(catalog.many(`${cn.id},nope,${eu.id}`).items.map((p) => p.id), [cn.id, eu.id]);
});

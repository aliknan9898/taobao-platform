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

test("today's deals: AI picks, 10–20% off within the margin, shown and charged, ends at midnight Malta time", async () => {
  const deals = require('../src/services/deals');
  const catalog = require('../src/services/catalog');
  const seller = require('../src/services/buyforme').systemSeller();
  for (const l of db.listings.all(() => true)) db.listings.update(l.id, { status: 'paused' }); // only the products below
  const a = db.listings.insert({ seller_id: seller.id, source: 'cj', status: 'active', title: 'Deal Lamp', images: ['https://x/a.jpg'], skus: [{ mp_sku_id: 'a1', price: 20, cost_sale: 8, stock: 50 }] });
  const b = db.listings.insert({ seller_id: seller.id, source: 'cj', status: 'active', title: 'Thin Margin Mug', images: ['https://x/b.jpg'], skus: [{ mp_sku_id: 'b1', price: 10, cost_sale: 8.5, stock: 50 }] });
  const c = db.listings.insert({ seller_id: seller.id, source: 'cj', status: 'active', title: 'Deal Rug', images: ['https://x/c.jpg'], skus: [{ mp_sku_id: 'c1', price: 30, cost_sale: 21, stock: 50 }] });
  const ids = deals.candidates().map((x) => x.l.id);
  assert.ok(ids.includes(a.id) && !ids.includes(b.id), 'no deal without margin');
  assert.strictEqual(deals.candidates().find((x) => x.l.id === a.id).pct, 20);
  AI = () => ({ picks: [0, 1] });
  const d = await deals.tick({ force: true });
  assert.deepStrictEqual(d.items.map((x) => x.id).sort(), [a.id, c.id].sort());
  assert.ok(d.ends > Date.now() && d.ends - Date.now() <= 86400e3);
  const view = catalog.buyerListing(a.id);
  assert.strictEqual(view.min_price, 16);
  assert.strictEqual(view.was_min_price, 20);
  assert.strictEqual(view.skus[0].was, 20);
  assert.strictEqual(view.deal.pct, 20);
  assert.strictEqual(catalog.buyerListing(c.id).deal.pct, 15);
  assert.strictEqual(catalog.buyerListing(c.id).min_price, 25.5);
  assert.strictEqual(deals.priceOf(db.listings.get(b.id), db.listings.get(b.id).skus[0]), 10, 'no deal, normal price');
  assert.strictEqual((await deals.tick()).at, d.at, 'same day: same deals');
  assert.strictEqual(deals.publicDeals().count, 2);
});

test('shopping assistant, product questions, points for reviews', async () => {
  const assistant = require('../src/services/assistant');
  const seller = require('../src/services/buyforme').systemSeller();
  for (const l of db.listings.all(() => true)) db.listings.update(l.id, { status: 'paused' });
  const scarf = db.listings.insert({ seller_id: seller.id, source: 'cj', status: 'active', title: 'Cashmere Feel Winter Scarf Women', keywords: ['scarf', 'gift for her'], description: 'Material: acrylic. Size: 180 x 70 cm.', images: ['https://x/s.jpg'], skus: [{ mp_sku_id: 's1', price: 18, stock: 30 }] });
  db.listings.insert({ seller_id: seller.id, source: 'cj', status: 'active', title: 'Luxury Scarf Silk', images: ['https://x/l.jpg'], skus: [{ mp_sku_id: 'l1', price: 90, stock: 30 }] });
  db.listings.insert({ seller_id: seller.id, source: 'cj', status: 'active', title: 'Car Phone Holder', images: ['https://x/c.jpg'], skus: [{ mp_sku_id: 'c1', price: 9, stock: 30 }] });
  AI = (text, body) => {
    const sys = body.system_instruction?.parts?.map((p) => p.text).join(' ') || '';
    if (/Products Kinan has/.test(text)) return { reply: 'Ein schöner Schal für deine Mutter:', picks: [{ i: 0, why: 'Weich und warm' }] };
    if (/shopping/i.test(sys) || /Shopper:/.test(text)) return { searches: ['winter scarf', 'scarf women'], max_price: 30, min_price: 0, reply_if_no_products: '' };
    return {};
  };
  const r = await assistant.chat({ messages: [{ role: 'user', text: 'Ein Geschenk für meine Mutter unter 30 €' }], currency: 'USD', lang: 'de' });
  assert.strictEqual(r.reply, 'Ein schöner Schal für deine Mutter:');
  assert.deepStrictEqual(r.items.map((p) => p.title), ['Cashmere Feel Winter Scarf Women'], 'the €90 scarf is over budget');
  assert.strictEqual(r.items[0].why, 'Weich und warm');
  await assert.rejects(assistant.chat({ messages: [] }), /Write a message/);

  // questions: the AI answers from the details, or leaves it for Kinan
  const buyer = db.users.insert({ email: 'qa@x.com', role: 'buyer', name: 'Lena' });
  AI = (text) => (/How long/.test(text) ? { allowed: true, can_answer: true, answer: 'It is 180 × 70 cm.' } : { allowed: true, can_answer: false, answer: '' });
  const q1 = await assistant.ask(buyer, scarf.id, 'How long is the scarf?');
  assert.strictEqual(q1.answer, 'It is 180 × 70 cm.');
  assert.strictEqual(q1.by, 'ai');
  const q2 = await assistant.ask(buyer, scarf.id, 'Is it machine washable?');
  assert.strictEqual(q2.answer, null);
  assert.deepStrictEqual(assistant.pending().map((q) => q.id), [q2.id]);
  assistant.answer(q2.id, 'Yes, at 30 °C.');
  assert.strictEqual(assistant.pending().length, 0);
  assert.deepStrictEqual(assistant.questionsFor(scarf.id).questions.map((q) => q.by).sort(), ['ai', 'kinan']);
  AI = () => ({ allowed: false, can_answer: false, answer: '' });
  await assert.rejects(assistant.ask(buyer, scarf.id, 'call me on 0123 456'), /about the product/);

  // a review with a photo earns points
  const growth = require('../src/services/growth');
  const o = db.orders.insert({ buyer_id: buyer.id, status: 'delivered', lines: [{ listing_id: scarf.id, seller_id: seller.id, qty: 1, price: 18 }], subtotal: 18, total: 18 });
  const rv = growth.addReview(db.users.get(buyer.id), o.id, { listing_id: scarf.id, rating: 5, text: 'Lovely', photos: ['data:image/jpeg;base64,/9j/4AAQ'] });
  assert.strictEqual(rv.points, 100);
  assert.strictEqual(require('../src/services/points').info(buyer.id).balance, 100);
});

test('CJ background work stops at its daily limit and when CJ says the points are gone; orders still go through', async () => {
  const cjc = require('../src/cj/client');
  process.env.CJ_API_KEY = 'CJ1@api@abcdefabcdef'; process.env.CJ_MIN_GAP_MS = '0'; process.env.CJ_BACKGROUND_CALLS_PER_DAY = '2';
  let calls = 0; let out = false;
  const prev = global.fetch;
  global.fetch = async (url) => {
    const p = new URL(String(url)).pathname;
    if (p.endsWith('/authentication/getAccessToken')) return { ok: true, status: 200, json: async () => ({ code: 200, result: true, data: { openId: 1, accessToken: 't', accessTokenExpiryDate: new Date(Date.now() + 9e9).toISOString(), refreshToken: 'r', refreshTokenExpiryDate: new Date(Date.now() + 9e9).toISOString() } }) };
    calls++;
    return { ok: true, status: 200, json: async () => (out ? { code: 1600201, result: false, message: 'Insufficient API points. Used today: 100000, Remaining: 0, Required: 10.' } : { code: 200, result: true, data: { ok: 1 } }) };
  };
  try {
    await cjc.background(() => cjc.call('GET', '/x'));
    await cjc.background(() => cjc.call('GET', '/x'));
    await assert.rejects(cjc.background(() => cjc.call('GET', '/x')), (e) => e.status === 429 && /background limit/.test(e.message));
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual((await cjc.call('GET', '/x')), { ok: 1 }, 'a customer action is not limited');
    out = true;
    await assert.rejects(cjc.call('GET', '/x'), (e) => e.status === 429);
    process.env.CJ_BACKGROUND_CALLS_PER_DAY = '1000';
    const before = calls;
    await assert.rejects(cjc.background(() => cjc.call('GET', '/x')), /no API points left/);
    assert.strictEqual(calls, before, 'background work does not even ask CJ');
    assert.ok(cjc.usage().points_out_until > Date.now());
  } finally { global.fetch = prev; delete process.env.CJ_API_KEY; }
});

test('NSS receiving orders: Taobao parcels on their way are listed with SKU, barcode and quantity until marked done', () => {
  const nss = require('../src/services/nss');
  const o = db.orders.insert({ buyer_id: 'u1', status: 'processing', lines: [{ line_no: '1', listing_id: 'lst_abc123', mp_sku_id: '555', title: 'Silk scarf', props: 'Red', qty: 2, price: 10 }, { line_no: '2', listing_id: 'lst_cj', mp_sku_id: 'x', title: 'CJ item', qty: 1, direct: true }] });
  const p = db.parcels.insert({ order_id: o.id, tracking: 'YT 1234 5678', carrier: 'YTO', mp_sku_id: '555', status: 'expected' });
  const list = nss.receivings().filter((x) => x.order_id === o.id);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].tracking, 'YT12345678', 'no spaces, as NSS asks');
  assert.deepStrictEqual(list[0].items.map((i) => [i.sku, i.qty, i.name]), [[nss.skuOf(o.lines[0]), 2, 'Silk scarf (Red)']]);
  assert.match(list[0].items[0].barcode, /^KN[0-9A-F]{12}$/);
  nss.receivingDone(p.id);
  assert.strictEqual(nss.receivings().filter((x) => x.order_id === o.id).length, 0);
  assert.strictEqual(nss.warehouseAddress().name, '智选云仓+NSS40735');
});

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* AliExpress catalog builder: ≤10 days delivery, AI review, clean photos only, departments. AliExpress and the AI are faked. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aesrc-'));
delete process.env.TELEGRAM_BOT_TOKEN;

const db = require('../src/db');
const aeClient = require('../src/aliexpress/client');
const aes = require('../src/services/aliexpress');
const ai = require('../src/services/ai');
const A = require('../src/services/aeSourcing');

const PRODUCTS = {
  '1005000000000001': { title: 'Fast lamp', days: 6, imgs: 5, keep: true },
  '1005000000000002': { title: 'Slow lamp', days: 18, imgs: 5, keep: true },
  '1005000000000003': { title: 'Ugly lamp', days: 5, imgs: 5, keep: true, photos: [] },
  '1005000000000004': { title: 'Bad lamp', days: 5, imgs: 5, keep: false },
  '1005000000000005': { title: 'US slow lamp', days: 5, imgs: 5, keep: true, US: 16 },
  '1005000000000006': { title: 'Malta slow lamp', days: 5, imgs: 5, keep: true, MT: 16 }
};
aeClient.call = async (method, params) => {
  if (method === 'aliexpress.ds.text.search') return { data: { products: { selection_search_product: Object.keys(PRODUCTS).map((id) => ({ itemId: id, title: PRODUCTS[id].title, orders: 1200, targetSalePrice: '5.00' })).concat([{ itemId: '1005000000000009', title: 'Unpopular', orders: 3 }, { itemId: '1005000000000010', title: 'Boundary', orders: '98+' }, { itemId: '1005000000000011', title: 'Unknown', orders: '2k' }]) } } };
  if (method === 'aliexpress.ds.feedname.get') return { resp_result: { result: { promos: { promo: [{ promo_name: 'DS_UK_FastDelivery', product_num: 300, promo_desc: 'UK fast' }, { promo_name: 'Random', product_num: 9 }] } } } };
  if (method === 'aliexpress.ds.recommend.feed.get') { assert.strictEqual(params.feed_name, 'DS_UK_FastDelivery'); return { result: { products: { traffic_product_d_t_o: params.page_no === 1 ? [{ product_id: '1005000000000001', product_title: 'Fast lamp', lastest_volume: '1,001+' }] : [] } } }; }
  if (method === 'aliexpress.ds.freight.query') { const r = params.queryDeliveryReq; return { msg: 'Call succeeds', code: 200, success: true, delivery_options: { delivery_option_d_t_o: [{ code: 'CAINIAO', max_delivery_days: PRODUCTS[r.productId][r.shipToCountry] ?? (PRODUCTS[r.productId].days + (r.shipToCountry === 'DE' ? 1 : 0)), shipping_fee_cent: '0', ship_from_country: 'ES' }, { code: 'SLOW', max_delivery_days: 30 }] } }; }
  throw new Error(`unmocked ${method}`);
};
aes.status = () => ({ connected: true });
aes.token = async () => 'tok';
const fetched = new Set();
aes.fetchProduct = async (id) => { fetched.add(id); return ({ ae_product_id: id, title: PRODUCTS[id].title, description: 'A lamp', images: Array.from({ length: PRODUCTS[id].imgs }, (_, i) => `https://img.example/${id}/${i + 1}.jpg`), skus: [{ mp_sku_id: `AE${id}`, ae_sku_id: `S${id}`, props: '', stock: 50, cost_sale: 5 }] }); };
aes.publish = async (seller, { link }) => { const p = await aes.fetchProduct(link); return db.listings.insert({ seller_id: seller.id, source: 'aliexpress', fulfillment: 'direct', ae_product_id: link, title: p.title, description: p.description, images: p.images, skus: p.skus.map((s) => ({ ...s, price: 9 })), status: 'pending_review' }); };
ai.enabled = () => true;
ai.structured = async ({ text }) => {
  const id = Object.keys(PRODUCTS).find((k) => text.includes(PRODUCTS[k].title));
  const P = PRODUCTS[id];
  return { keep: P.keep, reason: 'ok', quality: 8, photos_ok: true, photo_issues: '', clean_photos: P.photos || [4, 2, 2, 9], main_photo: 4, department: 'home', section: 'home:lighting', ebay_ok: true, ebay_title: `${P.title} For Bedroom And Desk`, keywords: ['led desk lamp'] };
};

test('AliExpress builder: only fast, AI-approved products with clean photos are added, sorted and live', async () => {
  assert.strictEqual(A.prefs().per_day, 1000);
  A.savePrefs({ min_orders: 0, per_day: 3000, max_days: 15 });
  assert.strictEqual(A.prefs().min_orders, 99, 'owner rule: 99+ orders');
  assert.strictEqual(A.prefs().max_days, 15, 'a shorter limit the owner saves is kept');
  assert.strictEqual(A.prefs().per_day, 1000);
  const st = await A.run({ count: 5 }, 'test');
  assert.ok(!fetched.has('1005000000000010') && !fetched.has('1005000000000011'), 'rejects boundary and unverified sales before product fetch');
  // each destination is checked on its own: the US-slow and Malta-slow lamps reach the other markets and are added
  assert.strictEqual(st.added, 3, JSON.stringify(st.reasons));
  assert.strictEqual(db.listings.find((x) => x.ae_product_id === '1005000000000001').sourcing.keyword, 'DS_UK_FastDelivery', 'found first in the fast feed');
  assert.ok(st.reasons['no delivery in 15 days to any checked market'] >= 1, 'the slow lamp reaches no market in time');
  assert.equal(st.reasons['no US delivery in 15 days'], undefined, 'no all-markets rule any more');
  // the answers became per-country eligibility: 16 days to the US is outside this import's 15-day setting but
  // within the shop's 3-week limit per country, so the US can still sell it; a stricter US limit hides it there
  const E = require('../src/services/eligibility');
  const us = db.listings.find((x) => x.ae_product_id === '1005000000000005');
  assert.equal(E.variantState(us, us.skus[0], 'US').state, 'eligible');
  E.saveConfig({ max_days: { US: 15 } });
  assert.equal(E.variantState(us, us.skus[0], 'US').state, 'over_limit');
  E.saveConfig({ max_days: { US: null } });
  assert.equal(E.variantState(us, us.skus[0], 'GB').state, 'eligible');
  assert.deepEqual(Object.keys(us.sourcing.delivery_by_country), ['GB', 'DE', 'FR', 'ES', 'IT', 'PL', 'MT', 'CA', 'AU', 'NZ'], 'only the markets it reaches in time');
  // per-destination qualification: the Malta-slow lamp passed seven markets and failed Malta
  assert.ok(st.markets.MT.failed >= 1 && st.markets.MT.checked >= st.markets.MT.failed);
  assert.ok(st.markets.GB.checked >= st.markets.US.checked);
  assert.ok(st.reasons['AI: fewer than 2 clean photos'] >= 1);
  assert.ok(st.reasons['AI: not a good product'] >= 1);
  const l = db.listings.find((x) => x.ae_product_id === '1005000000000001');
  assert.strictEqual(l.status, 'active');
  assert.strictEqual(l.sourcing.orders, 1001);
  assert.deepEqual(Object.keys(l.sourcing.delivery_by_country), ['GB', 'US', 'DE', 'FR', 'ES', 'IT', 'PL', 'MT', 'CA', 'AU', 'NZ']);
  const catalog = require('../src/services/catalog');
  assert.equal(catalog.delivery(l.id, 'US').known, true);
  assert.equal(catalog.delivery(l.id, 'NL').known, false);
  assert.deepStrictEqual(l.images, ['https://img.example/1005000000000001/4.jpg', 'https://img.example/1005000000000001/2.jpg'], 'main photo first, only the clean ones, no duplicates, nothing the AI did not see');
  assert.strictEqual(l.images_hidden.length, 3);
  assert.strictEqual(l.sourcing.gb_days, 6); assert.strictEqual(l.sourcing.eu_days, 7); assert.strictEqual(l.ae_from, 'ES');
  assert.ok(l.skus[0].price > l.skus[0].cost_sale);
  assert.strictEqual(db.listings.all((x) => ['1005000000000002', '1005000000000003', '1005000000000004'].includes(x.ae_product_id)).length, 0, 'rejected ones are removed');
  assert.ok(l.collections.length && l.collection_group);
  assert.deepEqual(db.product_review_feedback.all().map((row) => [row.id, row.decision]), [
    ['aliexpress:full:1005000000000001', 'ok'],
    ['aliexpress:full:1005000000000003', 'stopped'],
    ['aliexpress:full:1005000000000004', 'stopped'],
    ['aliexpress:full:1005000000000005', 'ok'],
    ['aliexpress:full:1005000000000006', 'ok'],
  ]);
});

test('AliExpress revisits a feed page after its AI review hits quota', async (t) => {
  const id = '1005000000000001';
  db.listings.remove(db.listings.find((row) => row.ae_product_id === id).id);
  db.settings.remove('ae_sourcing');
  const original = ai.structured;
  let available = false;
  t.mock.method(ai, 'structured', async (request) => {
    if (!available) throw Object.assign(new Error('quota exhausted'), { status: 429 });
    return original(request);
  });

  const interrupted = await A.run({ count: 1 }, 'test');
  assert.equal(interrupted.added, 0);
  assert.equal(interrupted.reasons['AI rate or quota limit'], 1);
  assert.equal(db.listings.find((row) => row.ae_product_id === id), undefined);

  available = true;
  assert.equal((await A.run({ count: 1 }, 'test')).added, 1);
  assert.equal(db.listings.find((row) => row.ae_product_id === id).sourcing.keyword, 'DS_UK_FastDelivery');
});

test('AliExpress imports previously skipped products at the 3-week ceiling', async () => {
  db.settings.update('ae_sourcing', (state) => ({
    ...state, prefs: { max_days: 15, delivery_limit_updated: true }, feed_pages: {}, cursor: 0
  }));
  assert.equal(A.prefs().max_days, 21);
  const result = await A.run({ count: 5 }, 'test');
  // only the 18-day lamp is new: the US- and Malta-slow lamps were already added on the markets they reach
  assert.equal(result.added, 1);
  assert.equal(db.listings.find((row) => row.ae_product_id === '1005000000000002').status, 'active');
  assert.equal(A.savePrefs({ max_days: 30 }).max_days, 21);
});

test('keyword search refused app-wide: paused for 12 hours after two refusals, feeds still used', async () => {
  const original = aeClient.call; let searches = 0;
  aeClient.call = async (method, params) => {
    if (method === 'aliexpress.ds.text.search') { searches++; throw new Error('AliExpress error NGSELECTION_SEARCH_ERROR'); }
    if (method === 'aliexpress.ds.recommend.feed.get') return { result: { products: { traffic_product_d_t_o: [] } } };
    return original(method, params);
  };
  db.settings.update('ae_sourcing', (s) => ({ ...s, feed_pages: {}, search_off_until: 0 }));
  const first = await A.run({ count: 1 }, 'test');
  assert.equal(searches, 2);
  assert.ok(first.search_paused_until > Date.now() + 11 * 3600e3);
  assert.ok(!first.error, 'a paused search is not a run error');
  const second = await A.run({ count: 1 }, 'test');
  assert.equal(searches, 2, 'no keyword searches while paused');
  assert.ok(second.search_paused_until);
  aeClient.call = original;
});

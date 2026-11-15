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
  '1005000000000004': { title: 'Bad lamp', days: 5, imgs: 5, keep: false }
};
aeClient.call = async (method, params) => {
  if (method === 'aliexpress.ds.text.search') return { data: { products: { selection_search_product: Object.keys(PRODUCTS).map((id) => ({ itemId: id, title: PRODUCTS[id].title, orders: 900, targetSalePrice: '5.00' })).concat([{ itemId: '1005000000000009', title: 'Unpopular', orders: 3 }]) } } };
  if (method === 'aliexpress.ds.freight.query') { const r = params.queryDeliveryReq; return { result: { delivery_options: { delivery_option_d_t_o: [{ code: 'CAINIAO', max_delivery_days: PRODUCTS[r.productId].days + (r.shipToCountry === 'DE' ? 1 : 0), shipping_fee_cent: '0', ship_from_country: 'ES' }, { code: 'SLOW', max_delivery_days: 30 }] } } }; }
  throw new Error(`unmocked ${method}`);
};
aes.status = () => ({ connected: true });
aes.token = async () => 'tok';
aes.fetchProduct = async (id) => ({ ae_product_id: id, title: PRODUCTS[id].title, description: 'A lamp', images: Array.from({ length: PRODUCTS[id].imgs }, (_, i) => `https://img.example/${id}/${i + 1}.jpg`), skus: [{ mp_sku_id: `AE${id}`, ae_sku_id: `S${id}`, props: '', stock: 50, cost_sale: 5 }] });
aes.publish = async (seller, { link }) => { const p = await aes.fetchProduct(link); return db.listings.insert({ seller_id: seller.id, source: 'aliexpress', fulfillment: 'direct', ae_product_id: link, title: p.title, description: p.description, images: p.images, skus: p.skus.map((s) => ({ ...s, price: 9 })), status: 'pending_review' }); };
ai.enabled = () => true;
ai.structured = async ({ text }) => {
  const id = Object.keys(PRODUCTS).find((k) => text.includes(PRODUCTS[k].title));
  const P = PRODUCTS[id];
  return { keep: P.keep, reason: 'ok', quality: 8, photos_ok: true, photo_issues: '', clean_photos: P.photos || [4, 2, 2, 9], main_photo: 4, department: 'home', section: 'home:lighting', ebay_ok: true, ebay_title: `${P.title} For Bedroom And Desk`, keywords: ['led desk lamp'] };
};

test('AliExpress builder: only fast, AI-approved products with clean photos are added, sorted and live', async () => {
  const st = await A.run({ count: 5 }, 'test');
  assert.strictEqual(st.added, 1, JSON.stringify(st.reasons));
  assert.ok(st.reasons['no UK delivery in 15 days'] >= 1);
  assert.ok(st.reasons['AI: fewer than 2 clean photos'] >= 1);
  assert.ok(st.reasons['AI: not a good product'] >= 1);
  const l = db.listings.find((x) => x.ae_product_id === '1005000000000001');
  assert.strictEqual(l.status, 'active');
  assert.deepStrictEqual(l.images, ['https://img.example/1005000000000001/4.jpg', 'https://img.example/1005000000000001/2.jpg'], 'main photo first, only the clean ones, no duplicates, nothing the AI did not see');
  assert.strictEqual(l.images_hidden.length, 3);
  assert.strictEqual(l.sourcing.gb_days, 6); assert.strictEqual(l.sourcing.eu_days, 7); assert.strictEqual(l.ae_from, 'ES');
  assert.ok(l.skus[0].price > l.skus[0].cost_sale);
  assert.strictEqual(db.listings.all((x) => ['1005000000000002', '1005000000000003', '1005000000000004'].includes(x.ae_product_id)).length, 0, 'rejected ones are removed');
  assert.ok(l.collections.length && l.collection_group);
});

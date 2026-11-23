'use strict';
/* Product lists: view=card sends only what a card shows, browsing never changes stored products,
   and paging walks the whole catalogue without gaps or repeats (endless scrolling relies on it). */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-card-'));
const db = require('../src/db');
const catalog = require('../src/services/catalog');

db.sellers.insert({ id: 's1', status: 'active', shop_name: 'Kinan', user_id: 'u1' });
for (let i = 0; i < 60; i += 1) {
  db.listings.insert({ id: `l${i}`, seller_id: 's1', status: 'active', title: `Product ${i}`, title_ar: `منتج ${i}`, description: 'long text '.repeat(200), currency: 'USD',
    images: [`https://img.test/${i}a.jpg`, `https://img.test/${i}b.jpg`], skus: [{ mp_sku_id: `k${i}a`, props: 'Color:Red', price: 10 + i, stock: 5 }, { mp_sku_id: `k${i}b`, props: 'Color:Blue', price: 12 + i, stock: 5 }],
    category: 'home', created_at: 1_700_000_000_000 + i });
}

test('view=card: the card fields only, one image, same prices as the full view', () => {
  const full = catalog.browse({ limit: 5 }).items; const card = catalog.browse({ limit: 5, view: 'card' }).items;
  assert.deepStrictEqual(card.map((p) => p.id), full.map((p) => p.id));
  for (const [i, p] of card.entries()) {
    assert.strictEqual(p.min_price, full[i].min_price); assert.strictEqual(p.title_ar, full[i].title_ar);
    assert.deepStrictEqual(p.images, full[i].images.slice(0, 1)); assert.deepStrictEqual(p.shop, full[i].shop);
    for (const k of ['description', 'description_ar', 'skus', 'option_groups']) assert.ok(!(k in p), `${k} is not sent for a card`);
  }
  assert.ok(JSON.stringify(card).length * 5 < JSON.stringify(full).length, 'a card list is a fraction of the full one');
});

test('browsing reads products without changing them', () => {
  const before = JSON.stringify(db.listings.all());
  catalog.browse({ limit: 100000 }); catalog.browse({ limit: 24, sort: 'price_asc', view: 'card' }); catalog.browse({ q: 'product 1', limit: 10 });
  assert.strictEqual(JSON.stringify(db.listings.all()), before);
});

test('paging 24 at a time returns every product once, newest first', () => {
  const seen = []; let total = 0;
  for (let offset = 0; offset < 100; offset += 24) { const d = catalog.browse({ limit: 24, offset, view: 'card' }); total = d.total; seen.push(...d.items.map((p) => p.id)); if (d.items.length < 24) break; }
  assert.strictEqual(total, 60); assert.strictEqual(seen.length, 60); assert.strictEqual(new Set(seen).size, 60);
  assert.strictEqual(seen[0], 'l59');
});

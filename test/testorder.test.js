'use strict';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

test('test basket: cheap, fast, one per department, cart link works', () => {
  const seller = db.sellers.insert({ shop_name: 'T', status: 'active' });
  const mk = (title, dept, price, days, source) => db.listings.insert({ seller_id: seller.id, title, status: 'active', source, collections: [dept], currency: 'EUR', images: ['https://x/a.jpg'],
    skus: [{ mp_sku_id: 'S1', price, stock: 5 }], sourcing: { eu_days: days, gb_days: days } });
  const a = mk('Cheap fast kitchen', 'kitchen', 2, 7, 'cj');
  mk('Second kitchen', 'kitchen', 1.5, 8, 'aliexpress');
  const c = mk('Phone stand', 'phone', 3, 9, 'aliexpress');
  mk('Too slow', 'garden', 2, 20, 'cj');
  mk('Too dear', 'toys', 40, 6, 'cj');
  const b = require('../src/services/testOrder').basket({ country: 'MT', n: 2, max_price: 5, max_days: 12 });
  assert.deepStrictEqual(b.items.map((x) => x.listing_id).sort(), [a.id, c.id].sort());
  assert.ok(b.link.includes('#/add/'));
  const l = require('../src/services/testOrder').lines(`${a.id}~S1,missing~X`);
  assert.strictEqual(l.items.length, 1);
  assert.strictEqual(l.items[0].price, 2);
});

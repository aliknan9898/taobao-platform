'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'to-'));
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
  assert.ok(b.link.startsWith('/#/add/'));
  const l = require('../src/services/testOrder').lines(`${a.id}~S1,missing~X`);
  assert.strictEqual(l.items.length, 1);
  assert.strictEqual(l.items[0].price, 2);
});

test('test basket: only electronics when asked, spread over sections', () => {
  const seller = db.sellers.insert({ shop_name: 'E', status: 'active' });
  const mk = (title, dept, group) => db.listings.insert({ seller_id: seller.id, title, status: 'active', source: 'cj', collections: [dept], collection_group: group, currency: 'EUR',
    skus: [{ mp_sku_id: 'S1', price: 4, stock: 5 }], sourcing: { eu_days: 6 } });
  mk('Earbuds', 'electronics', 'audio'); mk('Earbuds 2', 'electronics', 'audio'); mk('Smart plug', 'electronics', 'smart'); mk('Cable', 'phone', 'charging'); mk('Mug', 'home-kitchen', 'drinkware');
  const b = require('../src/services/testOrder').basket({ country: 'MT', n: 3, max_price: 5, max_days: 10, departments: 'electronics,phone' });
  assert.strictEqual(b.items.length, 3);
  assert.ok(b.items.every((x) => ['electronics', 'phone'].includes(x.department)));
  assert.strictEqual(new Set(b.items.map((x) => x.section)).size, 3);
});

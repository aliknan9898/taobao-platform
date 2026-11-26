'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-pricing-'));
delete process.env.DATABASE_URL;
delete process.env.STRIPE_SECRET_KEY;
const db = require('../src/db');
const pricing = require('../src/services/routePricing');

test('calculates landed cost, overhead, UK profit reserve and rounds up', () => {
  const q = pricing.calculate({ cost: 10, shipping: 2, duty: 1, import_tax: 1, handling: 1, sales_tax_pct: 0 }, { operating_pct: 10, corporation_reserve_pct: 20 });
  assert.equal(q.landed, 15);
  assert.equal(q.operating, 1.5);
  assert.equal(q.target_profit, 2.48);
  assert.equal(q.corporation_reserve, 0.62);
  assert.equal(q.price, 19.99);
  assert.throws(() => pricing.calculate({ cost: 10, shipping: 2, duty: '' }, {}), /customs duty/);
});

test('approved price is shared by catalog, quote and checkout without duplicated duties or freight', async () => {
  const seller = require('../src/services/buyforme').systemSeller();
  const sku = { mp_sku_id: 'pricing-sku', price: 25, cost_sale: 10, stock: 20, props: 'Standard' };
  const listing = db.listings.insert({
    seller_id: seller.id, status: 'active', title: 'Pricing fixture', source: 'aliexpress', fulfillment: 'direct',
    ae_from: 'CN', last_synced_at: Date.now(), currency: 'usd', skus: [sku],
  });
  const route = { listing_id: listing.id, sku_id: sku.mp_sku_id, origin: 'CN', destination: 'DE',
    hs_code: '392690', made_in: 'CN', evidence: 'Synthetic test quote', valid_days: 1, shipping: 2, duty: 1, import_tax: 1, handling: 1, sales_tax_pct: 0 };
  const rules = { revision: 0, operating_pct: 10, corporation_reserve_pct: 20 };
  assert.throws(() => pricing.save({ ...rules, route: { ...route, origin: 'GB' } }, { id: 'owner' }), /dispatch country/);
  pricing.save({ ...rules, route }, { id: 'owner' });
  assert.throws(() => pricing.save({ ...rules, route }, { id: 'owner' }), /Reload/);
  const catalog = require('../src/services/catalog');
  const product = catalog.buyerListing(listing.id, 'DE');
  assert.equal(product.skus[0].price, 19.99);
  assert.equal(catalog.browse({ country: 'DE' }).items.find((p) => p.id === listing.id).delivered_price, 19.99);
  assert.equal(catalog.buyerListing(listing.id, 'GB').skus[0].price, 25);
  const items = [{ listing_id: listing.id, mp_sku_id: product.skus[0].mp_sku_id, qty: 1 }];
  const { server } = require('../src/server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/shipping/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, country_code: 'DE' }),
    });
    const quote = await response.json();
    assert.equal(quote.pricing_subtotal, 19.99);
    assert.equal(quote.fee, 0);
    const order = await require('../src/services/orders').checkout({ id: 'test-buyer' }, {
      items, shipping_address: { name: 'Test Buyer', phone: '+4930123456', line1: 'Test street', city: 'Berlin', country_code: 'DE', postal_code: '10115' },
      expected_total: 19.99, currency: 'USD',
    });
    assert.equal(order.total, 19.99);
    assert.equal(order.shipping_fee, 0);
    assert.equal(order.lines[0].route_pricing.revision, 1);
    assert.equal(order.payment.provider, 'demo');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

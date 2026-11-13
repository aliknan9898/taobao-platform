// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* eBay: connect, list (variation group), price/stock sync, order import, tracking back, account-deletion challenge. eBay API is mocked. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ebay-'));
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://kinan.example', EBAY_CLIENT_ID: 'app-id', EBAY_CLIENT_SECRET: 'cert-id', EBAY_RUNAME: 'Kinan-RuName', EBAY_ENV: 'sandbox', EBAY_VERIFICATION_TOKEN: 'tok_0123456789abcdef0123456789abcdef' });
delete process.env.CJ_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.STRIPE_SECRET_KEY;

const calls = [];
let ORDERS = [];
const STORE = []; // [{ name, kids: [] }]
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); const body = opts.body && String(opts.headers?.['Content-Type'] || '').includes('json') ? JSON.parse(opts.body) : opts.body;
  calls.push({ method: opts.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: opts.headers || {} });
  const J = (j, status = 200) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j) });
  assert.ok(u.hostname.endsWith('sandbox.ebay.com'), `sandbox only: ${u.hostname}`);
  const p = u.pathname;
  if (p === '/ws/api.dll') {
    const call = opts.headers['X-EBAY-API-CALL-NAME']; const xml = String(opts.body);
    assert.ok(opts.headers['X-EBAY-API-IAF-TOKEN']);
    const X = (b) => ({ ok: true, status: 200, text: async () => `<?xml version="1.0"?><${call}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>${b}</${call}Response>` });
    if (call === 'GetStore') return X(`<Store><CustomCategories>${STORE.map((c, i) => `<CustomCategory><CategoryID>${i + 1}</CategoryID><Name>${c.name.replace(/&/g, '&amp;')}</Name>${c.kids.map((k) => `<ChildCategory><CategoryID>${i + 1}0</CategoryID><Name>${k}</Name></ChildCategory>`).join('')}</CustomCategory>`).join('')}</CustomCategories></Store>`);
    if (call === 'SetStoreCategories') {
      for (const m of xml.matchAll(/<CustomCategory><Name>([^<]+)<\/Name>((?:<ChildCategory><Name>[^<]+<\/Name><\/ChildCategory>)*)<\/CustomCategory>/g)) STORE.push({ name: m[1].replace(/&amp;/g, '&'), kids: [...m[2].matchAll(/<Name>([^<]+)<\/Name>/g)].map((k) => k[1]) });
      return X('<TaskID>1</TaskID>');
    }
  }
  if (p === '/identity/v1/oauth2/token') {
    const f = new URLSearchParams(opts.body);
    if (f.get('grant_type') === 'authorization_code') assert.strictEqual(f.get('redirect_uri'), 'Kinan-RuName');
    return J({ access_token: `at-${f.get('grant_type')}`, expires_in: 7200, refresh_token: 'rt-1', refresh_token_expires_in: 47304000 });
  }
  if (p.endsWith('/fulfillment_policy') && opts.method !== 'POST') return J({ fulfillmentPolicies: [] });
  if (p.endsWith('/payment_policy') && opts.method !== 'POST') return J({ paymentPolicies: [{ paymentPolicyId: 'PAY1', name: 'Default' }] });
  if (p.endsWith('/return_policy') && opts.method !== 'POST') return J({ returnPolicies: [] });
  if (p.endsWith('/return_policy')) return J({ returnPolicyId: 'RET1' });
  if (p.endsWith('/fulfillment_policy')) return J({ fulfillmentPolicyId: body.name.includes('Europe') ? 'SHIPEU' : 'SHIPGB' });
  if (p.startsWith('/sell/inventory/v1/location/')) return J({}, 204);
  if (p.endsWith('get_default_category_tree_id')) return J({ categoryTreeId: '3' });
  if (p.endsWith('get_category_suggestions')) return J({ categorySuggestions: [{ category: { categoryId: '117414', categoryName: 'Christmas Baubles' } }] });
  if (p.endsWith('get_item_aspects_for_category')) return J({ aspects: [{ localizedAspectName: 'Brand', aspectConstraint: { aspectRequired: true } }, { localizedAspectName: 'Material', aspectConstraint: { aspectRequired: true, aspectMode: 'SELECTION_ONLY' }, aspectValues: [{ localizedValue: 'Glass' }, { localizedValue: 'Plastic' }] }] });
  if (p.startsWith('/sell/inventory/v1/inventory_item')) return J({}, 204);
  if (p === '/sell/inventory/v1/offer' && opts.method === 'POST') return J({ offerId: `OF-${body.sku.slice(-4)}` });
  if (p === '/sell/inventory/v1/offer/publish_by_inventory_item_group') return J({ listingId: '110555' });
  if (/^\/sell\/inventory\/v1\/offer\/[^/]+\/publish$/.test(p)) return J({ listingId: '110777' });
  if (p === '/sell/inventory/v1/bulk_update_price_quantity') return J({ responses: body.requests.map((r) => ({ sku: r.sku, statusCode: 200 })) });
  if (p === '/sell/fulfillment/v1/order') return J({ orders: ORDERS });
  if (/shipping_fulfillment$/.test(p)) return J({}, 201);
  return J({ errors: [{ errorId: 1, message: `unmocked ${p}` }] }, 404);
};

const db = require('../src/db');
const { config } = require('../src/config');
const ebayClient = require('../src/ebay/client');
const ebay = require('../src/services/ebay');

test('eBay: connect, list, sync, orders and tracking', async () => {
  await db.init?.();
  require('../src/services/buyforme').systemSeller();
  db.settings.insert({ id: 'set_fx', base: config.currency.toUpperCase(), rates: { CNY: 7.1, GBP: 0.8, EUR: 0.9 }, updated_at: Date.now() });
  const l = db.listings.insert({
    seller_id: 'sel_kinan', source: 'cj', fulfillment: 'direct', status: 'active', cj_from: 'DE', cj_pid: 'P1', title: 'Christmas Tree Ornaments Ball Set Plastic 12 pcs', description: 'Material: Plastic\nSize: 6cm',
    images: ['https://img.example/1.jpg', 'https://img.example/2.jpg'], collections: ['christmas'],
    skus: [
      { cj_vid: 'V1', mp_sku_id: 'cj_V1', props: 'Red', opts: [{ name: 'Colour', value: 'Red' }], price: 10, cost_sale: 3, stock: 40 },
      { cj_vid: 'V2', mp_sku_id: 'cj_V2', props: 'Gold', opts: [{ name: 'Colour', value: 'Gold' }], price: 12, cost_sale: 3.5, stock: 3 }
    ]
  });
  const other = db.listings.insert({ seller_id: 'sel_other', source: 'cj', fulfillment: 'direct', status: 'active', cj_from: 'DE', title: 'x', images: ['https://a/b.jpg'], skus: [{ cj_vid: 'V9', stock: 5, price: 3 }] });
  const cn = db.listings.insert({ seller_id: 'sel_kinan', source: 'cj', fulfillment: 'direct', status: 'active', cj_from: 'CN', title: 'y', images: ['https://a/b.jpg'], skus: [{ cj_vid: 'V8', stock: 5, price: 3 }] });

  assert.match(ebay.eligible(db.listings.get(other.id)), /Kinan shop/);
  assert.match(ebay.eligible(db.listings.get(cn.id)), /not one of the eBay warehouses/);
  assert.strictEqual(ebay.candidates({ collection: 'christmas' }).length, 1);

  // Connect (OAuth)
  const link = new URL(ebayClient.authUrl());
  assert.strictEqual(link.hostname, 'auth.sandbox.ebay.com');
  assert.match(link.searchParams.get('scope'), /sell\.inventory/);
  await assert.rejects(ebayClient.handleCallback('code', 'bad'), /expired/);
  await ebayClient.handleCallback('code-1', link.searchParams.get('state'));
  assert.ok(ebayClient.connected());

  // List: policies made, item group with two variants, price = (10 + fallback ship) * 1.18 * GBP rate → .99
  const store = await ebay.syncStore();
  assert.strictEqual(store.has, true);
  assert.deepStrictEqual(STORE, [{ name: 'Christmas Shop', kids: ['Gifts'] }]);
  const info = await ebay.listOne(l.id);
  assert.strictEqual(info.listing_id, '110555');
  assert.strictEqual(Object.keys(info.offers).length, 2);
  const offer = calls.find((c) => c.path === '/sell/inventory/v1/offer' && c.method === 'POST').body;
  assert.strictEqual(offer.marketplaceId, 'EBAY_GB');
  assert.strictEqual(offer.listingPolicies.fulfillmentPolicyId, 'SHIPEU'); // DE warehouse → "from Europe" policy
  assert.strictEqual(offer.pricingSummary.price.currency, 'GBP');
  assert.match(offer.pricingSummary.price.value, /\.99$/);
  assert.strictEqual(offer.merchantLocationKey, 'kinan-de');
  assert.deepStrictEqual(offer.storeCategoryNames, ['/Christmas Shop/Gifts']);
  assert.strictEqual(info.store_path, '/Christmas Shop/Gifts');
  const item = calls.find((c) => c.path.startsWith('/sell/inventory/v1/inventory_item/') && c.method === 'PUT');
  assert.strictEqual(item.headers['Content-Language'], 'en-GB');
  assert.ok(calls.filter((c) => c.path.startsWith('/sell/')).every((c) => c.headers['Accept-Language'] && c.headers['Accept-Language'] !== '*'), 'every eBay call names a language');
  assert.deepStrictEqual(item.body.product.aspects.Material, ['Plastic']);
  assert.deepStrictEqual(item.body.product.aspects.Brand, ['Unbranded']);
  assert.ok(item.body.availability.shipToLocationAvailability.quantity <= 10);
  const grp = calls.find((c) => c.path.startsWith('/sell/inventory/v1/inventory_item_group/')).body;
  assert.deepStrictEqual(grp.variesBy.specifications, [{ name: 'Colour', values: ['Red', 'Gold'] }]);
  assert.strictEqual(ebay.candidates({}).length, 0); // listed once

  // Stock follows Kinan
  db.listings.update(l.id, (x) => ({ ...x, skus: x.skus.map((s) => (s.cj_vid === 'V2' ? { ...s, stock: 0 } : s)) }));
  const s = await ebay.sync();
  assert.deepStrictEqual([s.items, s.ok], [2, 2]);
  const bulk = calls.filter((c) => c.path.endsWith('bulk_update_price_quantity')).pop().body.requests;
  assert.strictEqual(bulk.find((r) => r.sku.endsWith('V2')).shipToLocationAvailability.quantity, 0);

  // A paid eBay order becomes a Kinan order (no buyer email; eBay's buyer)
  const key = ebay.skuKey(db.listings.get(l.id), db.listings.get(l.id).skus[0]);
  ORDERS = [{ orderId: '12-34567-89012', orderPaymentStatus: 'PAID', creationDate: new Date().toISOString(), buyer: { username: 'bob_uk' }, pricingSummary: { total: { value: '29.99', currency: 'GBP' } },
    lineItems: [{ lineItemId: 'LI1', sku: key, quantity: 2, title: 'Ornaments' }],
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Bob Smith', primaryPhone: { phoneNumber: '07700900123' }, contactAddress: { addressLine1: '1 High St', city: 'Leeds', postalCode: 'LS1 1AA', countryCode: 'GB' } } } }] }];
  const r1 = await ebay.importOrders();
  assert.strictEqual(r1.added, 1);
  assert.strictEqual((await ebay.importOrders()).added, 0); // once only
  const o = db.orders.find((x) => x.ebay?.order_id === '12-34567-89012');
  assert.strictEqual(o.channel, 'ebay');
  assert.notStrictEqual(o.status, 'pending_payment');
  assert.strictEqual(o.lines[0].qty, 2);
  assert.strictEqual(o.lines[0].cj_from, 'DE');
  assert.strictEqual(o.shipping_address.country_code, 'GB');
  assert.strictEqual(db.users.get(o.buyer_id).email, null);

  // Tracking from CJ goes back to eBay once
  db.orders.update(o.id, (x) => ({ ...x, sub_orders: [{ direct: true, source: 'cj', cj_from: 'DE', line_nos: ['1'], logistics: [{ carrier: 'DHL Paket', tracking: 'JJD000123', method: 'DHL' }] }] }));
  assert.strictEqual((await ebay.pushTracking()).sent, 1);
  assert.strictEqual((await ebay.pushTracking()).sent, 0);
  const sf = calls.filter((c) => /shipping_fulfillment$/.test(c.path)).pop().body;
  assert.deepStrictEqual(sf.lineItems, [{ lineItemId: 'LI1', quantity: 2 }]);
  assert.strictEqual(sf.shippingCarrierCode, 'DHL');

  const tab = ebay.products();
  assert.strictEqual(tab.currency, 'GBP');
  assert.strictEqual(tab.summary.live, 1);
  const row = tab.rows.find((r) => r.id === l.id);
  assert.strictEqual(row.status, 'live');
  assert.strictEqual(row.warehouse_name, 'Germany');
  assert.ok(row.price > 0 && row.fees > 0 && row.cost > 0);
  assert.strictEqual(row.profit, Math.round((row.price - row.fees - row.cost) * 100) / 100);
  assert.strictEqual(tab.orders.length, 1);
  assert.match(ebay.csv(), /Kinan ID.*Profit/);
  const st = ebay.status();
  assert.strictEqual(st.live, 1);
  assert.strictEqual(st.orders, 1);
  assert.strictEqual(st.accept_url, 'https://kinan.example/oauth/ebay/callback');
});

test('eBay account-deletion challenge', () => {
  const ep = 'https://kinan.example/webhooks/ebay/deletion';
  const want = crypto.createHash('sha256').update('abc' + process.env.EBAY_VERIFICATION_TOKEN + ep).digest('hex');
  assert.strictEqual(ebayClient.challenge('abc', ep), want);
  assert.strictEqual(ebay.carrierCode('Royal Mail Tracked 48'), 'Royal Mail');
  assert.strictEqual(ebay.carrierCode('CJPacket'), 'Other');
});

test('eBay: finish connecting by pasting the eBay "Thank you" page address', async () => {
  ebayClient.disconnect();
  assert.ok(!ebayClient.connected());
  await assert.rejects(ebayClient.pasteCode('hello'), /whole address/);
  ebayClient.authUrl();
  await ebayClient.pasteCode('https://auth2.ebay.com/oauth2/ThirdPartyAuthSucessFailure?isAuthSuccessful=true&code=v%5E1.1%23i%5E1%23abcdefghijklmnopqrstuvwxyz&expires_in=299');
  assert.ok(ebayClient.connected());
  const tokenCall = calls.filter((c) => c.path === '/identity/v1/oauth2/token').pop();
  assert.strictEqual(new URLSearchParams(tokenCall.body).get('code'), 'v^1.1#i^1#abcdefghijklmnopqrstuvwxyz');
});

test('eBay: AI best picks — reviews a collection, keeps the good ones, gives them eBay titles, lists them', async () => {
  const ai = require('../src/services/ai');
  const orig = { enabled: ai.enabled, structured: ai.structured };
  const mk = (title, extra = {}) => db.listings.insert({
    seller_id: 'sel_kinan', source: 'cj', fulfillment: 'direct', status: 'active', cj_from: 'GB', cj_pid: `P-${title}`, title, description: 'Material: Felt',
    images: ['https://img.example/a.jpg', 'https://img.example/b.jpg', 'https://img.example/c.jpg'], collections: ['christmas'],
    skus: [{ cj_vid: `V-${title.length}`, mp_sku_id: `cj_${title.length}`, props: '', price: 15, cost_sale: 4, stock: 30 }], ...extra
  });
  const good = mk('Felt Christmas Stocking Large Personalisable'); const bad = mk('Cartoon Mouse Character Lamp'); const ok2 = mk('Advent Calendar Wooden Reusable Drawers');
  const seen = [];
  ai.enabled = () => true;
  ai.structured = async ({ name, text, images }) => {
    seen.push(name);
    if (name === 'shortlist') return { picks: [0, 1, 2] };
    assert.ok(images.length >= 1, 'photos are reviewed');
    if (/Mouse/.test(text)) return { ok: false, score: 2, reason: 'Character design', ebay_title: 'Mouse Lamp Night Light Kids Bedroom Cartoon Character' };
    if (/Stocking/.test(text)) return { ok: true, score: 9, reason: 'Classic gift', ebay_title: 'Large Felt Christmas Stocking Personalised Xmas Stocking Fireplace Decoration' };
    return { ok: true, score: 7, reason: 'Seasonal', ebay_title: 'Wooden Advent Calendar Reusable 24 Drawers Christmas Countdown Decoration' };
  };
  try {
    const r = await ebay.bestPicks({ collection: 'christmas', n: 2 });
    assert.deepStrictEqual(r.picks.map((x) => x.id), [good.id, ok2.id]);
    assert.ok(seen.includes('shortlist') && seen.filter((x) => x === 'ebay_review').length === 3);
    assert.match(db.listings.get(good.id).sourcing.ebay_title, /^Large Felt Christmas Stocking/);
    assert.ok(db.listings.get(good.id).ebay?.listing_id, 'listed on eBay');
    assert.ok(!db.listings.get(bad.id).ebay?.listing_id, 'the rejected one is not listed');
    const offer = calls.filter((c) => c.path.startsWith('/sell/inventory/v1/inventory_item/')).map((c) => c.body?.product?.title).filter(Boolean);
    assert.ok(offer.some((t) => /Wooden Advent Calendar/.test(t)), 'the eBay title is used');
  } finally { Object.assign(ai, orig); }
});

test('GPSR: Kinan as the EU responsible person, warnings by kind of product, on the product page and on eBay', async () => {
  const gpsr = require('../src/services/gpsr');
  const catalog = require('../src/services/catalog');
  const toy = db.listings.insert({
    seller_id: 'sel_kinan', source: 'cj', fulfillment: 'direct', status: 'active', cj_from: 'DE', cj_pid: 'P-toy', title: 'Kids LED Night Light Plush Toy', description: 'Soft plush',
    images: ['https://img.example/t1.jpg', 'https://img.example/t2.jpg'], skus: [{ cj_vid: 'VT1', mp_sku_id: 'cj_VT1', props: '', price: 14, cost_sale: 4, stock: 20 }]
  });
  assert.strictEqual(gpsr.forListing(toy), null, 'nothing until Kinan’s details are filled in');
  assert.throws(() => gpsr.save({ email: 'nope' }), /valid email/);
  const st = gpsr.save({ company: 'Kinan Ltd', address: '1 Triq il-Kbira', city: 'Valletta', postal_code: 'VLT 1000', country: 'mt', email: 'safety@kinan.example' });
  assert.ok(st.ready);
  const g = gpsr.forListing(toy);
  assert.match(g.responsible.address, /Valletta, MT$/);
  assert.ok(g.warnings.some((w) => /under 3 years/.test(w)) && g.warnings.some((w) => /Batteries/.test(w)), 'toy + electrical warnings');
  assert.strictEqual(g.manufacturer, null, 'no made-up manufacturer');
  assert.deepStrictEqual(catalog.buyerListing(toy.id).safety.responsible.name, 'Kinan Ltd');
  calls.length = 0;
  await ebay.listOne(toy.id);
  const offer = calls.find((c) => c.method === 'POST' && c.path === '/sell/inventory/v1/offer');
  assert.deepStrictEqual(offer.body.regulatory.responsiblePersons[0].types, ['EUResponsiblePerson']);
  assert.strictEqual(offer.body.regulatory.responsiblePersons[0].country, 'MT');
  assert.ok(!offer.body.regulatory.manufacturer);
  assert.match(offer.body.listingDescription, /Safety information/);
});

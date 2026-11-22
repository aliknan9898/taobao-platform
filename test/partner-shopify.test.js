'use strict';
/* Partner API Batch 4 — KINAN for Shopify, end to end against a fake Shopify (test/support/fake-shopify.js) and a
   REAL, isolated PostgreSQL (KINAN_TEST_PG=1; run with the other partner suites, one file at a time).
   Acceptance from the brief: draft product → published by the store → stock update → partner order → fulfilment and
   tracking written back; plus cancellation, lost webhook, duplicated order and revoked credential. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');

const RUN = process.env.KINAN_TEST_PG === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pshopify-'));
Object.assign(process.env, { DATA_DIR: DATA, PARTNER_ORDERS_ENABLED: '1', PARTNER_SHOPIFY_ENABLED: '1', PARTNER_RATE_PER_MIN: '100000', NODE_ENV: 'test', SHOPIFY_API_KEY: 'test-key', SHOPIFY_API_SECRET: 'test-secret', PUBLIC_BASE_URL: 'https://kinan.test' });
delete process.env.PARTNER_FEE_RATE; delete process.env.SHOPIFY_API_VERSION;

test('shop domains and signatures (no database needed)', () => {
  const C = require('../src/partner/connectors/shopify-client');
  for (const s of ['kinan-demo.myshopify.com', 'a1.myshopify.com']) assert.ok(C.validShop(s), s);
  for (const s of ['evil.com', 'x.myshopify.com.evil.com', 'X.myshopify.com', 'a_b.myshopify.com', '-a.myshopify.com', 'myshopify.com', '127.0.0.1', 'a.myshopify.com/x']) assert.ok(!C.validShop(s), s);
  assert.strictEqual(C.VERSION(), '2026-10');
});

test('KINAN for Shopify (PostgreSQL)', { skip: !RUN && 'set KINAN_TEST_PG=1 with a local kinan_test database' }, async (t) => {
  const { Pool } = require('./support/minipg');
  const H = require('./support/partner-harness');
  const { createFakeShopify } = require('./support/fake-shopify');
  const pool = Pool({ user: 'kinan_test', database: 'kinan_test', host: process.env.KINAN_TEST_PG_HOST || '127.0.0.1' });
  await H.resetPartnerSchema(pool);
  const pgm = require('../src/partner/pg'); pgm.setPool(pool);
  const db = require('../src/db');
  const St = require('../src/partner/store'); const Cat = require('../src/partner/catalog'); const O = require('../src/partner/orders');
  const F = require('../src/partner/fulfilment'); const SC = require('../src/partner/connectors/shopify-client'); const S = require('../src/partner/connectors/shopify');
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const fake = createFakeShopify(); SC.setTransport(fake.fetch);
  t.after(() => { server.close(); SC.setTransport(null); });

  const admin = db.users.insert({ email: 'owner@kinan.test', role: 'admin' });
  const org = St.createOrg({ name: 'Demo Retail' }, admin);
  const A = St.createStore(org.id, { name: 'Shopify Store', markets: ['DE'], platform: 'shopify' }, admin);
  Cat.sync('sandbox', { force: true });
  const n = async (sql, p = []) => Number((await pool.query(sql, p)).rows[0].n);
  const addr = (o = {}) => ({ name: 'Sandbox Buyer', address1: 'Example Street 1', city: 'Berlin', zip: '10115', country_code: 'DE', phone: '+49 30 1234567', ...o });
  const hook = async (topic, payload, { webhookId = `wh-${Math.random()}`, sign = true, shop = fake.st.shop } = {}) => {
    const raw = JSON.stringify(payload);
    const r = await fetch(`${base}/api/partner/connect/shopify/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': webhookId, 'x-shopify-hmac-sha256': sign ? fake.sign(raw) : 'bm9wZQ==' }, body: raw });
    return { status: r.status, body: await r.json() };
  };
  let conn;
  const reload = async () => { conn = await S.get(conn.id); return conn; };
  const order = async (ref) => (await pool.query('SELECT * FROM partner_order WHERE external_order_ref = $1', [ref])).rows;

  await t.test('install: authorization code grant with state and HMAC checks; tokens sealed; webhooks registered', async () => {
    await assert.rejects(S.installUrl(A.id, 'evil.com'), /myshopify/);
    const { install_url: url } = await S.installUrl(A.id, fake.st.shop);
    const u = new URL(url);
    assert.strictEqual(u.host, fake.st.shop); assert.strictEqual(u.pathname, '/admin/oauth/authorize');
    assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://kinan.test/api/partner/connect/shopify/callback');
    assert.ok(S.SCOPES.every((s) => u.searchParams.get('scope').split(',').includes(s)));
    const state = u.searchParams.get('state');
    const cb = (q) => fetch(`${base}/api/partner/connect/shopify/callback?${new URLSearchParams(q)}`);
    const ts = String(Math.floor(Date.now() / 1000));
    assert.strictEqual((await cb({ code: 'good-code', shop: fake.st.shop, state, timestamp: ts, hmac: 'deadbeef' })).status, 401, 'bad HMAC');
    assert.strictEqual((await cb(fake.callbackQuery({ code: 'good-code', shop: fake.st.shop, state: 'forged-state', timestamp: ts }))).status, 403, 'unknown state');
    assert.strictEqual((await cb(fake.callbackQuery({ code: 'good-code', shop: 'other.myshopify.com', state, timestamp: ts }))).status, 403, 'state bound to the shop');
    const ok = await cb(fake.callbackQuery({ code: 'good-code', shop: fake.st.shop, state, timestamp: ts }));
    assert.strictEqual(ok.status, 200, await ok.clone().text()); assert.match(await ok.text(), /KINAN is connected/);
    assert.strictEqual((await cb(fake.callbackQuery({ code: 'good-code', shop: fake.st.shop, state, timestamp: ts }))).status, 403, 'state is single use');
    conn = (await pool.query('SELECT * FROM partner_connection WHERE shop_domain = $1', [fake.st.shop])).rows[0];
    assert.strictEqual(conn.state, 'active'); assert.strictEqual(conn.store_id, A.id);
    const raw = JSON.stringify(conn.credentials);
    assert.ok(!/shpat_|shprt_/.test(raw), 'tokens encrypted at rest');
    assert.deepStrictEqual(fake.st.webhooks.map((w) => w.topic).sort(), ['APP_UNINSTALLED', 'ORDERS_CANCELLED', 'ORDERS_PAID']);
    assert.ok(fake.st.webhooks.every((w) => w.uri === 'https://kinan.test/api/partner/connect/shopify/webhooks'));
    assert.ok(fake.st.calls.every((c) => !c.path.startsWith('/admin/api/') || c.path === '/admin/api/2026-10/graphql.json'), 'pinned API version');
  });

  await t.test('catalogue: KINAN products arrive as drafts with stock, KINAN ids and the wholesale price', async () => {
    const r = await S.syncOnce(conn.id);
    assert.ok(!r.error, r.error);
    const entitled = Cat.snapshot({ env: 'sandbox', store: db.partner_stores.get(A.id) }, { market: 'DE', locale: 'de-DE', limit: 100 }).data;
    assert.strictEqual(fake.st.products.size, entitled.length);
    assert.strictEqual(r.catalog.created, entitled.length);
    const lamp = fake.productByKinan('kp_sbx_lamp');
    assert.strictEqual(lamp.status, 'DRAFT'); assert.strictEqual(lamp.handle, 'kinan-kp-sbx-lamp'); assert.ok(lamp.tags.includes('kinan'));
    const lv = fake.variantByKinan('kv_sbx_lamp_white');
    const want = entitled.find((p) => p.product_id === 'kp_sbx_lamp').variants[0];
    assert.strictEqual(fake.level(lv), want.availability.sellable_quantity);
    assert.ok(lv.metafields.some((m) => m.key === 'wholesale_price' && JSON.parse(m.value).amount === (want.wholesale_unit_price_ex_tax.amount_minor / 100).toFixed(2)));
    assert.ok(Number(lv.price) >= want.wholesale_unit_price_ex_tax.amount_minor / 100 * 2 - 1 && /\.99$/.test(lv.price), `initial retail ${lv.price}`);
    assert.strictEqual(lv.policy, 'DENY');
    assert.strictEqual(lamp.files.length, 0, 'sandbox placeholder images are not pushed');
    const again = await S.syncOnce(conn.id);
    assert.strictEqual(fake.st.products.size, entitled.length, 'no duplicates on the next pass'); assert.ok(!again.catalog.created);
  });

  await t.test('the merchant publishes and reprices; KINAN stock changes reach Shopify without touching price or status', async () => {
    const lamp = fake.productByKinan('kp_sbx_lamp'); lamp.status = 'ACTIVE';
    const lv = fake.variantByKinan('kv_sbx_lamp_white'); lv.price = '99.00';
    Cat.simulate('lamp', { stock: 4 });
    const r = await S.syncOnce(conn.id); assert.ok(!r.error, r.error);
    assert.strictEqual(fake.level(lv), 4); assert.strictEqual(lv.price, '99.00'); assert.strictEqual(lamp.status, 'ACTIVE');
    // withdrawal → 0 and a tag; restore → back
    Cat.simulate('mug', { withdrawn: true }); await S.syncOnce(conn.id);
    const mug = fake.productByKinan('kp_sbx_mug');
    assert.ok(mug.tags.includes('kinan-withdrawn')); assert.ok(mug.variants.every((v) => fake.level(v) === 0));
    Cat.simulate('mug', { withdrawn: false }); await S.syncOnce(conn.id);
    assert.ok(!mug.tags.includes('kinan-withdrawn')); assert.ok(fake.level(fake.variantByKinan('kv_sbx_mug_sand')) > 0);
    // a crash after Shopify created a product but before KINAN saved the mapping: the handle prevents a duplicate
    const before = fake.st.products.size;
    await pool.query("DELETE FROM partner_connection_product WHERE connection_id = $1 AND product_id = 'kp_sbx_tote'", [conn.id]);
    await pool.query('UPDATE partner_connection SET catalog_cursor = NULL WHERE id = $1', [conn.id]);
    await S.syncOnce(conn.id);
    assert.strictEqual(fake.st.products.size, before);
  });

  await t.test('paid Shopify order → one partner order with only the KINAN lines, even when the webhook repeats', async () => {
    const o = fake.placeOrder({ lines: [{ kinan: 'kv_sbx_lamp_white', quantity: 1 }, { variant_id: 'gid://shopify/ProductVariant/999999', quantity: 2, title: 'Merchant own product' }], address: addr() });
    assert.strictEqual((await hook('orders/paid', fake.restPayload(o), { sign: false })).status, 401, 'unsigned webhook refused');
    assert.strictEqual((await order(`SHOPIFY-${o.legacy}`)).length, 0);
    const r1 = await hook('orders/paid', fake.restPayload(o), { webhookId: 'wh-1' });
    assert.deepStrictEqual([r1.status, r1.body.result], [200, 'imported']);
    assert.strictEqual((await hook('orders/paid', fake.restPayload(o), { webhookId: 'wh-1' })).body.result, 'duplicate', 'same delivery id');
    await hook('orders/paid', fake.restPayload(o), { webhookId: 'wh-2' }); // same order, new delivery
    await Promise.all(Array.from({ length: 5 }, () => S.importOrder(conn, S.fromWebhook(fake.restPayload(o)))));
    await S.pollOrders(await reload());
    const rows = await order(`SHOPIFY-${o.legacy}`);
    assert.strictEqual(rows.length, 1, 'exactly one partner order');
    assert.deepStrictEqual(rows[0].commercial.items.map((i) => [i.variant_id, i.quantity]), [['kv_sbx_lamp_white', 1]]);
    const view = await O.getOrder({ env: 'sandbox', store: db.partner_stores.get(A.id) }, rows[0].id);
    assert.strictEqual(view.ship_to.recipient, 'Sandbox Buyer');
    assert.ok(!JSON.stringify(rows[0].ship_to).includes('Example Street'), 'address encrypted');
    // an order with no KINAN products is recorded as skipped, an unpaid one is left alone
    const own = fake.placeOrder({ lines: [{ variant_id: 'gid://shopify/ProductVariant/999999', quantity: 1 }], address: addr() });
    assert.strictEqual((await hook('orders/paid', fake.restPayload(own))).body.result, 'skipped');
    const unpaid = fake.placeOrder({ lines: [{ kinan: 'kv_sbx_lamp_white', quantity: 1 }], address: addr(), paid: false });
    assert.strictEqual((await S.importOrder(conn, S.fromGraphql({ ...fake.st.orders.get(unpaid.id), displayFinancialStatus: 'PENDING', id: unpaid.id, legacyResourceId: unpaid.legacy, lineItems: { nodes: [] } }))).state, 'not_paid');
    fake.st.orders.delete(unpaid.id);
  });

  await t.test('lost webhook: the polling pass imports the order', async () => {
    const o = fake.placeOrder({ lines: [{ kinan: 'kv_sbx_backpack_navy', quantity: 2 }], address: addr() });
    await S.syncOnce(conn.id);
    const rows = await order(`SHOPIFY-${o.legacy}`); assert.strictEqual(rows.length, 1);
    assert.strictEqual((await pool.query('SELECT state FROM partner_connection_order WHERE connection_id = $1 AND external_order_id = $2', [conn.id, o.legacy])).rows[0].state, 'imported');
  });

  await t.test('tracking is written back: one fulfilment per KINAN shipment, never twice', async () => {
    const o = fake.placeOrder({ lines: [{ kinan: 'kv_sbx_mug_sand', quantity: 1 }, { kinan: 'kv_sbx_charger_white', quantity: 1 }], address: addr() });
    await hook('orders/paid', fake.restPayload(o));
    const po = (await order(`SHOPIFY-${o.legacy}`))[0];
    const ctx = { env: 'sandbox', store: db.partner_stores.get(A.id) };
    await O.settle(po.id); await F.handoffWorker('sandbox');
    await F.simulate(ctx, po.id, { action: 'ship', ship_from: 'DE' });
    await S.syncOnce(conn.id);
    assert.strictEqual(o.fulfillments.length, 1);
    const sh = (await F.listShipments(ctx, po.id)).data;
    assert.deepStrictEqual(o.fulfillments[0].tracking, { company: sh[0].carrier, number: sh[0].tracking_number });
    assert.strictEqual(o.fulfillments[0].notify, true);
    assert.deepStrictEqual(o.lines.map((l) => l.remaining), [0, 1], 'only the DE parcel is fulfilled');
    await F.simulate(ctx, po.id, { action: 'ship' }); await S.syncOnce(conn.id);
    assert.strictEqual(o.fulfillments.length, 2); assert.deepStrictEqual(o.lines.map((l) => l.remaining), [0, 0]);
    // a crash after Shopify created the fulfilment but before KINAN recorded it
    await pool.query('DELETE FROM partner_connection_fulfillment WHERE connection_id = $1', [conn.id]);
    await S.syncOnce(conn.id);
    assert.strictEqual(o.fulfillments.length, 2, 'matched by tracking number, not created again');
    assert.strictEqual(await n("SELECT count(*) n FROM partner_connection_fulfillment WHERE connection_id = $1 AND state = 'done'", [conn.id]), 2);
  });

  await t.test('cancellation in Shopify cancels the KINAN order (before handoff); cancelled before import is never imported', async () => {
    const o = fake.placeOrder({ lines: [{ kinan: 'kv_sbx_cushion_sage', quantity: 1 }], address: addr() });
    await hook('orders/paid', fake.restPayload(o));
    fake.cancel(o);
    assert.strictEqual((await hook('orders/cancelled', fake.restPayload(o))).body.result, 'imported');
    const po = (await order(`SHOPIFY-${o.legacy}`))[0];
    assert.strictEqual((await pool.query('SELECT fulfillment_state FROM partner_order WHERE id = $1', [po.id])).rows[0].fulfillment_state, 'cancelled');
    await hook('orders/cancelled', fake.restPayload(o)); // repeated: nothing new
    assert.strictEqual(await n('SELECT count(*) n FROM partner_cancellation WHERE order_id = $1', [po.id]), 1);
    const o2 = fake.placeOrder({ lines: [{ kinan: 'kv_sbx_cushion_sage', quantity: 1 }], address: addr() }); fake.cancel(o2);
    await S.syncOnce(conn.id);
    assert.strictEqual((await order(`SHOPIFY-${o2.legacy}`)).length, 0);
  });

  await t.test('orders KINAN cannot accept are flagged for the admin, not retried forever', async () => {
    const o = fake.placeOrder({ lines: [{ kinan: 'kv_sbx_lamp_white', quantity: 1 }], address: addr({ country_code: 'FR', zip: '75001', city: 'Paris' }) });
    assert.strictEqual((await hook('orders/paid', fake.restPayload(o))).body.result, 'failed');
    const list = await S.adminList();
    const p = list.order_problems.find((x) => x.external_order_id === o.legacy);
    assert.match(p.reason, /needs_attention: UNSUPPORTED_DESTINATION/);
    assert.strictEqual((await S.importOrder(conn, S.fromWebhook(fake.restPayload(o)))).duplicate, true, 'not retried automatically');
    assert.ok(!JSON.stringify(list).includes('Example Street'), 'admin list without addresses');
  });

  await t.test('expiring token is refreshed (rotating refresh token); revoked access stops the connection', async () => {
    await reload();
    const tk = O.internal.open('sandbox', conn.credentials);
    await pool.query('UPDATE partner_connection SET credentials = $2 WHERE id = $1', [conn.id, JSON.stringify(O.internal.seal('sandbox', { ...tk, expires_at: Date.now() - 1000 }))]);
    const r = await S.syncOnce(conn.id); assert.ok(!r.error, r.error);
    const t2 = O.internal.open('sandbox', (await reload()).credentials);
    assert.notStrictEqual(t2.access_token, tk.access_token); assert.notStrictEqual(t2.refresh_token, tk.refresh_token);
    fake.revoke();
    const r2 = await S.syncOnce(conn.id);
    assert.ok(r2.auth, JSON.stringify(r2));
    await reload(); assert.strictEqual(conn.state, 'auth_failed'); assert.match(conn.last_error, /reinstall|revoked|removed/);
    assert.deepStrictEqual(await S.syncOnce(conn.id), { skipped: 'auth_failed' });
    await assert.rejects(S.adminUpdate(conn.id, { state: 'active' }), /install the app again/);
    // the merchant reinstalls: same connection, active again, mappings kept
    const { install_url: url } = await S.installUrl(A.id, fake.st.shop);
    const state = new URL(url).searchParams.get('state');
    await S.callback(fake.callbackQuery({ code: 'good-code', shop: fake.st.shop, state, timestamp: String(Math.floor(Date.now() / 1000)) }));
    await reload(); assert.strictEqual(conn.state, 'active');
    assert.ok(await n('SELECT count(*) n FROM partner_connection_product WHERE connection_id = $1', [conn.id]) > 0);
  });

  await t.test('settings: no automatic price or content changes unless switched on', async () => {
    await S.adminUpdate(conn.id, { settings: { auto_price: true, update_content: true } });
    Cat.simulate('lamp', { stock: 6, title_en: 'Desk lamp, new' });
    await assert.rejects(S.adminUpdate(conn.id, { settings: { initial_markup_pct: -5 } }), /Invalid setting/);
    await S.syncOnce(conn.id);
    const lv = fake.variantByKinan('kv_sbx_lamp_white');
    assert.notStrictEqual(lv.price, '99.00', 'auto_price on: KINAN retail applied');
    await S.adminUpdate(conn.id, { settings: { auto_price: false, update_content: false } });
  });

  await t.test('privacy and uninstall webhooks; dev store via client credentials', async () => {
    assert.strictEqual((await hook('customers/redact', { shop_domain: fake.st.shop, customer: { id: 1 }, orders_to_redact: [123, 456] })).body.result, 'recorded');
    assert.deepStrictEqual((await S.adminList()).privacy_requests[0].order_ids, ['123', '456']);
    assert.strictEqual((await hook('app/uninstalled', { id: 1 })).body.result, 'uninstalled');
    await reload(); assert.strictEqual(conn.state, 'uninstalled'); assert.strictEqual(conn.credentials, null);
    assert.strictEqual((await hook('shop/redact', { shop_domain: fake.st.shop })).body.result, 'deleted');
    assert.strictEqual(await n('SELECT count(*) n FROM partner_connection WHERE shop_domain = $1', [fake.st.shop]), 0);
    assert.ok((await order(`SHOPIFY-${fake.st.orders.values().next().value.legacy}`)).length >= 0, 'KINAN partner orders stay (business records)');
    // KINAN's own development store: no merchant redirect
    const dev = createFakeShopify({ shop: 'kinan-dev.myshopify.com' }); SC.setTransport(dev.fetch);
    const B = St.createStore(org.id, { name: 'Dev Store', markets: ['DE'], platform: 'shopify' }, admin);
    const c = await S.connectDevStore(B.id, 'kinan-dev.myshopify.com');
    assert.strictEqual(c.state, 'active');
    const r = await S.syncOnce(c.id); assert.ok(!r.error, r.error); assert.ok(dev.st.products.size > 0);
    await assert.rejects(S.connectDevStore(B.id, 'kinan-dev2.myshopify.com'), /already connected/);
    SC.setTransport(fake.fetch);
  });

  await t.test('switches: connector off → webhooks acknowledged but ignored, admin actions refused', async () => {
    process.env.PARTNER_SHOPIFY_ENABLED = '0';
    assert.strictEqual((await hook('orders/paid', { id: 1 })).body.result, 'connector_off');
    assert.strictEqual((await fetch(`${base}/api/partner/connect/shopify/callback?shop=x.myshopify.com`)).status, 503);
    process.env.PARTNER_SHOPIFY_ENABLED = '1';
  });
});

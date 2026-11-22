'use strict';
/* KINAN for WooCommerce, end to end against a fake WooCommerce (test/support/fake-woocommerce.js) and a REAL, isolated
   PostgreSQL (KINAN_TEST_PG=1; run with the other partner suites, one file at a time). Same acceptance as Shopify:
   draft product → published by the store → stock update → partner order → tracking back, plus cancellation, lost
   webhook, duplicated order and revoked key. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');

const RUN = process.env.KINAN_TEST_PG === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pwoo-'));
Object.assign(process.env, { DATA_DIR: DATA, PARTNER_ORDERS_ENABLED: '1', PARTNER_WOOCOMMERCE_ENABLED: '1', PARTNER_SHOPIFY_ENABLED: '1', SHOPIFY_API_KEY: 'test-key', SHOPIFY_API_SECRET: 'test-secret', PARTNER_RATE_PER_MIN: '100000', NODE_ENV: 'test', PUBLIC_BASE_URL: 'https://kinan.test' });
delete process.env.PARTNER_FEE_RATE;

test('shop addresses (no database needed)', () => {
  const WC = require('../src/partner/connectors/woo-client');
  assert.deepStrictEqual(WC.normalizeBase('https://Shop.Example.org/store/'), { base: 'https://shop.example.org/store', key: 'shop.example.org/store' });
  assert.strictEqual(WC.normalizeBase('https://shop.example.org/wp-json/wc/v3').base, 'https://shop.example.org');
  for (const bad of ['http://shop.example.org', 'https://127.0.0.1', 'https://localhost/shop', 'https://10.0.0.8', 'https://u:p@shop.example.org', 'https://printer.local', 'ftp://x.org', 'https://shop.example.org/?a=1']) assert.throws(() => WC.normalizeBase(bad), (e) => e.status === 400, bad);
});

test('the pinned HTTPS transport refuses shops that resolve to private addresses', async () => {
  const W = require('../src/partner/webhooks'); const WC = require('../src/partner/connectors/woo-client');
  W.setLookup(async () => ['169.254.169.254']);
  await assert.rejects(WC._pinned('https://rebind.example.org/wp-json/wc/v3/products'), /private network/);
  W.setLookup(async () => ['93.184.216.34', '192.168.1.5']);
  await assert.rejects(WC._pinned('https://mixed.example.org/wp-json/wc/v3/products'), /private network/);
});

test('KINAN for WooCommerce (PostgreSQL)', { skip: !RUN && 'set KINAN_TEST_PG=1 with a local kinan_test database' }, async (t) => {
  const { Pool } = require('./support/minipg');
  const H = require('./support/partner-harness');
  const { createFakeWoo } = require('./support/fake-woocommerce');
  const pool = Pool({ user: 'kinan_test', database: 'kinan_test', host: process.env.KINAN_TEST_PG_HOST || '127.0.0.1' });
  await H.resetPartnerSchema(pool);
  const pgm = require('../src/partner/pg'); pgm.setPool(pool);
  const db = require('../src/db');
  const St = require('../src/partner/store'); const Cat = require('../src/partner/catalog'); const O = require('../src/partner/orders');
  const F = require('../src/partner/fulfilment'); const WC = require('../src/partner/connectors/woo-client'); const Wo = require('../src/partner/connectors/woocommerce');
  const core = require('../src/partner/connectors/core');
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const woo = createFakeWoo(); WC.setTransport(woo.transport);
  t.after(() => { server.close(); WC.setTransport(null); });

  const admin = db.users.insert({ email: 'owner@kinan.test', role: 'admin' });
  const org = St.createOrg({ name: 'Demo Retail' }, admin);
  const A = St.createStore(org.id, { name: 'Woo Store', markets: ['DE'], platform: 'woocommerce' }, admin);
  Cat.sync('sandbox', { force: true });
  const ctx = () => ({ env: 'sandbox', store: db.partner_stores.get(A.id) });
  const n = async (sql, p = []) => Number((await pool.query(sql, p)).rows[0].n);
  const order = async (ref) => (await pool.query('SELECT * FROM partner_order WHERE external_order_ref = $1', [ref])).rows;
  let conn; const reload = async () => { conn = await core.get(conn.id); return conn; };
  let delivery = 0;
  const hook = async (o, { topic = 'order.updated', sign = true, deliveryId = String(++delivery), id } = {}) => {
    const raw = JSON.stringify(o);
    const r = await fetch(`${base}/api/partner/connect/woocommerce/webhooks/${id || conn.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wc-webhook-topic': topic, 'x-wc-webhook-resource': 'order', 'x-wc-webhook-event': topic.split('.')[1], 'x-wc-webhook-delivery-id': deliveryId, 'x-wc-webhook-source': `${woo.base}/`, ...(sign ? { 'x-wc-webhook-signature': woo.sign(raw, woo.secretFor(topic)) } : {}) }, body: raw });
    return { status: r.status, body: await r.json() };
  };

  await t.test('connect: WooCommerce approval screen posts the keys to KINAN; checks; webhooks with their own secret', async () => {
    await assert.rejects(Wo.connectUrl(A.id, 'http://woo-demo.example.org/shop'), (e) => e.status === 400);
    const { connect_url: url } = await Wo.connectUrl(A.id, `${woo.base}/`);
    const u = new URL(url);
    assert.strictEqual(`${u.origin}${u.pathname}`, `${woo.base}/wc-auth/v1/authorize`);
    assert.deepStrictEqual([u.searchParams.get('app_name'), u.searchParams.get('scope')], ['KINAN', 'read_write']);
    assert.strictEqual(u.searchParams.get('callback_url'), 'https://kinan.test/api/partner/connect/woocommerce/callback');
    const state = u.searchParams.get('user_id');
    const keys = woo.issueKeys();
    const cb = (b) => fetch(`${base}/api/partner/connect/woocommerce/callback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.strictEqual((await cb({ key_id: 1, user_id: 'forged', ...keys, key_permissions: 'read_write' })).status, 403);
    assert.strictEqual((await cb({ key_id: 1, user_id: state, ...keys, key_permissions: 'read' })).status, 400, 'read-only refused');
    const { connect_url: url2 } = await Wo.connectUrl(A.id, woo.base);
    const r = await cb({ key_id: 1, user_id: new URL(url2).searchParams.get('user_id'), ...keys, key_permissions: 'read_write' });
    assert.strictEqual(r.status, 200, await r.clone().text());
    conn = (await pool.query(`SELECT * FROM partner_connection WHERE platform = 'woocommerce'`)).rows[0];
    assert.deepStrictEqual([conn.state, conn.shop_domain, conn.store_id], ['active', 'woo-demo.example.org/shop', A.id]);
    assert.ok(!JSON.stringify(conn.credentials).includes(keys.consumer_secret), 'keys encrypted at rest');
    assert.deepStrictEqual(woo.st.webhooks.map((h) => h.topic).sort(), ['order.created', 'order.updated']);
    assert.ok(woo.st.webhooks.every((h) => h.delivery_url === `https://kinan.test/api/partner/connect/woocommerce/webhooks/${conn.id}` && h.secret && h.secret.length >= 30));
    const ret = await fetch(`${base}/api/partner/connect/woocommerce/return?success=1&user_id=${state}`); assert.match(await ret.text(), /KINAN is connected/);
    // WooCommerce pings a new webhook without a signature
    const ping = await fetch(`${base}/api/partner/connect/woocommerce/webhooks/${conn.id}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'webhook_id=17' });
    assert.deepStrictEqual((await ping.json()).result, 'ping');
    await assert.rejects(Wo.connectWithKeys(A.id, woo.base, 'ck_x', 'cs_y'), (e) => e.status === 400);
    const B = St.createStore(org.id, { name: 'Other', markets: ['DE'] }, admin);
    await assert.rejects(Wo.connectWithKeys(B.id, woo.base, `ck_${'a'.repeat(40)}`, `cs_${'b'.repeat(40)}`), (e) => e.status === 403, 'unknown keys refused');
    await assert.rejects(require('../src/partner/connectors/shopify').installUrl(A.id, 'x.myshopify.com'), /already connected/, 'one shop per partner store, any platform');
  });

  await t.test('catalogue: drafts with KINAN-prefixed SKUs, managed stock and KINAN meta data', async () => {
    const r = await core.syncOnce(conn.id); assert.ok(!r.error, r.error);
    const entitled = Cat.snapshot(ctx(), { market: 'DE', locale: 'de-DE', limit: 100 }).data;
    assert.strictEqual(woo.st.products.size, entitled.length);
    for (const p of woo.st.products.values()) assert.strictEqual(p.status, 'draft');
    const lamp = woo.productByKinan('kp_sbx_lamp');
    const want = entitled.find((p) => p.product_id === 'kp_sbx_lamp');
    const f = woo.variationByKinan('kv_sbx_lamp_white'); const item = f.v || f.p;
    assert.ok(item.sku.startsWith('KINAN-')); assert.strictEqual(item.manage_stock, true);
    assert.strictEqual(item.stock_quantity, want.variants[0].availability.sellable_quantity);
    assert.strictEqual(woo.meta(item, 'kinan_wholesale_price'), (want.variants[0].wholesale_unit_price_ex_tax.amount_minor / 100).toFixed(2));
    assert.match(item.regular_price, /\.99$/);
    assert.strictEqual(lamp.type, want.variants.length === 1 && !Object.keys(want.variants[0].options || {}).length ? 'simple' : 'variable');
    assert.ok([...woo.st.products.values()].some((p) => p.type === 'variable' && p.variations.length > 1), 'variable products with variations');
    assert.strictEqual((await core.syncOnce(conn.id)).catalog.created || 0, 0);
  });

  await t.test('the merchant publishes and reprices; KINAN stock changes still arrive; price kept; withdraw/restore; crash-safe create', async () => {
    const f = woo.variationByKinan('kv_sbx_lamp_white'); const item = f.v || f.p;
    f.p.status = 'publish'; item.regular_price = '99.00';
    Cat.simulate('lamp', { stock: 4 }); await core.syncOnce(conn.id);
    assert.strictEqual(item.stock_quantity, 4); assert.strictEqual(item.regular_price, '99.00'); assert.strictEqual(f.p.status, 'publish');
    Cat.simulate('mug', { withdrawn: true }); await core.syncOnce(conn.id);
    const mug = woo.productByKinan('kp_sbx_mug');
    assert.strictEqual(woo.meta(mug, 'kinan_withdrawn'), '1'); assert.ok((mug.variations.length ? mug.variations : [mug]).every((v) => v.stock_quantity === 0));
    Cat.simulate('mug', { withdrawn: false }); await core.syncOnce(conn.id);
    assert.strictEqual(woo.meta(mug, 'kinan_withdrawn'), '0');
    const before = woo.st.products.size;
    await pool.query("DELETE FROM partner_connection_product WHERE connection_id = $1 AND product_id = 'kp_sbx_mug'", [conn.id]);
    await pool.query('UPDATE partner_connection SET catalog_cursor = NULL WHERE id = $1', [conn.id]);
    const r = await core.syncOnce(conn.id); assert.ok(!r.error, r.error);
    assert.strictEqual(woo.st.products.size, before, 'found by SKU, not created twice');
  });

  await t.test('paid order → one partner order (KINAN lines only), whatever WooCommerce repeats; signatures checked', async () => {
    const o = woo.placeOrder({ lines: [{ kinan: 'kv_sbx_lamp_white', quantity: 1 }, { product_id: 555, quantity: 1 }] });
    assert.strictEqual((await hook(o, { sign: false })).status, 401);
    const bad = await fetch(`${base}/api/partner/connect/woocommerce/webhooks/${conn.id}`, { method: 'POST', headers: { 'x-wc-webhook-topic': 'order.updated', 'x-wc-webhook-signature': woo.sign(JSON.stringify(o), 'wrong-secret') }, body: JSON.stringify(o) });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual((await hook(o, { deliveryId: 'd-1' })).body.result, 'imported');
    assert.strictEqual((await hook(o, { deliveryId: 'd-1' })).body.result, 'duplicate');
    await hook(o, { topic: 'order.created' });
    await Promise.all(Array.from({ length: 5 }, () => core.importOrder(conn, Wo.fromWoo(o))));
    await Wo.pollOrders(await reload());
    const rows = await order(`WOO-${o.id}`);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].commercial.items.map((i) => [i.variant_id, i.quantity]), [['kv_sbx_lamp_white', 1]]);
    assert.strictEqual((await O.getOrder(ctx(), rows[0].id)).ship_to.recipient, 'Sandbox Buyer');
    const pending = woo.placeOrder({ lines: [{ kinan: 'kv_sbx_lamp_white', quantity: 1 }], status: 'pending', paid: false });
    assert.strictEqual((await hook(pending)).body.result, 'not_paid');
    assert.strictEqual((await hook(o, { id: 'pcn_doesnotexist' })).status, 401, 'unknown connection');
  });

  await t.test('lost webhook: polling imports the order', async () => {
    const o = woo.placeOrder({ lines: [{ kinan: 'kv_sbx_backpack_navy', quantity: 2 }] });
    await core.syncOnce(conn.id);
    assert.strictEqual((await order(`WOO-${o.id}`)).length, 1);
  });

  await t.test('tracking back to WooCommerce: customer note, Shipment Tracking when installed, completed when all shipped; never twice', async () => {
    woo.st.trackingExtension = true;
    const o = woo.placeOrder({ lines: [{ kinan: 'kv_sbx_mug_sand', quantity: 1 }, { kinan: 'kv_sbx_charger_white', quantity: 1 }] });
    await hook(o); const po = (await order(`WOO-${o.id}`))[0];
    await O.settle(po.id); await F.handoffWorker('sandbox');
    await F.simulate(ctx(), po.id, { action: 'ship', ship_from: 'DE' }); await core.syncOnce(conn.id);
    assert.strictEqual(o.notes.length, 1); assert.strictEqual(o.notes[0].customer_note, true);
    const sh = (await F.listShipments(ctx(), po.id)).data;
    assert.ok(o.notes[0].note.includes(sh[0].tracking_number) && o.notes[0].note.includes(sh[0].carrier));
    assert.strictEqual(woo.st.trackings.length, 1); assert.strictEqual(woo.st.trackings[0].tracking_number, sh[0].tracking_number);
    assert.strictEqual(o.status, 'processing', 'not complete while the CN parcel has not shipped');
    await F.simulate(ctx(), po.id, { action: 'ship' }); await core.syncOnce(conn.id);
    assert.strictEqual(o.notes.length, 2); assert.strictEqual(o.status, 'completed');
    await pool.query('DELETE FROM partner_connection_fulfillment WHERE connection_id = $1', [conn.id]);
    await core.syncOnce(conn.id);
    assert.strictEqual(o.notes.length, 2, 'matched by tracking number, not added again');
    // mixed order: the merchant ships their own line, so KINAN does not complete it
    const mixed = woo.placeOrder({ lines: [{ kinan: 'kv_sbx_cushion_sage', quantity: 1 }, { product_id: 555, quantity: 1 }] });
    await hook(mixed); const pm = (await order(`WOO-${mixed.id}`))[0];
    await O.settle(pm.id); await F.handoffWorker('sandbox'); await F.simulate(ctx(), pm.id, { action: 'ship' }); await core.syncOnce(conn.id);
    assert.strictEqual(mixed.notes.length, 1); assert.strictEqual(mixed.status, 'processing');
    woo.st.trackingExtension = false;
  });

  await t.test('cancelled in WooCommerce → KINAN cancellation', async () => {
    const o = woo.placeOrder({ lines: [{ kinan: 'kv_sbx_tote_natural', quantity: 1 }] });
    await hook(o);
    o.status = 'cancelled'; woo.touch(o);
    assert.strictEqual((await hook(o)).body.result, 'imported');
    const po = (await order(`WOO-${o.id}`))[0];
    assert.strictEqual((await pool.query('SELECT fulfillment_state FROM partner_order WHERE id = $1', [po.id])).rows[0].fulfillment_state, 'cancelled');
  });

  await t.test('revoked key → access lost; reconnect with new keys keeps the mappings; disconnect removes KINAN webhooks', async () => {
    woo.revoke();
    const r = await core.syncOnce(conn.id); assert.ok(r.auth, JSON.stringify(r));
    await reload(); assert.strictEqual(conn.state, 'auth_failed');
    assert.deepStrictEqual(await core.syncOnce(conn.id), { skipped: 'auth_failed' });
    const k2 = woo.issueKeys();
    const c2 = await Wo.connectWithKeys(A.id, woo.base, k2.consumer_key, k2.consumer_secret);
    assert.strictEqual(c2.id, conn.id); assert.strictEqual(c2.state, 'active');
    assert.ok(await n('SELECT count(*) n FROM partner_connection_product WHERE connection_id = $1', [conn.id]) > 0);
    // the webhook secret survives a reconnect, so deliveries signed before keep verifying
    const o = woo.placeOrder({ lines: [{ kinan: 'kv_sbx_lamp_white', quantity: 1 }] });
    assert.strictEqual((await hook(o)).body.result, 'imported');
    const d = await core.adminDisconnect(conn.id);
    assert.strictEqual(d.state, 'uninstalled'); assert.match(d.note, /REST API/);
    assert.strictEqual(woo.st.webhooks.length, 0, 'KINAN webhooks removed from the shop');
    await reload(); assert.strictEqual(conn.credentials, null);
    const raw = JSON.stringify(o);
    const r2 = await fetch(`${base}/api/partner/connect/woocommerce/webhooks/${conn.id}`, { method: 'POST', headers: { 'x-wc-webhook-topic': 'order.updated', 'x-wc-webhook-signature': woo.sign(raw, 'any-secret') }, body: raw });
    assert.strictEqual(r2.status, 401, 'no credentials → nothing accepted');
  });

  await t.test('switches: WooCommerce connector off', async () => {
    const k3 = woo.issueKeys(); await Wo.connectWithKeys(A.id, woo.base, k3.consumer_key, k3.consumer_secret);
    process.env.PARTNER_WOOCOMMERCE_ENABLED = '0';
    assert.deepStrictEqual(await core.syncOnce(conn.id), { skipped: 'connector_off' });
    assert.strictEqual((await hook({ id: 1 })).body.result, 'connector_off');
    assert.strictEqual(await core.syncAll(), 0, 'only Shopify is on and there is no Shopify connection');
    process.env.PARTNER_WOOCOMMERCE_ENABLED = '1';
  });
});

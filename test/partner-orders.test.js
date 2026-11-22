'use strict';
/* Partner API Batch 2 — quotes and orders against a REAL, isolated PostgreSQL.
   Runs only when KINAN_TEST_PG=1 (local: database/role "kinan_test" on 127.0.0.1 with trust auth); skipped otherwise.
   Acceptance covered: identical retries across concurrency, two processes and a crash after COMMIT give one order,
   one reservation and one fulfilment intent; key/body change, expired quote, address mismatch, stock change and
   reused reference give the specified errors; 30% floor with fees and two ship-from origins; reservation timeout;
   store isolation; every HTTP answer checked against the OpenAPI contract. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { execFile } = require('child_process');

const RUN = process.env.KINAN_TEST_PG === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'porders-'));
process.env.DATA_DIR = DATA; process.env.PARTNER_ORDERS_ENABLED = '1'; process.env.PARTNER_RATE_PER_MIN = '100000'; process.env.NODE_ENV = 'test';
delete process.env.PARTNER_FEE_RATE;

test('partner orders (PostgreSQL)', { skip: !RUN && 'set KINAN_TEST_PG=1 with a local kinan_test database' }, async (t) => {
  const { Pool } = require('./support/minipg');
  const pool = Pool({ user: 'kinan_test', database: 'kinan_test', host: process.env.KINAN_TEST_PG_HOST || '127.0.0.1' });
  // fresh partner tables in the dedicated test database
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'partner', 'migrations', '001_partner_core.down.sql'), 'utf8').replace(/--.*$/gm, ''));
  const pgm = require('../src/partner/pg'); pgm.setPool(pool);
  const db = require('../src/db');
  const S = require('../src/partner/store'); const C = require('../src/partner/catalog'); const O = require('../src/partner/orders'); const P = require('../src/partner/pricing');
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'partner-api', 'openapi.json'), 'utf8'));
  const resolveRef = (r) => r.replace(/^#\//, '').split('/').reduce((o, k) => o[k], SPEC);
  function validate(schema, v, at = '$') {
    if (schema.$ref) return validate(resolveRef(schema.$ref), v, at);
    const types = schema.type ? [].concat(schema.type) : null;
    const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
    if (types && !types.some((ty) => ty === typeOf(v))) throw new Error(`${at}: expected ${types} got ${typeOf(v)}`);
    if (schema.const !== undefined && v !== schema.const) throw new Error(`${at}: const`);
    if (schema.enum && !schema.enum.includes(v)) throw new Error(`${at}: ${v} not in enum`);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of schema.required || []) if (!(k in v)) throw new Error(`${at}: missing ${k}`);
      for (const [k, val] of Object.entries(v)) { if (schema.properties?.[k]) validate(schema.properties[k], val, `${at}.${k}`); else if (schema.additionalProperties === false) throw new Error(`${at}: unexpected ${k}`); }
    }
    if (Array.isArray(v) && schema.items) v.forEach((x, i) => validate(schema.items, x, `${at}[${i}]`));
  }
  async function call(key, method, p, body, headers = {}) {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json();
    const rel = p.replace('/api/partner/v1', '').split('?')[0];
    const tpl = Object.keys(SPEC.paths).find((x) => new RegExp(`^${x.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(rel));
    const op = SPEC.paths[tpl][method.toLowerCase()]; const resp = op.responses[String(r.status)];
    assert.ok(resp, `${method} ${rel} ${r.status} documented`);
    const def = resp.$ref ? resolveRef(resp.$ref) : resp; const ct = Object.keys(def.content)[0];
    validate(def.content[ct].schema, json, `${method} ${rel}`);
    return { status: r.status, body: json, headers: r.headers };
  }

  const admin = db.users.insert({ email: 'owner@kinan.test', role: 'admin' });
  const org = S.createOrg({ name: 'Demo Retail' }, admin);
  const A = S.createStore(org.id, { name: 'Store A', markets: ['DE', 'GB'] }, admin); const kA = S.issueKey(A.id, {}, admin).key;
  const B = S.createStore(org.id, { name: 'Store B', markets: ['DE'] }, admin); const kB = S.issueKey(B.id, {}, admin).key;
  C.sync('sandbox', { force: true });
  const addr = (o = {}) => ({ recipient: 'Sandbox Recipient', line1: 'Example Street 1', city: 'Berlin', postal_code: '10115', country: 'DE', ...o });
  const quote = async (items, dest = { country: 'DE', postal_code: '10115' }, key = kA) => call(key, 'POST', '/api/partner/v1/quotes', { currency: 'EUR', destination: dest, items });
  const order = async (body, idem, key = kA) => call(key, 'POST', '/api/partner/v1/orders', body, idem ? { 'idempotency-key': idem } : {});
  const count = async (sql, p = []) => Number((await pool.query(sql, p)).rows[0].n);

  await t.test('quote: priced from the price list, 30% floor met, expiry, no internal costs', async () => {
    const r = await quote([{ variant_id: 'kv_sbx_basket_gray', quantity: 2 }, { variant_id: 'kv_sbx_lamp_white', quantity: 1 }]);
    assert.strictEqual(r.status, 201);
    const q = r.body; const T = q.totals;
    assert.strictEqual(T.payable_minor, T.items_ex_tax_minor + T.shipping_ex_tax_minor + T.duties_minor + T.handling_minor + T.tax_minor);
    assert.strictEqual(q.items[0].line_ex_tax_minor, q.items[0].unit_ex_tax_minor * q.items[0].quantity);
    const ttl = new Date(q.expires_at) - Date.now(); assert.ok(ttl > 13 * 60e3 && ttl <= 15 * 60e3);
    assert.ok(!JSON.stringify(q).includes('cost'), 'no cost in the answer');
    const row = (await pool.query('SELECT margin_bp FROM partner_quote WHERE id = $1', [q.quote_id])).rows[0];
    assert.ok(row.margin_bp >= 3000, `margin ${row.margin_bp} bp`);
  });

  await t.test('quote: two ship-from origins (DE warehouse + CN direct) and a fee rate still meet the target', async () => {
    process.env.PARTNER_FEE_RATE = '0.03';
    const r = await quote([{ variant_id: 'kv_sbx_mug_sand', quantity: 1 }, { variant_id: 'kv_sbx_headphones_black', quantity: 1 }]);
    delete process.env.PARTNER_FEE_RATE;
    assert.deepStrictEqual(r.body.fulfillment_estimate.ship_from.sort(), ['CN', 'DE']);
    assert.strictEqual(r.body.fulfillment_estimate.parcels, 2);
    assert.ok(r.body.totals.handling_minor > 0, 'import handling for the CN parcel');
    assert.ok((await pool.query('SELECT margin_bp FROM partner_quote WHERE id = $1', [r.body.quote_id])).rows[0].margin_bp >= 3000);
    assert.strictEqual(P.floorMinor(1625), 2322);
  });

  await t.test('quote validation', async () => {
    assert.strictEqual((await quote([{ variant_id: 'kv_sbx_basket_gray', quantity: 1 }], { country: 'DE', postal_code: 'ABC' })).body.errors[0].field, 'destination.postal_code');
    assert.strictEqual((await quote([{ variant_id: 'kv_sbx_basket_gray', quantity: 1 }], { country: 'FR', postal_code: '75001' })).body.code, 'UNSUPPORTED_DESTINATION');
    const oos = await quote([{ variant_id: 'kv_sbx_basket_beige', quantity: 1 }]); // stock 0 in the fixtures
    assert.strictEqual(oos.status, 422); assert.strictEqual(oos.body.errors[0].code, 'out_of_stock');
    assert.strictEqual((await quote([{ variant_id: 'kv_sbx_blanket_cream', quantity: 1 }], { country: 'GB', postal_code: 'SW1A 1AA' })).body.errors[0].code, 'not_available', 'blanket is DE only');
    assert.strictEqual((await quote([{ variant_id: 'kv_sbx_lamp_white', quantity: 0 }])).status, 400);
  });

  await t.test('order: created once; identical retry replays; changed body and reused reference are refused', async () => {
    const q = (await quote([{ variant_id: 'kv_sbx_charger_white', quantity: 2 }])).body;
    const body = { quote_id: q.quote_id, external_order_ref: 'STORE-1001', shipping_address: addr() };
    assert.strictEqual((await order(body, null)).body.errors[0].field, 'Idempotency-Key');
    const first = await order(body, 'demo-store-1001-create');
    assert.strictEqual(first.status, 201); assert.match(first.headers.get('location'), /\/orders\/po_/);
    assert.deepStrictEqual(first.body.status, { payment: 'pending', fulfillment: 'received' });
    const again = await order(body, 'demo-store-1001-create');
    assert.strictEqual(again.headers.get('idempotent-replayed'), 'true'); assert.strictEqual(again.body.order_id, first.body.order_id);
    assert.strictEqual((await order({ ...body, shipping_address: addr({ line1: 'Other Street 9' }) }, 'demo-store-1001-create')).body.code, 'IDEMPOTENCY_CONFLICT');
    assert.strictEqual((await order(body, 'demo-store-1001-retry-new-key')).body.code, 'ORDER_REFERENCE_CONFLICT');
    assert.strictEqual(await count("SELECT count(*) n FROM partner_order WHERE external_order_ref = 'STORE-1001'"), 1);
    const raw = (await pool.query('SELECT ship_to::text AS s FROM partner_order WHERE id = $1', [first.body.order_id])).rows[0].s;
    assert.ok(!raw.includes('Sandbox Recipient') && !raw.includes('Example Street'), 'recipient encrypted at rest');
    assert.strictEqual((await call(kA, 'GET', `/api/partner/v1/orders/${first.body.order_id}`)).body.ship_to.recipient, 'Sandbox Recipient');
    assert.strictEqual((await call(kB, 'GET', `/api/partner/v1/orders/${first.body.order_id}`)).status, 404, 'other store cannot see it');
  });

  await t.test('order: expired quote, address mismatch and stock taken in between', async () => {
    const q1 = (await quote([{ variant_id: 'kv_sbx_lamp_white', quantity: 1 }])).body;
    await pool.query("UPDATE partner_quote SET expires_at = now() - interval '1 second' WHERE id = $1", [q1.quote_id]);
    assert.strictEqual((await order({ quote_id: q1.quote_id, external_order_ref: 'X-EXP', shipping_address: addr() }, 'key-expired-0001')).body.code, 'QUOTE_EXPIRED');
    const q2 = (await quote([{ variant_id: 'kv_sbx_lamp_white', quantity: 1 }])).body;
    assert.strictEqual((await order({ quote_id: q2.quote_id, external_order_ref: 'X-MIS', shipping_address: addr({ postal_code: '10117' }) }, 'key-mismatch-0001')).body.code, 'QUOTE_MISMATCH');
    // headphones_silver has 3 in stock: two quotes for 3 each, the second order loses
    const qa = (await quote([{ variant_id: 'kv_sbx_headphones_silver', quantity: 3 }])).body; const qb = (await quote([{ variant_id: 'kv_sbx_headphones_silver', quantity: 3 }])).body;
    assert.strictEqual((await order({ quote_id: qa.quote_id, external_order_ref: 'X-S1', shipping_address: addr() }, 'key-stock-0001')).status, 201);
    assert.strictEqual((await order({ quote_id: qb.quote_id, external_order_ref: 'X-S2', shipping_address: addr() }, 'key-stock-0002')).body.code, 'STOCK_CHANGED');
    assert.strictEqual(await count("SELECT count(*) n FROM partner_order WHERE external_order_ref IN ('X-EXP','X-MIS','X-S2')"), 0, 'failed orders leave nothing behind');
    assert.strictEqual(await count("SELECT count(*) n FROM partner_idempotency WHERE key IN ('key-expired-0001','key-mismatch-0001','key-stock-0002')"), 0);
  });

  await t.test('30 concurrent identical requests in one process → one order and one reservation', async () => {
    const q = (await quote([{ variant_id: 'kv_sbx_bottle_green', quantity: 1 }])).body;
    const body = { quote_id: q.quote_id, external_order_ref: 'CONC-1', shipping_address: addr() };
    const res = await Promise.all(Array.from({ length: 30 }, () => order(body, 'conc-key-000001')));
    assert.ok(res.every((r) => r.status === 201)); assert.strictEqual(new Set(res.map((r) => r.body.order_id)).size, 1);
    assert.strictEqual(await count("SELECT count(*) n FROM partner_order WHERE external_order_ref = 'CONC-1'"), 1);
    assert.strictEqual(await count('SELECT count(*) n FROM partner_reservation WHERE order_id = $1', [res[0].body.order_id]), 1);
  });

  const runProc = (args) => new Promise((resolve) => execFile(process.execPath, [path.join(__dirname, 'support', 'partner-order-proc.js'), ...args], { env: { ...process.env } }, (err, out) => resolve({ code: err ? err.code : 0, out: String(out).trim() })));

  await t.test('two processes, 25 concurrent retries each → one order, one reservation, one fulfilment intent', async () => {
    const q = (await quote([{ variant_id: 'kv_sbx_organiser_clear', quantity: 2 }])).body;
    const body = JSON.stringify({ quote_id: q.quote_id, external_order_ref: 'PROC-1', shipping_address: addr() });
    const store = JSON.stringify(db.partner_stores.get(A.id));
    const [p1, p2] = await Promise.all([runProc([DATA, store, 'proc-key-000001', body, '25']), runProc([DATA, store, 'proc-key-000001', body, '25'])]);
    const all = [...JSON.parse(p1.out), ...JSON.parse(p2.out)];
    assert.strictEqual(all.length, 50); assert.ok(all.every((x) => x.ok === 201), JSON.stringify(all.filter((x) => !x.ok)));
    assert.strictEqual(new Set(all.map((x) => x.id)).size, 1);
    assert.strictEqual(all.filter((x) => !x.replayed).length, 1, 'exactly one request created it');
    const id = all[0].id;
    assert.strictEqual(await count('SELECT count(*) n FROM partner_reservation WHERE order_id = $1', [id]), 1);
    await O.settle(id, { actor: 'test' });
    await Promise.all([O.fulfilmentWorker('sandbox'), O.fulfilmentWorker('sandbox'), O.fulfilmentWorker('sandbox')]);
    assert.strictEqual(await count('SELECT count(*) n FROM partner_fulfillment_intent WHERE order_id = $1', [id]), 1);
    const o = await call(kA, 'GET', `/api/partner/v1/orders/${id}`);
    assert.deepStrictEqual(o.body.status, { payment: 'settled', fulfillment: 'confirmed' }); assert.strictEqual(o.body.version, 3);
    assert.strictEqual(await count('SELECT count(*) n FROM partner_outbox WHERE resource_id = $1', [id]), 3, 'created, settled, confirmed');
    await assert.rejects(O.settle(id), /already settled/);
  });

  await t.test('crash right after COMMIT: the retry returns the stored order, nothing is duplicated', async () => {
    const q = (await quote([{ variant_id: 'kv_sbx_cushion_sage', quantity: 1 }])).body;
    const body = { quote_id: q.quote_id, external_order_ref: 'CRASH-1', shipping_address: addr() };
    const r = await runProc([DATA, JSON.stringify(db.partner_stores.get(A.id)), 'crash-key-000001', JSON.stringify(body), '1', 'crash']);
    assert.strictEqual(r.code, 3); assert.match(r.out, /crashed/);
    const retry = await order(body, 'crash-key-000001');
    assert.strictEqual(retry.status, 201); assert.strictEqual(retry.headers.get('idempotent-replayed'), 'true');
    assert.strictEqual(await count("SELECT count(*) n FROM partner_order WHERE external_order_ref = 'CRASH-1'"), 1);
  });

  await t.test('unpaid orders release their reservation after the window and are cancelled', async () => {
    const q = (await quote([{ variant_id: 'kv_sbx_tote_natural', quantity: 4 }])).body;
    const o = (await order({ quote_id: q.quote_id, external_order_ref: 'SWEEP-1', shipping_address: addr() }, 'sweep-key-00001')).body;
    const before = (await pool.query("SELECT reserved FROM partner_stock WHERE env = 'sandbox' AND variant_id = 'kv_sbx_tote_natural'")).rows[0].reserved;
    await pool.query("UPDATE partner_reservation SET expires_at = now() - interval '1 minute' WHERE order_id = $1", [o.order_id]);
    assert.strictEqual(await O.sweepExpired('sandbox'), 1);
    const after = (await pool.query("SELECT reserved FROM partner_stock WHERE env = 'sandbox' AND variant_id = 'kv_sbx_tote_natural'")).rows[0].reserved;
    assert.strictEqual(before - after, 4);
    assert.strictEqual((await call(kA, 'GET', `/api/partner/v1/orders/${o.order_id}`)).body.status.fulfillment, 'cancelled');
    assert.strictEqual(await O.sweepExpired('sandbox'), 0, 'idempotent');
  });

  await t.test('order list: paging, reference filter, scope', async () => {
    const p1 = await call(kA, 'GET', '/api/partner/v1/orders?limit=2');
    assert.strictEqual(p1.body.data.length, 2); assert.ok(p1.body.next_cursor);
    const p2 = await call(kA, 'GET', `/api/partner/v1/orders?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
    assert.ok(!p2.body.data.some((x) => p1.body.data.some((y) => y.order_id === x.order_id)));
    assert.strictEqual((await call(kA, 'GET', '/api/partner/v1/orders?external_order_ref=STORE-1001')).body.data.length, 1);
    assert.strictEqual((await call(kB, 'GET', '/api/partner/v1/orders')).body.data.length, 0);
    const ro = S.issueKey(A.id, { scopes: ['catalog:read'] }, admin).key;
    assert.strictEqual((await call(ro, 'POST', '/api/partner/v1/quotes', { currency: 'EUR', destination: { country: 'DE', postal_code: '10115' }, items: [{ variant_id: 'kv_sbx_lamp_white', quantity: 1 }] })).body.code, 'INSUFFICIENT_SCOPE');
  });

  await t.test('ordering switch off → 503, catalogue keeps working', async () => {
    process.env.PARTNER_ORDERS_ENABLED = '0';
    assert.strictEqual((await quote([{ variant_id: 'kv_sbx_lamp_white', quantity: 1 }])).body.code, 'TEMPORARILY_UNAVAILABLE');
    assert.strictEqual((await fetch(`${base}/api/partner/v1/catalog/products?market=DE`, { headers: { authorization: `Bearer ${kA}` } })).status, 200);
    process.env.PARTNER_ORDERS_ENABLED = '1';
  });
});

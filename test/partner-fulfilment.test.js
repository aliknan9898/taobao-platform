'use strict';
/* Partner API Batch 3 — fulfilment, shipments, cancellations, returns, documents and webhooks against a REAL,
   isolated PostgreSQL. Runs only when KINAN_TEST_PG=1 (same local "kinan_test" database as partner-orders; run the two
   files one after the other: node --test --test-concurrency=1 …). Every HTTP answer is checked against the OpenAPI
   contract. Webhook deliveries go to a local HTTP receiver through an injected transport; the production transport
   (HTTPS pinned to a checked public address) is covered by the address-guard tests. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path'); const http = require('http');

const RUN = process.env.KINAN_TEST_PG === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pfulfil-'));
process.env.DATA_DIR = DATA; process.env.PARTNER_ORDERS_ENABLED = '1'; process.env.PARTNER_RATE_PER_MIN = '100000'; process.env.NODE_ENV = 'test';
delete process.env.PARTNER_FEE_RATE;

test('address guard for webhook URLs (no database needed)', async () => {
  const W = require('../src/partner/webhooks');
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '172.16.5.5', '192.168.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:a00:1', '64:ff9b::10.0.0.1', '2001:db8::1']) assert.strictEqual(W.isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8']) assert.strictEqual(W.isPublicAddress(ip), true, ip);
  const code = (u) => { try { W.checkUrl(u); return 'ok'; } catch (e) { return e.extra.errors[0].code; } };
  assert.strictEqual(code('http://hooks.example.com/x'), 'https_required');
  assert.strictEqual(code('https://user:pw@hooks.example.com/x'), 'credentials_not_allowed');
  assert.strictEqual(code('https://localhost/x'), 'private_address');
  assert.strictEqual(code('https://[::1]/x'), 'private_address');
  assert.strictEqual(code('https://10.1.1.1/x'), 'private_address');
  assert.strictEqual(code('https://printer.local/x'), 'private_address');
  assert.strictEqual(code('https://hooks.example.com/kinan?x=1'), 'ok');
  const sig = W.sign('whsec_test', '{"a":1}', 1700000000);
  assert.ok(W.verifySignature('whsec_test', '{"a":1}', sig, 300, 1700000100));
  assert.ok(!W.verifySignature('whsec_test', '{"a":2}', sig, 300, 1700000100), 'body changed');
  assert.ok(!W.verifySignature('whsec_other', '{"a":1}', sig, 300, 1700000100), 'other secret');
  assert.ok(!W.verifySignature('whsec_test', '{"a":1}', sig, 300, 1700000400), 'too old');
  const b = [1, 2, 3, 8, 20].map((n) => W._backoffMs(n));
  {
    // the real HTTPS sender re-checks DNS on every delivery: a host that now resolves privately is never contacted
    W.setLookup(async () => ['169.254.169.254']);
    await assert.rejects(W._httpsPost('https://rebind.example.com/hook', {}, '{}'), /private address/);
    W.setLookup(async () => ['93.184.216.34', '10.0.0.1']);
    await assert.rejects(W.resolvePublic('mixed.example.com'), /private address/);
    W.setLookup(async () => ['93.184.216.34']);
    assert.strictEqual(await W.resolvePublic('hooks.example.com'), '93.184.216.34');
  }
  assert.ok(b[0] >= 24e3 && b[0] <= 36e3 && b[3] > b[2] && b[4] <= 3600e3 * 1.2, `backoff ${b}`);
});

test('partner fulfilment (PostgreSQL)', { skip: !RUN && 'set KINAN_TEST_PG=1 with a local kinan_test database' }, async (t) => {
  const { Pool } = require('./support/minipg');
  const H = require('./support/partner-harness');
  const pool = Pool({ user: 'kinan_test', database: 'kinan_test', host: process.env.KINAN_TEST_PG_HOST || '127.0.0.1' });
  await H.resetPartnerSchema(pool);
  const pgm = require('../src/partner/pg'); pgm.setPool(pool);
  const db = require('../src/db');
  const S = require('../src/partner/store'); const C = require('../src/partner/catalog'); const O = require('../src/partner/orders');
  const F = require('../src/partner/fulfilment'); const W = require('../src/partner/webhooks');
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = H.client(base);

  // local webhook receiver; the transport sends there whatever the registered https URL is
  const hits = []; let mode = 'ok'; let lastChallenge = null;
  const rx = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const ev = JSON.parse(b); hits.push({ headers: req.headers, raw: b, ev });
      if (ev.type === 'endpoint.verification') { lastChallenge = ev.data.challenge; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ challenge: mode === 'wrong' ? 'nope' : ev.data.challenge })); }
      if (mode === 'fail') { res.writeHead(500); return res.end('down'); }
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return res.end(); }
      res.writeHead(204); res.end();
    });
  });
  await new Promise((r) => rx.listen(0, r)); const rxPort = rx.address().port;
  t.after(() => { server.close(); rx.close(); W.setTransport(null); });
  W.setLookup(async (host) => (host === 'evil.example.com' ? ['10.0.0.5'] : host === 'mixed.example.com' ? ['93.184.216.34', '127.0.0.1'] : ['93.184.216.34']));
  W.setTransport((url, headers, body) => new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port: rxPort, method: 'POST', path: u.pathname + u.search, headers: { ...headers, 'x-original-host': u.hostname } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', (e) => resolve({ error: e.message })); req.end(body);
  }));

  const admin = db.users.insert({ email: 'owner@kinan.test', role: 'admin' });
  const org = S.createOrg({ name: 'Demo Retail' }, admin);
  const A = S.createStore(org.id, { name: 'Store A', markets: ['DE', 'GB'] }, admin); const kA = S.issueKey(A.id, {}, admin).key;
  const B = S.createStore(org.id, { name: 'Store B', markets: ['DE'] }, admin); const kB = S.issueKey(B.id, {}, admin).key;
  C.sync('sandbox', { force: true });
  const V = '/api/partner/v1';
  const addr = (o = {}) => ({ recipient: 'Sandbox Recipient', line1: 'Example Street 1', city: 'Berlin', postal_code: '10115', country: 'DE', ...o });
  let seq = 0;
  async function place(items, key = kA) {
    const q = await call(key, 'POST', `${V}/quotes`, { currency: 'EUR', destination: { country: 'DE', postal_code: '10115' }, items });
    assert.strictEqual(q.status, 201, JSON.stringify(q.body));
    seq += 1; const o = await call(key, 'POST', `${V}/orders`, { quote_id: q.body.quote_id, external_order_ref: `F3-${seq}`, shipping_address: addr() }, { 'idempotency-key': `f3-order-${seq}-key` });
    assert.strictEqual(o.status, 201); return o.body;
  }
  const getO = async (id, key = kA) => (await call(key, 'GET', `${V}/orders/${id}`)).body;
  const sim = (id, action, extra = {}, key = kA) => call(key, 'POST', `${V}/sandbox/orders/${id}/simulate`, { action, ...extra });
  const stock = async (v) => (await pool.query("SELECT on_hand, reserved FROM partner_stock WHERE env = 'sandbox' AND variant_id = $1", [v])).rows[0];
  const n = async (sql, p = []) => Number((await pool.query(sql, p)).rows[0].n);
  const cancel = (id, body, key, k = kA) => call(k, 'POST', `${V}/orders/${id}/cancellations`, body, key ? { 'idempotency-key': key } : {});
  const ret = (id, body, key, k = kA) => call(k, 'POST', `${V}/orders/${id}/returns`, body, key ? { 'idempotency-key': key } : {});

  await t.test('migrations: 002 applied on top of 001, additive', async () => {
    assert.deepStrictEqual(pgm.migrations(), ['001_partner_core.sql', '002_partner_fulfilment.sql']);
    await pgm.ensureSchema();
    assert.strictEqual(await n('SELECT count(*) n FROM partner_schema WHERE version IN (1,2)'), 2);
  });

  let two; // a DE + CN order used across the shipping tests
  await t.test('handoff: paid orders reach the (sandbox) supplier exactly once, even with three workers', async () => {
    two = await place([{ variant_id: 'kv_sbx_mug_sand', quantity: 2 }, { variant_id: 'kv_sbx_charger_white', quantity: 1 }]);
    await O.settle(two.order_id, { actor: 'test' });
    assert.strictEqual((await getO(two.order_id)).status.fulfillment, 'confirmed');
    await Promise.all([F.handoffWorker('sandbox'), F.handoffWorker('sandbox'), F.handoffWorker('sandbox')]);
    const o = await getO(two.order_id);
    assert.strictEqual(o.status.fulfillment, 'processing');
    const ref = F.handoffRef(two.order_id);
    assert.strictEqual(F.sandboxAdapter.submitted.get(ref).n, 1, 'one submission');
    assert.strictEqual((await pool.query('SELECT state, handoff_ref FROM partner_fulfillment_intent WHERE order_id = $1', [two.order_id])).rows[0].state, 'submitted');
    assert.deepStrictEqual((await F.handoffWorker('sandbox')).handed_off, 0, 'nothing left');
    assert.deepStrictEqual(await F.handoffWorker('live'), { handed_off: 0, skipped: 'no_adapter' }, 'no live handoff without an adapter');
  });

  await t.test('handoff failure is retried later and recorded', async () => {
    const o = await place([{ variant_id: 'kv_sbx_tote_natural', quantity: 1 }]);
    await O.settle(o.order_id);
    F.setAdapter('sandbox', { name: 'sandbox', async submit() { throw new Error('supplier timeout'); } });
    await F.handoffWorker('sandbox');
    F.setAdapter('sandbox', F.sandboxAdapter);
    const i = (await pool.query('SELECT state, attempts, last_error FROM partner_fulfillment_intent WHERE order_id = $1', [o.order_id])).rows[0];
    assert.deepStrictEqual([i.state, i.attempts, i.last_error], ['pending', 1, 'supplier timeout']);
    assert.strictEqual((await F.handoffWorker('sandbox')).handed_off, 0, 'lease: not retried within 2 minutes');
    await pool.query("UPDATE partner_fulfillment_intent SET updated_at = now() - interval '3 minutes' WHERE order_id = $1", [o.order_id]);
    assert.strictEqual((await F.handoffWorker('sandbox')).handed_off, 1);
    assert.strictEqual((await getO(o.order_id)).status.fulfillment, 'processing');
  });

  await t.test('shipments: one per origin, partial then full, reservations committed, delivery closes the order', async () => {
    const before = await stock('kv_sbx_charger_white');
    const s1 = await sim(two.order_id, 'ship', { ship_from: 'CN' });
    assert.strictEqual(s1.status, 200); assert.strictEqual(s1.body.status.fulfillment, 'partially_shipped');
    const after = await stock('kv_sbx_charger_white');
    assert.deepStrictEqual([before.on_hand - after.on_hand, before.reserved - after.reserved], [1, 1], 'CN reservation committed');
    assert.strictEqual((await stock('kv_sbx_mug_sand')).reserved, 2, 'DE still reserved');
    let sh = (await call(kA, 'GET', `${V}/orders/${two.order_id}/shipments`)).body.data;
    assert.strictEqual(sh.length, 1); assert.strictEqual(sh[0].ship_from, 'CN'); assert.match(sh[0].tracking_number, /^SBX\d+CN$/);
    assert.deepStrictEqual(sh[0].items, [{ variant_id: 'kv_sbx_charger_white', quantity: 1 }]);
    assert.strictEqual((await sim(two.order_id, 'ship', { ship_from: 'CN' })).body.code, 'INVALID_STATE', 'CN already shipped');
    assert.strictEqual((await sim(two.order_id, 'ship')).body.status.fulfillment, 'shipped');
    assert.strictEqual((await sim(two.order_id, 'deliver', { ship_from: 'DE' })).body.status.fulfillment, 'shipped', 'one parcel still travelling');
    assert.strictEqual((await sim(two.order_id, 'exception', { ship_from: 'CN' })).body.status.fulfillment, 'exception');
    assert.strictEqual((await sim(two.order_id, 'deliver')).body.status.fulfillment, 'delivered');
    sh = (await call(kA, 'GET', `${V}/orders/${two.order_id}/shipments`)).body.data;
    assert.ok(sh.every((s) => s.state === 'delivered' && s.delivered_at));
    assert.deepStrictEqual(sh.find((s) => s.ship_from === 'CN').events.map((e) => e.state), ['label_created', 'in_transit', 'exception', 'delivered']);
    assert.strictEqual((await call(kB, 'GET', `${V}/orders/${two.order_id}/shipments`)).status, 404, 'other store');
    assert.strictEqual(await n("SELECT count(*) n FROM partner_reservation WHERE order_id = $1 AND state = 'committed'", [two.order_id]), 2);
  });

  await t.test('cancellation before payment: accepted at once, reservation released, idempotent', async () => {
    const o = await place([{ variant_id: 'kv_sbx_backpack_navy', quantity: 2 }]);
    const r0 = await stock('kv_sbx_backpack_navy');
    assert.strictEqual((await cancel(o.order_id, { reason_code: 'customer_request' })).body.errors[0].field, 'Idempotency-Key');
    assert.strictEqual((await cancel(o.order_id, { reason_code: 'bored' }, 'cancel-key-0001')).status, 400);
    const c1 = await cancel(o.order_id, { reason_code: 'customer_request', note: 'Customer changed their mind' }, 'cancel-key-0001');
    assert.strictEqual(c1.status, 201); assert.strictEqual(c1.body.state, 'accepted');
    const again = await cancel(o.order_id, { reason_code: 'customer_request', note: 'Customer changed their mind' }, 'cancel-key-0001');
    assert.strictEqual(again.headers.get('idempotent-replayed'), 'true'); assert.strictEqual(again.body.cancellation_id, c1.body.cancellation_id);
    assert.strictEqual((await cancel(o.order_id, { reason_code: 'other' }, 'cancel-key-0001')).body.code, 'IDEMPOTENCY_CONFLICT');
    assert.strictEqual((await cancel(o.order_id, { reason_code: 'other' }, 'cancel-key-0002')).body.code, 'ORDER_NOT_CANCELLABLE');
    assert.deepStrictEqual((await getO(o.order_id)).status, { payment: 'pending', fulfillment: 'cancelled' });
    assert.strictEqual(r0.reserved - (await stock('kv_sbx_backpack_navy')).reserved, 2);
    await assert.rejects(O.settle(o.order_id).then(() => O.fulfilmentWorker('sandbox')).then(async () => { if ((await getO(o.order_id)).status.fulfillment !== 'cancelled') throw new Error('revived'); throw new Error('settled'); }), /settled|already/);
  });

  await t.test('cancellation after payment, before handoff: payment credited; credit note offered', async () => {
    const o = await place([{ variant_id: 'kv_sbx_cushion_sage', quantity: 1 }]);
    await O.settle(o.order_id);
    const c = await cancel(o.order_id, { reason_code: 'duplicate_order' }, 'cancel-paid-0001');
    assert.strictEqual(c.body.state, 'accepted');
    assert.deepStrictEqual((await getO(o.order_id)).status, { payment: 'credited', fulfillment: 'cancelled' });
    assert.strictEqual((await F.handoffWorker('sandbox')).handed_off, 0, 'never handed off');
    const docs = (await call(kA, 'GET', `${V}/orders/${o.order_id}/documents`)).body.data.map((d) => d.document_id);
    assert.deepStrictEqual(docs, ['proforma', 'credit_cancellation']);
  });

  await t.test('cancellation after handoff: KINAN decides; reject lets it ship, accept withdraws it at the supplier', async () => {
    const o1 = await place([{ variant_id: 'kv_sbx_lamp_white', quantity: 1 }]);
    await O.settle(o1.order_id); await F.handoffWorker('sandbox');
    const c = await cancel(o1.order_id, { reason_code: 'address_issue' }, 'cancel-late-0001');
    assert.strictEqual(c.body.state, 'requested');
    assert.strictEqual((await cancel(o1.order_id, { reason_code: 'other' }, 'cancel-late-0002')).body.code, 'CANCELLATION_PENDING');
    assert.strictEqual((await sim(o1.order_id, 'ship')).body.code, 'INVALID_STATE', 'no shipping while a cancellation is undecided');
    assert.strictEqual((await sim(o1.order_id, 'reject_cancellation')).body.status.fulfillment, 'processing');
    assert.strictEqual((await call(kA, 'GET', `${V}/orders/${o1.order_id}/cancellations`)).body.data[0].state, 'rejected');
    assert.strictEqual((await sim(o1.order_id, 'ship')).body.status.fulfillment, 'shipped');
    assert.strictEqual((await cancel(o1.order_id, { reason_code: 'other' }, 'cancel-late-0003')).body.code, 'ORDER_NOT_CANCELLABLE', 'shipped');

    const o2 = await place([{ variant_id: 'kv_sbx_organiser_clear', quantity: 3 }]);
    const r0 = await stock('kv_sbx_organiser_clear');
    await O.settle(o2.order_id); await F.handoffWorker('sandbox');
    const c2 = await cancel(o2.order_id, { reason_code: 'customer_request' }, 'cancel-late-0004');
    const k = await F.decideCancellation(c2.body.cancellation_id, { accept: true, actor: 'test' });
    assert.strictEqual(k.state, 'accepted');
    assert.deepStrictEqual((await getO(o2.order_id)).status, { payment: 'credited', fulfillment: 'cancelled' });
    assert.ok(F.sandboxAdapter.cancelled.has(F.handoffRef(o2.order_id)), 'withdrawn at the supplier');
    assert.strictEqual(r0.reserved - (await stock('kv_sbx_organiser_clear')).reserved, 3, 'released');
    await assert.rejects(F.decideCancellation(c2.body.cancellation_id, { accept: false }), /already accepted/);
  });

  await t.test('returns: only delivered items, within the window, up to what is left; approve → receive → credit', async () => {
    const o = await place([{ variant_id: 'kv_sbx_bottle_green', quantity: 3 }]);
    const body = { reason_code: 'damaged', items: [{ variant_id: 'kv_sbx_bottle_green', quantity: 1 }] };
    assert.strictEqual((await ret(o.order_id, body, 'ret-early-0001')).body.code, 'RETURN_NOT_ALLOWED', 'not delivered');
    await O.settle(o.order_id); await F.handoffWorker('sandbox'); await sim(o.order_id, 'ship'); await sim(o.order_id, 'deliver');
    const tooMany = await ret(o.order_id, { reason_code: 'damaged', items: [{ variant_id: 'kv_sbx_bottle_green', quantity: 4 }] }, 'ret-many-0001');
    assert.strictEqual(tooMany.body.code, 'RETURN_NOT_ALLOWED'); assert.strictEqual(tooMany.body.errors[0].code, 'quantity_exceeds_returnable');
    assert.strictEqual((await ret(o.order_id, { reason_code: 'damaged', items: [{ variant_id: 'kv_sbx_lamp_white', quantity: 1 }] }, 'ret-other-0001')).body.errors[0].code, 'not_returnable');
    const r1 = await ret(o.order_id, body, 'ret-ok-0001');
    assert.strictEqual(r1.status, 201); assert.strictEqual(r1.body.state, 'requested'); assert.match(r1.body.rma_number, /^RMA-[0-9A-F]{10}$/);
    const unit = (await getO(o.order_id)).items[0].unit_ex_tax_minor;
    assert.strictEqual(r1.body.credit_minor, unit);
    assert.strictEqual((await ret(o.order_id, body, 'ret-ok-0001')).headers.get('idempotent-replayed'), 'true');
    assert.strictEqual((await ret(o.order_id, { reason_code: 'defective', items: [{ variant_id: 'kv_sbx_bottle_green', quantity: 2 }] }, 'ret-ok-0002')).status, 201);
    assert.strictEqual((await ret(o.order_id, body, 'ret-ok-0003')).body.errors[0].detail, 'Returnable now: 0');
    assert.strictEqual((await sim(o.order_id, 'credit_return')).body.code, 'INVALID_STATE', 'credit needs received');
    await sim(o.order_id, 'approve_return');
    const approved = (await call(kA, 'GET', `${V}/orders/${o.order_id}/returns`)).body.data[0];
    assert.strictEqual(approved.state, 'approved'); assert.strictEqual(approved.instructions.reference, approved.rma_number); assert.strictEqual(approved.instructions.return_to.country, 'DE');
    await sim(o.order_id, 'receive_return');
    assert.strictEqual((await sim(o.order_id, 'credit_return')).body.status.payment, 'partially_credited');
    const second = (await call(kA, 'GET', `${V}/orders/${o.order_id}/returns`)).body.data[1];
    await F.decideReturn(second.return_id, { action: 'approve' }); await F.decideReturn(second.return_id, { action: 'receive' });
    await F.decideReturn(second.return_id, { action: 'credit' });
    assert.strictEqual((await getO(o.order_id)).status.payment, 'credited', 'everything returned');
    assert.strictEqual((await call(kA, 'GET', `${V}/orders/${o.order_id}/documents`)).body.data.filter((d) => d.type === 'credit_note').length, 2);
    // reject path and the 30-day window
    const o2 = await place([{ variant_id: 'kv_sbx_mug_black', quantity: 1 }]);
    await O.settle(o2.order_id); await F.handoffWorker('sandbox'); await sim(o2.order_id, 'ship'); await sim(o2.order_id, 'deliver');
    const rr = await ret(o2.order_id, { reason_code: 'no_longer_needed', items: [{ variant_id: 'kv_sbx_mug_black', quantity: 1 }] }, 'ret-rej-0001');
    assert.strictEqual((await F.decideReturn(rr.body.return_id, { action: 'reject', reason: 'used item' })).state, 'rejected');
    await pool.query("UPDATE partner_shipment SET delivered_at = now() - interval '31 days' WHERE order_id = $1", [o2.order_id]);
    assert.strictEqual((await ret(o2.order_id, { reason_code: 'no_longer_needed', items: [{ variant_id: 'kv_sbx_mug_black', quantity: 1 }] }, 'ret-late-0001')).body.errors[0].code, 'not_returnable', 'window passed');
    assert.strictEqual((await ret(o2.order_id, body, 'ret-iso-0001', kB)).status, 404, 'other store');
  });

  await t.test('documents: PDFs, packing slip after handoff only, recipient only on the slip, live refused', async () => {
    const o = await place([{ variant_id: 'kv_sbx_basket_gray', quantity: 2 }]);
    const list0 = (await call(kA, 'GET', `${V}/orders/${o.order_id}/documents`)).body;
    assert.deepStrictEqual(list0.data.map((d) => d.document_id), ['proforma']); assert.strictEqual(list0.sandbox, true);
    const pf = await call(kA, 'GET', `${V}/orders/${o.order_id}/documents/proforma`);
    assert.strictEqual(pf.status, 200); assert.strictEqual(pf.raw.subarray(0, 5).toString(), '%PDF-');
    assert.match(pf.headers.get('content-disposition'), /KINAN-proforma-po_/);
    assert.strictEqual((await call(kA, 'GET', `${V}/orders/${o.order_id}/documents/packing_slip`)).status, 404, 'not yet');
    await O.settle(o.order_id); await F.handoffWorker('sandbox');
    assert.strictEqual((await call(kA, 'GET', `${V}/orders/${o.order_id}/documents/packing_slip`)).status, 200);
    assert.strictEqual((await call(kB, 'GET', `${V}/orders/${o.order_id}/documents/proforma`)).status, 404);
    const D = require('../src/partner/documents');
    await assert.rejects(D.list({ env: 'live', store: db.partner_stores.get(A.id) }, o.order_id), (e) => e.status === 503);
  });

  let ep; let secret;
  await t.test('webhook endpoints: https + public address only, signed challenge before anything is sent', async () => {
    const bad = async (url) => (await call(kA, 'POST', `${V}/webhook-endpoints`, { url })).body.errors?.[0]?.code;
    assert.strictEqual(await bad('http://hooks.example.com/kinan'), 'https_required');
    assert.strictEqual(await bad('https://evil.example.com/kinan'), 'private_address', 'DNS → 10.0.0.5');
    assert.strictEqual(await bad('https://mixed.example.com/kinan'), 'private_address', 'one private answer is enough to refuse');
    assert.strictEqual((await call(kA, 'POST', `${V}/webhook-endpoints`, { url: 'https://hooks.example.com/kinan', events: ['order.paid'] })).status, 400);
    const r = await call(kA, 'POST', `${V}/webhook-endpoints`, { url: 'https://hooks.example.com/kinan' });
    assert.strictEqual(r.status, 201); assert.match(r.body.secret, /^whsec_[A-Za-z0-9]{32}$/); assert.strictEqual(r.body.state, 'pending_verification');
    ep = r.body.endpoint_id; secret = r.body.secret;
    const raw = (await pool.query('SELECT secret::text AS s FROM partner_webhook_endpoint WHERE id = $1', [ep])).rows[0].s;
    assert.ok(!raw.includes(secret), 'secret encrypted at rest');
    assert.ok(!JSON.stringify((await call(kA, 'GET', `${V}/webhook-endpoints`)).body).includes('whsec_'), 'never shown again');
    await sim(two.order_id, 'deliver').catch(() => {}); // any event while unverified
    await O.fulfilmentWorker('sandbox');
    await W.dispatch('sandbox');
    assert.strictEqual(await n('SELECT count(*) n FROM partner_webhook_delivery WHERE endpoint_id = $1', [ep]), 0, 'unverified endpoints get nothing');
    mode = 'wrong';
    assert.strictEqual((await call(kA, 'POST', `${V}/webhook-endpoints/${ep}/verify`)).body.code, 'ENDPOINT_VERIFICATION_FAILED');
    mode = 'ok';
    const v = await call(kA, 'POST', `${V}/webhook-endpoints/${ep}/verify`);
    assert.strictEqual(v.status, 200); assert.strictEqual(v.body.state, 'active');
    const h = hits[hits.length - 1];
    assert.ok(W.verifySignature(secret, h.raw, h.headers['kinan-signature']), 'challenge is signed'); assert.ok(lastChallenge);
    assert.strictEqual((await call(kB, 'POST', `${V}/webhook-endpoints/${ep}/verify`)).status, 404, 'other store');
    assert.strictEqual((await call(kB, 'GET', `${V}/webhook-endpoints`)).body.data.length, 0);
  });

  await t.test('webhooks: signed events, no recipient data, exactly one delivery per event with three dispatchers', async () => {
    hits.length = 0;
    const o = await place([{ variant_id: 'kv_sbx_lamp_white', quantity: 1 }]);
    await O.settle(o.order_id); await F.handoffWorker('sandbox'); await sim(o.order_id, 'ship');
    await W.fanOut('sandbox');
    await Promise.all([W.deliverDue('sandbox'), W.deliverDue('sandbox'), W.deliverDue('sandbox')]);
    const mine = hits.filter((x) => x.ev.data.order_id === o.order_id);
    const types = mine.map((x) => x.ev.type);
    assert.ok(types.includes('order.updated') && types.includes('shipment.updated'), types.join());
    assert.strictEqual(new Set(mine.map((x) => x.ev.id)).size, mine.length, 'no event delivered twice');
    for (const x of mine) {
      assert.ok(W.verifySignature(secret, x.raw, x.headers['kinan-signature']));
      assert.strictEqual(x.headers['kinan-event-id'], x.ev.id); assert.strictEqual(x.headers['kinan-event-type'], x.ev.type);
      assert.ok(!/Sandbox Recipient|Example Street/.test(x.raw), 'no recipient data');
      H.validate(H.SPEC.components.schemas.WebhookEvent, x.ev);
      if (x.ev.type === 'shipment.updated') H.validate(H.SPEC.components.schemas.Shipment, x.ev.data);
    }
    const versions = mine.filter((x) => x.ev.type === 'order.updated').map((x) => x.ev.data.version);
    assert.deepStrictEqual([...versions].sort((a, b) => a - b), [1, 2, 3, 4, 5], 'created, settled, confirmed, processing, shipped');
    const dl = (await call(kA, 'GET', `${V}/webhook-endpoints/${ep}/deliveries?state=delivered&limit=100`)).body.data;
    assert.ok(dl.length >= mine.length && dl.every((d) => d.state === 'delivered' && d.attempts === 1));
  });

  await t.test('webhooks: failures back off, redirects are failures, 24 h → dead, replay with the same event id', async () => {
    hits.length = 0; mode = 'fail';
    const o = await place([{ variant_id: 'kv_sbx_tote_natural', quantity: 1 }]);
    await W.dispatch('sandbox');
    const d = (await pool.query("SELECT d.* FROM partner_webhook_delivery d JOIN partner_outbox o ON o.id = d.outbox_id WHERE o.resource_id = $1", [o.order_id])).rows[0];
    assert.strictEqual(d.state, 'pending'); assert.strictEqual(d.attempts, 1); assert.strictEqual(d.last_status, 500);
    assert.ok(new Date(d.next_attempt_at) > Date.now() + 20e3, 'backed off');
    assert.strictEqual((await W.deliverDue('sandbox')).failed, 0, 'not due yet');
    mode = 'redirect';
    await pool.query('UPDATE partner_webhook_delivery SET next_attempt_at = now() WHERE id = $1', [d.id]);
    await W.deliverDue('sandbox');
    assert.strictEqual((await pool.query('SELECT last_status FROM partner_webhook_delivery WHERE id = $1', [d.id])).rows[0].last_status, 302, 'redirect not followed');
    mode = 'fail';
    await pool.query("UPDATE partner_webhook_delivery SET next_attempt_at = now(), window_started_at = now() - interval '25 hours' WHERE id = $1", [d.id]);
    assert.strictEqual((await W.deliverDue('sandbox')).dead, 1);
    const dead = (await call(kA, 'GET', `${V}/webhook-endpoints/${ep}/deliveries?state=dead`)).body.data;
    assert.strictEqual(dead[0].event_id, d.event_id);
    mode = 'ok';
    const rp = await call(kA, 'POST', `${V}/webhook-endpoints/${ep}/replay`, { event_id: d.event_id });
    assert.strictEqual(rp.status, 200);
    assert.strictEqual((await W.deliverDue('sandbox')).delivered, 1);
    assert.strictEqual(hits.filter((x) => x.ev.id === d.event_id && x.headers['kinan-delivery-attempt']).pop().ev.id, d.event_id, 'same event id');
    assert.strictEqual((await call(kA, 'POST', `${V}/webhook-endpoints/${ep}/replay`, { event_id: 'evt_doesnotexist0' })).status, 404);
    assert.strictEqual((await pool.query('SELECT consecutive_failures FROM partner_webhook_endpoint WHERE id = $1', [ep])).rows[0].consecutive_failures, 0, 'reset on success');
  });

  await t.test('webhooks: an endpoint failing again and again is disabled; delete stops deliveries', async () => {
    mode = 'fail';
    await pool.query('UPDATE partner_webhook_endpoint SET consecutive_failures = 49 WHERE id = $1', [ep]);
    await place([{ variant_id: 'kv_sbx_tote_natural', quantity: 1 }]);
    await W.dispatch('sandbox');
    const e = (await call(kA, 'GET', `${V}/webhook-endpoints`)).body.data.find((x) => x.endpoint_id === ep);
    assert.deepStrictEqual([e.state, e.disabled_reason], ['disabled', 'too_many_failures']);
    assert.strictEqual(await n("SELECT count(*) n FROM partner_webhook_delivery WHERE endpoint_id = $1 AND state = 'pending'", [ep]), 0);
    mode = 'ok';
    const r = await call(kA, 'POST', `${V}/webhook-endpoints`, { url: 'https://hooks.example.com/second', events: ['shipment.updated'] });
    await call(kA, 'POST', `${V}/webhook-endpoints/${r.body.endpoint_id}/verify`);
    const del = await call(kA, 'DELETE', `${V}/webhook-endpoints/${r.body.endpoint_id}`);
    assert.strictEqual(del.body.state, 'disabled'); assert.strictEqual(del.body.disabled_reason, 'deleted');
  });

  await t.test('scopes, sandbox-only simulator, off switch', async () => {
    const o = await place([{ variant_id: 'kv_sbx_cushion_sage', quantity: 1 }]);
    const ro = S.issueKey(A.id, { scopes: ['orders:read'] }, admin).key;
    assert.strictEqual((await cancel(o.order_id, { reason_code: 'other' }, 'scope-key-0001', ro)).body.code, 'INSUFFICIENT_SCOPE');
    assert.strictEqual((await call(ro, 'GET', `${V}/orders/${o.order_id}/returns`)).body.code, 'INSUFFICIENT_SCOPE');
    assert.strictEqual((await call(ro, 'GET', `${V}/orders/${o.order_id}/documents`)).body.code, 'INSUFFICIENT_SCOPE');
    assert.strictEqual((await call(ro, 'GET', `${V}/webhook-endpoints`)).body.code, 'INSUFFICIENT_SCOPE');
    assert.strictEqual((await call(ro, 'GET', `${V}/orders/${o.order_id}/shipments`)).status, 200);
    await assert.rejects(F.simulate({ env: 'live', store: db.partner_stores.get(A.id) }, o.order_id, { action: 'ship' }), (e) => e.status === 403);
    assert.strictEqual((await sim(o.order_id, 'teleport')).status, 400);
    process.env.PARTNER_ORDERS_ENABLED = '0';
    assert.strictEqual((await call(kA, 'GET', `${V}/orders/${o.order_id}/shipments`)).body.code, 'TEMPORARILY_UNAVAILABLE');
    assert.strictEqual((await call(kA, 'POST', `${V}/webhook-endpoints`, { url: 'https://hooks.example.com/x' })).body.code, 'TEMPORARILY_UNAVAILABLE');
    process.env.PARTNER_ORDERS_ENABLED = '1';
    const a = await fetch(`${base}${V}/orders/${o.order_id}/shipments`, { method: 'PUT', headers: { authorization: `Bearer ${kA}` } });
    assert.strictEqual(a.status, 405);
  });

  await t.test('admin: queues and webhook summary carry no recipient data', async () => {
    const q = await F.adminQueues('sandbox'); const w = await W.adminSummary('sandbox');
    assert.ok(Array.isArray(q.cancellations) && Array.isArray(q.returns) && typeof q.handoff.pending === 'number');
    assert.ok(!/Sandbox Recipient|Example Street/.test(JSON.stringify([q, w])));
    assert.ok(Array.isArray(w.dead_list) && typeof w.dead === 'number' && typeof w.pending === 'number');
  });
});

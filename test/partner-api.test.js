'use strict';
/* Partner API v1 — Batch 1 acceptance: keys and scopes, two-store isolation, snapshot + change feed convergence
   (changed item, stock update, withdrawal, write during snapshot, entitlement revocation/grant, cursor expiry),
   problem+json errors, rate limit, and every response checked against docs/partner-api/openapi.json. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-'));
process.env.PARTNER_RATE_PER_MIN = '1000';
delete process.env.PARTNER_LIVE_ENABLED;
const db = require('../src/db');
const S = require('../src/partner/store');
const C = require('../src/partner/catalog');
const P = require('../src/partner/pricing');
const { server } = require('../src/server');
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'partner-api', 'openapi.json'), 'utf8'));

// ---- minimal JSON Schema (2020-12 subset used by the spec) validator ----
function resolveRef(r) { return r.replace(/^#\//, '').split('/').reduce((o, k) => o[k], SPEC); }
function validate(schema, v, at = '$') {
  if (schema.$ref) return validate(resolveRef(schema.$ref), v, at);
  if (schema.oneOf) { const ok = schema.oneOf.filter((s) => { try { validate(s, v, at); return true; } catch { return false; } }); if (ok.length !== 1) throw new Error(`${at}: oneOf matched ${ok.length}`); return; }
  const types = schema.type ? [].concat(schema.type) : null;
  const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (types && !types.some((t) => t === typeOf(v) || (t === 'number' && typeof v === 'number'))) throw new Error(`${at}: expected ${types} got ${typeOf(v)}`);
  if (schema.const !== undefined && v !== schema.const) throw new Error(`${at}: const`);
  if (schema.enum && !schema.enum.includes(v)) throw new Error(`${at}: ${v} not in enum`);
  if (schema.pattern && typeof v === 'string' && !new RegExp(schema.pattern).test(v)) throw new Error(`${at}: pattern`);
  if (schema.minimum !== undefined && typeof v === 'number' && v < schema.minimum) throw new Error(`${at}: minimum`);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of schema.required || []) if (!(k in v)) throw new Error(`${at}: missing ${k}`);
    for (const [k, val] of Object.entries(v)) {
      if (schema.properties && schema.properties[k]) validate(schema.properties[k], val, `${at}.${k}`);
      else if (schema.additionalProperties === false) throw new Error(`${at}: unexpected property ${k}`);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, val, `${at}.${k}`);
    }
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => validate(schema.items, x, `${at}[${i}]`));
}
function opFor(p) {
  const rel = p.replace(/^\/api\/partner\/v1/, '').split('?')[0];
  for (const [tpl, ops] of Object.entries(SPEC.paths)) if (new RegExp(`^${tpl.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(rel)) return ops.get;
  throw new Error(`no spec path for ${rel}`);
}

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

/** GET through HTTP and check the answer against the spec (status, content type, schema, request id). */
async function get(key, p) {
  const r = await fetch(base + p, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  const body = await r.json();
  assert.match(r.headers.get('x-request-id') || '', /^req_/, 'X-Request-Id on every response');
  const op = opFor(p); const resp = op.responses[String(r.status)];
  assert.ok(resp, `status ${r.status} is documented for ${p}`);
  const def = resp.$ref ? resolveRef(resp.$ref) : resp;
  const [ct] = Object.keys(def.content);
  assert.ok((r.headers.get('content-type') || '').startsWith(ct), `${p}: content type ${ct}`);
  validate(def.content[ct].schema, body, p);
  return { status: r.status, body, headers: r.headers };
}
const q = (o) => new URLSearchParams(o).toString();

// partner-side replica: what a store would hold after applying the API
function replica() {
  const m = new Map();
  return {
    m,
    put(p) { const cur = m.get(p.product_id); if (!cur || p.version >= cur.version) m.set(p.product_id, p); },
    apply(ev) { if (ev.type === 'upsert') this.put(ev.product); else { const cur = m.get(ev.product_id); if (!cur || ev.version >= cur.version) m.delete(ev.product_id); } }
  };
}
async function fullSnapshot(key, market, locale = 'en', limit = 5) {
  const out = []; let cursor = ''; let sync = null;
  do { const r = await get(key, `/api/partner/v1/catalog/products?${q({ market, locale, limit, ...(cursor ? { cursor } : {}) })}`); assert.strictEqual(r.status, 200); out.push(...r.body.data); cursor = r.body.next_cursor; sync = r.body.sync_cursor; } while (cursor);
  return { items: out, sync };
}
async function drain(key, market, cursor, rep, locale = 'en') {
  let c = cursor; let more = true; const evs = [];
  while (more) { const r = await get(key, `/api/partner/v1/catalog/changes?${q({ market, locale, cursor: c, limit: 3 })}`); assert.strictEqual(r.status, 200); r.body.data.forEach((e) => { evs.push(e); rep && rep.apply(e); }); c = r.body.next_cursor; more = r.body.has_more; }
  return { cursor: c, evs };
}

const admin = db.users.insert({ email: 'owner@kinan.test', role: 'admin', name: 'Owner' });
const org = S.createOrg({ name: 'Demo Retail GmbH' }, admin);
const A = S.createStore(org.id, { name: 'Store A', markets: ['DE'], locales: ['en', 'de'] }, admin);
const B = S.createStore(org.id, { name: 'Store B', markets: ['DE', 'GB'], categories: ['electronics'] }, admin);
const kA = S.issueKey(A.id, {}, admin).key; const kB = S.issueKey(B.id, {}, admin).key;
// a real marketplace listing must never appear in the sandbox
db.listings.insert({ seller_id: 'sel_x', title: 'REAL LISTING', status: 'active', source: 'cj', skus: [{ mp_sku_id: 'r1', price: 9, cost_sale: 3, stock: 5 }] });

test('keys are hashed at rest, shown once, and live keys stay off until the owner enables production', () => {
  const rec = db.partner_keys.find((k) => k.store_id === A.id);
  assert.ok(!JSON.stringify(rec).includes(kA), 'raw key not stored');
  assert.match(kA, /^knp_test_[0-9A-Za-z]{32}$/);
  assert.throws(() => S.issueKey(A.id, { env: 'live' }, admin), /switched off/);
  assert.throws(() => S.issueKey(A.id, { scopes: ['catalog:read', 'admin:all'] }, admin), /Unknown scopes/);
});

test('authentication and scope errors are problem+json', async () => {
  assert.strictEqual((await get(null, '/api/partner/v1/me')).body.code, 'INVALID_CREDENTIAL');
  assert.strictEqual((await get('knp_test_' + 'x'.repeat(32), '/api/partner/v1/me')).status, 401);
  const narrow = S.issueKey(A.id, { scopes: ['quotes:write'] }, admin);
  assert.strictEqual((await get(narrow.key, '/api/partner/v1/me')).status, 200);
  const r = await get(narrow.key, `/api/partner/v1/catalog/products?${q({ market: 'DE' })}`);
  assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'INSUFFICIENT_SCOPE');
  S.revokeKey(narrow.id, admin);
  assert.strictEqual((await get(narrow.key, '/api/partner/v1/me')).status, 401, 'revoked key refused');
  const bad = await get(kA, '/api/partner/v1/catalog/products?market=germany');
  assert.strictEqual(bad.status, 400); assert.strictEqual(bad.body.errors[0].field, 'market');
  assert.strictEqual((await get(kA, `/api/partner/v1/catalog/products?${q({ market: 'GB' })}`)).body.code, 'UNSUPPORTED_DESTINATION');
});

test('/me describes the calling store', async () => {
  const r = await get(kB, '/api/partner/v1/me');
  assert.deepStrictEqual([r.body.environment, r.body.store.name, r.body.markets], ['sandbox', 'Store B', ['DE', 'GB']]);
});

test('two stores see only their entitlements; the sandbox never shows real listings', async () => {
  const a = await fullSnapshot(kA, 'DE'); const b = await fullSnapshot(kB, 'DE');
  assert.strictEqual(a.items.length, 12);
  assert.ok(b.items.length > 0 && b.items.every((p) => p.category_id === 'electronics'));
  assert.ok(![...a.items, ...b.items].some((p) => /REAL LISTING/.test(p.title)));
  const homeId = a.items.find((p) => p.category_id !== 'electronics').product_id;
  assert.strictEqual((await get(kB, `/api/partner/v1/catalog/products/${homeId}?${q({ market: 'DE' })}`)).status, 404);
  assert.strictEqual((await get(kA, `/api/partner/v1/catalog/products/${homeId}?${q({ market: 'DE', locale: 'de-DE' })}`)).body.content_locale, 'de');
  const s = JSON.stringify(a.items);
  for (const secret of ['cost_minor', 'cost_sale', 'supplier', 'aliexpress', 'cj_vid', '"stock":']) assert.ok(!s.includes(secret), `no ${secret} in projections`);
});

test('initial import, changed item, stock update and withdrawal converge with a fresh snapshot', async () => {
  const rep = replica(); const snap = await fullSnapshot(kA, 'DE'); snap.items.forEach((p) => rep.put(p));
  let { cursor, evs } = await drain(kA, 'DE', snap.sync, rep);
  assert.strictEqual(evs.length, 0, 'nothing new right after the snapshot');
  C.simulate('lamp', { title_en: 'Table lamp (warm white)' });
  C.simulate('mug', { stock: 0, variant: 0 });
  C.simulate('tote', { withdrawn: true });
  ({ cursor, evs } = await drain(kA, 'DE', cursor, rep));
  const by = Object.fromEntries(evs.map((e) => [e.product_id, e]));
  assert.strictEqual(by.kp_sbx_lamp.reason, 'updated'); assert.strictEqual(by.kp_sbx_lamp.product.title, 'Table lamp (warm white)');
  assert.strictEqual(by.kp_sbx_mug.reason, 'inventory'); assert.strictEqual(by.kp_sbx_mug.product.variants[0].availability.state, 'out_of_stock');
  assert.strictEqual(by.kp_sbx_tote.type, 'withdraw');
  assert.strictEqual((await get(kA, `/api/partner/v1/catalog/products/kp_sbx_tote?${q({ market: 'DE' })}`)).status, 404);
  const fresh = await fullSnapshot(kA, 'DE');
  assert.deepStrictEqual([...rep.m.keys()].sort(), fresh.items.map((p) => p.product_id).sort());
  for (const p of fresh.items) assert.strictEqual(rep.m.get(p.product_id).version, p.version, `${p.product_id} version`);
  C.simulate('tote', { withdrawn: false });
  ({ evs } = await drain(kA, 'DE', cursor, rep));
  assert.ok(evs.some((e) => e.product_id === 'kp_sbx_tote' && e.type === 'upsert' && e.reason === 'restored'));
});

test('a write during the snapshot is replayed by the feed', async () => {
  const rep = replica(); let cursor = ''; let sync = null; let page = 0;
  do {
    const r = await get(kA, `/api/partner/v1/catalog/products?${q({ market: 'DE', limit: 4, ...(cursor ? { cursor } : {}) })}`);
    r.body.data.forEach((p) => rep.put(p));
    if (page++ === 0) { C.simulate('backpack', { cost_minor: 2100 }); C.simulate('speaker', { stock: 9 }); } // one already read, one still ahead
    cursor = r.body.next_cursor; sync = r.body.sync_cursor;
  } while (cursor);
  await drain(kA, 'DE', sync, rep);
  const fresh = await fullSnapshot(kA, 'DE');
  for (const p of fresh.items) assert.deepStrictEqual(rep.m.get(p.product_id), p, `${p.product_id} converged`);
});

test('entitlement revocation and grant reach only that store', async () => {
  const bSnap = await fullSnapshot(kB, 'DE'); const aSnap = await fullSnapshot(kA, 'DE');
  const repB = replica(); bSnap.items.forEach((p) => repB.put(p));
  S.updateStore(B.id, { categories: ['home_storage'] }, admin);
  const { evs } = await drain(kB, 'DE', bSnap.sync, repB);
  assert.ok(evs.some((e) => e.type === 'withdraw' && e.reason === 'entitlement_revoked'));
  assert.ok(evs.some((e) => e.type === 'upsert' && e.reason === 'entitlement_granted'));
  assert.ok([...repB.m.values()].every((p) => p.category_id === 'home_storage'));
  const a = await drain(kA, 'DE', aSnap.sync);
  assert.strictEqual(a.evs.filter((e) => /entitlement/.test(e.reason)).length, 0, 'store A unaffected');
  // a new price list bumps versions and reprices for that store only
  S.updateStore(B.id, { markup_pct: 10 }, admin);
  const { evs: pe } = await drain(kB, 'DE', (await fullSnapshot(kB, 'DE')).sync);
  assert.strictEqual(pe.length, 0, 'snapshot after the change already has the new prices');
});

test('cursors: tampered, other store, other market, expired', async () => {
  const { sync } = await fullSnapshot(kA, 'DE');
  const tampered = sync.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.strictEqual((await get(kA, `/api/partner/v1/catalog/changes?${q({ market: 'DE', cursor: tampered })}`)).body.code, 'INVALID_CURSOR');
  assert.strictEqual((await get(kB, `/api/partner/v1/catalog/changes?${q({ market: 'DE', cursor: sync })}`)).body.code, 'CURSOR_SCOPE_MISMATCH');
  assert.strictEqual((await get(kA, `/api/partner/v1/catalog/changes?${q({ market: 'DE', locale: 'de', cursor: sync })}`)).body.code, 'CURSOR_SCOPE_MISMATCH');
  assert.strictEqual((await get(kA, `/api/partner/v1/catalog/changes?${q({ market: 'DE' })}`)).status, 400);
  C.simulate('bottle', { stock: 1 }); // an event after this cursor…
  for (const e of db.partner_changes.all()) db.partner_changes.update(e.id, { at: Date.now() - 40 * 86400e3 }); // …ages out
  C.prune('sandbox');
  const r = await get(kA, `/api/partner/v1/catalog/changes?${q({ market: 'DE', cursor: sync })}`);
  assert.strictEqual(r.status, 410); assert.strictEqual(r.body.code, 'CURSOR_EXPIRED');
  const again = await fullSnapshot(kA, 'DE'); // recovery: a new snapshot gives a working cursor
  assert.strictEqual((await get(kA, `/api/partner/v1/catalog/changes?${q({ market: 'DE', cursor: again.sync })}`)).status, 200);
});

test('paused store and rate limit', async () => {
  S.updateStore(A.id, { status: 'paused' }, admin);
  const r = await get(kA, '/api/partner/v1/me'); assert.strictEqual(r.status, 503);
  S.updateStore(A.id, { status: 'active' }, admin);
  process.env.PARTNER_RATE_PER_MIN = '10';
  const C2 = S.createStore(org.id, { name: 'Store C', markets: ['DE'] }, admin); const k = S.issueKey(C2.id, {}, admin).key;
  let last; for (let i = 0; i < 12; i++) last = await get(k, '/api/partner/v1/me');
  assert.strictEqual(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) >= 1);
  process.env.PARTNER_RATE_PER_MIN = '1000';
});

test('wholesale pricing: 30% floor (worked example) and catalogue prices never under it', async () => {
  assert.strictEqual(P.floorMinor(1625), 2322);
  const c = P.contribution(2400, 1625); assert.strictEqual(c.contribution_minor, 775); assert.ok(Math.abs(c.margin - 0.3229) < 1e-3);
  const fx = require('../src/partner/sandbox-fixtures.json').products.flatMap((p) => p.variants.map((v) => [`kv_sbx_${v.key}`, v.cost_minor]));
  const cost = Object.fromEntries(fx);
  const { items } = await fullSnapshot(kA, 'DE');
  for (const p of items) for (const v of p.variants) {
    const unit = v.wholesale_unit_price_ex_tax.amount_minor; const k = db.partner_sandbox.all().flatMap((x) => x.variants).find((x) => `kv_sbx_${x.key}` === v.variant_id);
    assert.ok(P.contribution(unit, k.cost_minor).margin >= 0.2999, `${v.variant_id} margin`); assert.ok(cost[v.variant_id]);
  }
});

test('the Partner API is GET-only in Batch 1 and the spec is served', async () => {
  const r = await fetch(`${base}/api/partner/v1/catalog/products`, { method: 'POST', headers: { authorization: `Bearer ${kA}` } });
  assert.strictEqual(r.status, 405); assert.match(r.headers.get('content-type'), /problem\+json/);
  const s = await (await fetch(`${base}/api/partner/v1/openapi.json`)).json(); assert.strictEqual(s.openapi, '3.1.1');
  assert.strictEqual((await fetch(`${base}/api/catalog`)).status, 200, 'public shop API unchanged');
});

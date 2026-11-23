'use strict';
/*
 * Delivery country selection and product availability — acceptance tests (handoff sections 3–6).
 * Synthetic data only: a temporary JSON database, mocked CJ and AliExpress verifiers (no supplier is called).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dcountry-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', AI_AUTO_REVIEW: 'off', CAMPAIGNS_JSON: '[]', XMAS_AUTO: '0' });
for (const k of ['STRIPE_SECRET_KEY', 'CJ_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL']) delete process.env[k];

const auth = require('../src/auth');
const db = require('../src/db');
const E = require('../src/services/eligibility');
const { skuPub } = require('../src/services/publicIds');
const { server } = require('../src/server');

let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, { token, country } = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(country ? { 'X-Kinan-Country': country } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}

// ---- mocked supplier answers: ROUTES[vid][country] = { max, fee } | 'none' | Error ----
const ROUTES = {}; const calls = [];
let pointsOut = false;
E._setVerifier('cj', async (l, sku, cc) => {
  calls.push(`${sku.cj_vid}>${cc}`);
  if (pointsOut) throw Object.assign(new Error('CJ: no API points left for now'), { code: 'POINTS', status: 429 });
  const r = (ROUTES[sku.cj_vid] || {})[cc];
  if (r instanceof Error) throw r;
  if (!r || r === 'none') return { options: [], origin: 'CN', currency: 'USD' };
  if (r.noEstimate) return { options: [{ method: 'NoTrack', fee: 1, min: null, max: null }], origin: 'CN', currency: 'USD' };
  return { options: [{ method: 'CJPacket', fee: r.fee ?? 3, min: r.min ?? Math.max(1, r.max - 3), max: r.max }], origin: 'CN', currency: 'USD' };
});
E._setVerifier('aliexpress', async () => ({ options: [], origin: null, currency: 'USD' }));

const T = {}; const L = {};
let sellerId; let n = 0;
function cjListing(title, variants, extra = {}) {
  n++;
  const l = db.listings.insert({
    seller_id: sellerId, status: 'active', source: 'cj', fulfillment: 'direct', title, description: title, category: 'home', collections: ['home'],
    images: ['https://img.example/a.jpg'], currency: 'usd', review: { state: 'approved', decided_at: Date.now() - n * 1000 }, created_at: Date.now() - n * 1000,
    cj_pid: `pid${n}`, cj_from: 'CN', last_synced_at: Date.now(),
    skus: variants.map((v, i) => ({ mp_sku_id: `${n}-${i}`, cj_vid: v.vid, props: v.props || `Option ${i}`, price: v.price ?? 20 + i, stock: v.stock ?? 10, cost_sale: 1 })),
    ...extra
  });
  return l;
}
const enforce = (...ccs) => E.saveConfig({ markets: Object.fromEntries(ccs.map((c) => [c, 'enforce'])) });

test('setup: owner, buyer, a shop', async () => {
  T.owner = (await api('POST', '/api/auth/login', { email: 'boss@x.com', password: 'adminpass1', app: 'admin' })).body.token;
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'buyer@x.com', password: 'buyerpass1', name: 'Buyer Person' });
  T.buyer = (await api('POST', '/api/auth/login', { email: 'buyer@x.com', password: 'buyerpass1', app: 'shop' })).body.token;
  sellerId = db.sellers.insert({ user_id: 'u_test', shop_name: 'Atlas', status: 'active', commission_pct: 10 }).id;
  assert.ok(T.owner && T.buyer);
});

test('canonical markets: Europe incl. GB, CA, AU, NZ, US, Libya and the earlier countries; one list for the API', async () => {
  const cfg = (await api('GET', '/api/config/public')).body;
  const codes = cfg.countries.map((c) => c[0]);
  for (const c of ['GB', 'DE', 'FR', 'NO', 'CH', 'UA', 'IS', 'VA', 'CA', 'AU', 'NZ', 'US', 'LY', 'SA', 'AE', 'TR']) assert.ok(codes.includes(c), c);
  for (const c of ['RU', 'BY', 'UK', 'XK']) assert.ok(!codes.includes(c), `${c} is not a market`);
  assert.ok(cfg.countries.every((c) => c.length === 4 && c[2]), 'English and Arabic names and a region');
});

test('product ships exclusively to Canada: in Canada; not in New Zealand search, collections or recommendations', async () => {
  ROUTES.vCA = { CA: { max: 9 } };
  L.ca = cjListing('Maple lamp', [{ vid: 'vCA' }]);
  L.other = cjListing('Maple chair', [{ vid: 'vBOTH' }]);
  ROUTES.vBOTH = { CA: { max: 8 }, NZ: { max: 10 } };
  enforce('CA', 'NZ');
  for (const cc of ['CA', 'NZ']) for (const l of [L.ca, L.other]) await E.verifyOne(db.listings.get(l.id), l.skus[0], cc);
  const ca = (await api('GET', '/api/catalog?q=maple', null, { country: 'CA' })).body;
  assert.deepEqual(ca.items.map((p) => p.id).sort(), [L.ca.id, L.other.id].sort());
  const nz = (await api('GET', '/api/catalog?q=maple', null, { country: 'NZ' })).body;
  assert.deepEqual(nz.items.map((p) => p.id), [L.other.id], 'search');
  assert.equal(nz.total, 1, 'count after filtering');
  const nzCol = (await api('GET', '/api/catalog?collection=home&limit=100', null, { country: 'NZ' })).body;
  assert.ok(!nzCol.items.some((p) => p.id === L.ca.id), 'collections');
  const sim = (await api('GET', `/api/catalog/${L.other.id}/similar`, null, { country: 'NZ' })).body;
  assert.ok(!sim.items.some((p) => p.id === L.ca.id), 'recommendations (similar)');
  const simCa = (await api('GET', `/api/catalog/${L.other.id}/similar`, null, { country: 'CA' })).body;
  assert.ok(simCa.items.some((p) => p.id === L.ca.id), 'recommended in Canada');
  const many = (await api('GET', `/api/catalog/many?ids=${L.ca.id},${L.other.id}`, null, { country: 'NZ' })).body;
  assert.deepEqual(many.items.map((p) => p.id), [L.other.id], 'deals / recently viewed');
  const cats = (await api('GET', '/api/categories', null, { country: 'NZ' })).body;
  assert.equal(cats.find((c) => c.id === 'home').count, 1, 'category counts per country');
  // a direct link opens with the reason and nothing to add to the cart
  const d = (await api('GET', `/api/catalog/${L.ca.id}`, null, { country: 'NZ' }));
  assert.equal(d.status, 200);
  assert.equal(d.body.availability.available, false); assert.equal(d.body.availability.reason, 'unavailable');
  assert.deepEqual(d.body.skus, []);
  assert.equal((await api('GET', `/api/catalog/${L.ca.id}`, null, { country: 'CA' })).body.availability.available, true);
});

test('Black ships to the UK, White to Germany: each market sees its own variant of the same listing', async () => {
  ROUTES.vBlack = { GB: { max: 6 }, DE: 'none' }; ROUTES.vWhite = { GB: 'none', DE: { max: 7 } };
  L.mug = cjListing('Two-colour mug', [{ vid: 'vBlack', props: 'Black' }, { vid: 'vWhite', props: 'White' }]);
  enforce('GB', 'DE');
  const l = db.listings.get(L.mug.id);
  for (const cc of ['GB', 'DE']) for (const s of l.skus) await E.verifyOne(l, s, cc);
  const gb = (await api('GET', `/api/catalog/${l.id}`, null, { country: 'GB' })).body;
  const de = (await api('GET', `/api/catalog/${l.id}`, null, { country: 'DE' })).body;
  assert.deepEqual(gb.skus.map((s) => s.props), ['Black']);
  assert.deepEqual(de.skus.map((s) => s.props), ['White']);
  assert.equal((await api('GET', '/api/catalog?q=mug', null, { country: 'GB' })).body.items[0].min_price, 20, 'list price from the eligible variant');
  assert.equal((await api('GET', '/api/catalog?q=mug', null, { country: 'DE' })).body.items[0].min_price, 21);
});

test('one market passes while other checks are pending: the product appears in the verified market at once', async () => {
  ROUTES.vFast = { FR: { max: 5 } };
  L.fast = cjListing('Fresh scarf', [{ vid: 'vFast' }, { vid: 'vFast2' }]);
  enforce('FR', 'IT');
  // the queue checks the cheapest in-stock variant of listings with nothing eligible yet, first
  const tasks = E.nextTasks(500).filter((t) => t.l.id === L.fast.id);
  assert.equal(tasks[0].sku.mp_sku_id, L.fast.skus[0].mp_sku_id);
  await E.verifyOne(db.listings.get(L.fast.id), L.fast.skus[0], 'FR');
  assert.ok((await api('GET', '/api/catalog?q=scarf', null, { country: 'FR' })).body.items.some((p) => p.id === L.fast.id), 'visible in France');
  assert.equal((await api('GET', '/api/catalog?q=scarf', null, { country: 'IT' })).body.total, 0, 'Italy still pending');
  const r = E.report().markets.find((m) => m.country === 'IT');
  assert.ok(r.totals.pending >= 1, 'pending shown in the report');
});

test('transit limit and freshness: over-limit hidden, missing estimate pending, expired result pending, limit configurable', async () => {
  ROUTES.vSlow = { ES: { max: 25 } }; // the default limit is 3 weeks (21 days)
  L.slow = cjListing('Slow vase', [{ vid: 'vSlow' }]);
  enforce('ES');
  const l = db.listings.get(L.slow.id);
  await E.verifyOne(l, l.skus[0], 'ES');
  assert.equal(E.variantState(l, l.skus[0], 'ES').state, 'over_limit');
  assert.equal((await api('GET', '/api/catalog?q=vase', null, { country: 'ES' })).body.total, 0);
  E.saveConfig({ max_days: { ES: 25 } });
  assert.equal(E.variantState(l, l.skus[0], 'ES').state, 'eligible', 'a per-country limit applies without new checks');
  assert.equal((await api('GET', '/api/catalog?q=vase', null, { country: 'ES' })).body.total, 1, 'catalogue cache follows the change');
  E.saveConfig({ max_days: { ES: null } });
  // a quote with no delivery estimate is pending verification
  ROUTES.vNoEst = { ES: { noEstimate: true } };
  const ne = cjListing('No estimate', [{ vid: 'vNoEst' }]);
  await E.verifyOne(db.listings.get(ne.id), ne.skus[0], 'ES');
  assert.equal(E.variantState(db.listings.get(ne.id), ne.skus[0], 'ES').state, 'pending_verification');
  // expiry
  const rec = E.recordOf(L.fast.id, 'FR', L.fast.skus[0].mp_sku_id, 'cj_direct');
  E.writeRecord(L.fast.id, 'FR', L.fast.skus[0].mp_sku_id, 'cj_direct', { ...rec, expires_at: Date.now() - 1 });
  assert.equal(E.variantState(db.listings.get(L.fast.id), L.fast.skus[0], 'FR').state, 'pending_verification');
  E.writeRecord(L.fast.id, 'FR', L.fast.skus[0].mp_sku_id, 'cj_direct', rec);
});

test('CJ runs out of points during the queue: work defers and resumes, reports show pending, valid results stay until expiry', async () => {
  ROUTES.vQ1 = { PT: { max: 6 } }; ROUTES.vQ2 = { PT: { max: 7 } };
  const q1 = cjListing('Quota lamp one', [{ vid: 'vQ1' }]); const q2 = cjListing('Quota lamp two', [{ vid: 'vQ2' }]);
  enforce('PT');
  await E.verifyOne(db.listings.get(q1.id), q1.skus[0], 'PT'); // q1 verified before the points ran out
  pointsOut = true;
  const r = await E.tick({ limit: 20 });
  assert.ok(r.errors.quota >= 1, 'quota error counted');
  const paused = E.report().paused.cj;
  assert.equal(paused.kind, 'quota'); assert.ok(paused.until > Date.now(), 'CJ paused until points refill');
  const before = calls.length;
  await E.tick({ limit: 20 });
  assert.equal(calls.length, before, 'no CJ calls while paused');
  assert.equal(E.variantState(db.listings.get(q1.id), q1.skus[0], 'PT').state, 'eligible', 'earlier valid verification still used');
  assert.equal(E.variantState(db.listings.get(q2.id), q2.skus[0], 'PT').state, 'pending_verification');
  const pt = E.report().markets.find((m) => m.country === 'PT');
  assert.ok(pt.by_supplier.cj.pending >= 1 && pt.by_supplier.cj.available >= 1);
  // the check that hit the limit only got retry bookkeeping (no state)
  const hit = db.eligibility.all().flatMap((d) => Object.values(d.v).flatMap((r) => Object.values(r))).filter((x) => x.last_error?.kind === 'quota');
  assert.equal(hit.length, 1, 'stopped at the first refusal'); assert.equal(hit[0].state ?? null, null);
  // points back: the queue resumes and reaches the rest
  pointsOut = false;
  const st = db.settings.get('eligibility_state'); db.settings.update('eligibility_state', { ...st, paused: {} });
  for (const d of db.eligibility.all()) for (const [sku, r] of Object.entries(d.v)) for (const [route, rec] of Object.entries(r)) if (rec.last_error?.kind === 'quota') E.writeRecord(d.listing_id, d.country, sku, route, { ...rec, next_retry_at: 0 });
  await E.tick({ limit: 500 });
  assert.equal(E.variantState(db.listings.get(q2.id), q2.skus[0], 'PT').state, 'eligible');
  // other temporary failures (auth, timeout, malformed) never erase a valid result either
  for (const err of [Object.assign(new Error('CJ access token expired'), { status: 401 }), Object.assign(new Error('timed out'), { name: 'TimeoutError' }), new Error('unexpected reply shape')]) {
    ROUTES.vQ1.PT = err;
    await E.verifyOne(db.listings.get(q1.id), q1.skus[0], 'PT');
    assert.equal(E.variantState(db.listings.get(q1.id), q1.skus[0], 'PT').state, 'eligible', err.message);
  }
  assert.equal(E.classify(Object.assign(new Error('x'), { status: 401 })), 'auth');
  assert.equal(E.classify(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(E.classify(new Error('weird')), 'error');
  db.settings.update('eligibility_state', { ...db.settings.get('eligibility_state'), paused: {} });
  ROUTES.vQ1.PT = { max: 6 };
});

test('overlapping jobs and repeated runs: one record per variant and country, current results kept', async () => {
  ROUTES.vDup = { BE: { max: 5 } };
  const d = cjListing('Dup kettle', [{ vid: 'vDup' }]);
  enforce('BE');
  const [a, b] = await Promise.all([E.tick({ limit: 200 }), E.tick({ limit: 200 })]);
  assert.ok(a.skipped === 'running' || b.skipped === 'running', 'a second pass does not run alongside the first');
  const n1 = calls.filter((c) => c === 'vDup>BE').length;
  await E.tick({ limit: 200 });
  assert.equal(calls.filter((c) => c === 'vDup>BE').length, n1, 'a current result is not checked again');
  assert.equal(db.eligibility.all((x) => x.id === `${d.id}|BE`).length, 1);
  const bf1 = E.backfill({ apply: true }); const bf2 = E.backfill({ apply: true });
  assert.equal(bf2.written, 0, 'backfill is idempotent'); assert.ok(bf1.applied);
  assert.equal(E.variantState(db.listings.get(d.id), d.skus[0], 'BE').state, 'eligible');
});

test('legacy results are reused only when they name the variant and country', async () => {
  const at = Date.now() - 3600e3;
  const lg = cjListing('Legacy lamp', [{ vid: 'vL1' }, { vid: 'vL2' }], { cj_ship: { NL: { fee: 2, vid: 'vL1', at, min: 4, max: 8 }, AT: { fee: 3, vid: 'vL2', at, estimated: true } } });
  const shadow = E.backfill({ apply: false });
  assert.ok(shadow.reusable >= 1); assert.equal(shadow.applied, false);
  assert.equal(E.recordOf(lg.id, 'NL', lg.skus[0].mp_sku_id, 'cj_direct'), null, 'shadow run writes nothing');
  E.backfill({ apply: true });
  assert.equal(E.recordOf(lg.id, 'NL', lg.skus[0].mp_sku_id, 'cj_direct').state, 'eligible', 'vL1 to NL reused');
  assert.equal(E.recordOf(lg.id, 'NL', lg.skus[1].mp_sku_id, 'cj_direct'), null, 'not copied to the other variant');
  assert.equal(E.recordOf(lg.id, 'AT', lg.skus[1].mp_sku_id, 'cj_direct'), null, 'an estimated fee proves nothing');
});

test('eligible items beyond the first unfiltered page fill the first filtered page, with accurate counts', async () => {
  enforce('SE');
  for (let i = 0; i < 30; i++) cjListing(`Pager ineligible ${i}`, [{ vid: `vPX${i}` }]); // newest: no SE route
  const ok = [];
  for (let i = 0; i < 5; i++) { ROUTES[`vPO${i}`] = { SE: { max: 6 } }; ok.push(cjListing(`Pager eligible ${i}`, [{ vid: `vPO${i}` }], { created_at: Date.now() - 1e9 - i, review: { state: 'approved', decided_at: Date.now() - 1e9 - i } })); }
  for (const l of ok) await E.verifyOne(db.listings.get(l.id), l.skus[0], 'SE');
  const page = (await api('GET', '/api/catalog?q=pager&limit=4', null, { country: 'SE' })).body;
  assert.equal(page.total, 5); assert.equal(page.items.length, 4);
  assert.ok(page.items.every((p) => ok.some((l) => l.id === p.id)));
  const next = (await api('GET', '/api/catalog?q=pager&limit=4&offset=4', null, { country: 'SE' })).body;
  assert.equal(next.items.length, 1);
  assert.equal((await api('GET', '/api/catalog?q=pager&limit=4&sort=price_asc', null, { country: 'SE' })).body.total, 5, 'price sort filters first too');
});

test('shadow mode leaves the shop unchanged; rollback keeps preferences and verification data', async () => {
  const before = (await api('GET', '/api/catalog?q=maple', null, { country: 'NZ' })).body.total;
  assert.equal(before, 1);
  const r = await api('PATCH', '/api/admin/eligibility/config', { rollback: true }, { token: T.owner });
  assert.equal(r.status, 200); assert.ok(Object.values(r.body.markets).every((m) => m === 'shadow'));
  assert.equal((await api('GET', '/api/catalog?q=maple', null, { country: 'NZ' })).body.total, 2, 'shadow: not filtered');
  assert.ok(E.recordOf(L.ca.id, 'CA', L.ca.skus[0].mp_sku_id, 'cj_direct'), 'data kept');
  enforce('CA', 'NZ', 'GB', 'DE', 'FR', 'IT', 'ES', 'PT', 'BE', 'SE');
  assert.equal((await api('GET', '/api/catalog?q=maple', null, { country: 'NZ' })).body.total, 1, 'enforced again');
});

test('changing country with a cart: ineligible lines show a reason and checkout is blocked', async () => {
  const cart = [{ listing_id: L.ca.id, mp_sku_id: skuPub(L.ca.id, L.ca.skus[0].mp_sku_id), qty: 1 }, { listing_id: L.other.id, mp_sku_id: skuPub(L.other.id, L.other.skus[0].mp_sku_id), qty: 1 }];
  const ca = (await api('POST', '/api/cart/check', { country: 'CA', items: cart })).body;
  assert.equal(ca.ok, true);
  const nz = (await api('POST', '/api/cart/check', { country: 'NZ', items: cart })).body;
  assert.equal(nz.ok, false);
  assert.deepEqual(nz.lines.map((x) => [x.ok, x.reason || null]), [[false, 'unavailable'], [true, null]]);
  const addr = { name: 'Buyer Person', phone: '+64 21 000 000', country_code: 'NZ', city: 'Auckland', line1: '1 Queen St', postal_code: '1010' };
  const co = await api('POST', '/api/buyer/checkout', { items: cart, shipping_address: addr }, { token: T.buyer, country: 'CA' });
  assert.equal(co.status, 409); assert.equal(co.body.code, 'NOT_DELIVERABLE');
  assert.equal(co.body.details.lines.length, 1); assert.equal(co.body.details.lines[0].listing_id, L.ca.id);
  assert.equal(db.orders.all().length, 0, 'no order created');
});

test('checkout: the real address decides, postal codes are checked, a changed total needs confirmation', async () => {
  // a Kinan-warehouse product derives eligibility from the zone rates (all markets but Libya)
  const w = db.listings.insert({ seller_id: sellerId, status: 'active', source: 'manual', fulfillment: 'warehouse', title: 'Warehouse tray', images: ['https://img.example/t.jpg'], currency: 'usd', category: 'home', review: { state: 'approved' }, weight_kg: 0.5, last_synced_at: Date.now(), skus: [{ mp_sku_id: 'w1', props: 'One', price: 30, stock: 5, cost_cny: 10 }] });
  const item = [{ listing_id: w.id, mp_sku_id: skuPub(w.id, 'w1'), qty: 1 }];
  const addr = { name: 'Buyer Person', phone: '+44 7700 900000', country_code: 'GB', city: 'London', line1: '1 High St' };
  let r = await api('POST', '/api/buyer/checkout', { items: item, shipping_address: addr }, { token: T.buyer, country: 'GB' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'POSTAL_CODE_REQUIRED');
  r = await api('POST', '/api/buyer/checkout', { items: item, shipping_address: { ...addr, postal_code: '12345' } }, { token: T.buyer });
  assert.equal(r.body.code, 'POSTAL_CODE_INVALID');
  r = await api('POST', '/api/buyer/checkout', { items: item, shipping_address: { ...addr, postal_code: 'SW1A 1AA' }, expected_total: 1 }, { token: T.buyer });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'TOTAL_CHANGED'); assert.ok(r.body.details.total > 30);
  r = await api('POST', '/api/buyer/checkout', { items: item, shipping_address: { ...addr, postal_code: 'SW1A 1AA' }, expected_total: r.body.details.total }, { token: T.buyer });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Libya has no route yet: even a warehouse product cannot be ordered there once Libya is enforced
  enforce('LY');
  const ly = await api('POST', '/api/buyer/checkout', { items: item, shipping_address: { name: 'B', phone: '+218 91 000 0000', country_code: 'LY', city: 'Tripoli', line1: 'Street 1' } }, { token: T.buyer });
  assert.equal(ly.status, 409); assert.equal(ly.body.details.lines[0].reason, 'unavailable');
  assert.equal((await api('GET', '/api/catalog', null, { country: 'LY' })).body.total, 0, 'a selectable market can have an empty catalogue');
});

test('delivery country preference: saved for signed-in customers; geo lookup answers only markets', async () => {
  const bad = await api('PATCH', '/api/buyer/profile', { delivery_country: 'RU' }, { token: T.buyer });
  assert.equal(bad.status, 400);
  const ok = await api('PATCH', '/api/buyer/profile', { delivery_country: 'au' }, { token: T.buyer });
  assert.equal(ok.status, 200); assert.equal(ok.body.delivery_country, 'AU');
  assert.equal((await api('GET', '/api/me', null, { token: T.buyer })).body.delivery_country, 'AU', 'remembered on the account');
  const g = await fetch(`${base}/api/geo/country`, { headers: { 'CF-IPCountry': 'AU' } }).then((x) => x.json());
  assert.deepEqual([g.country, g.in_scope], ['AU', true]);
  const out = await fetch(`${base}/api/geo/country`, { headers: { 'CF-IPCountry': 'BR' } }).then((x) => x.json());
  assert.deepEqual([out.country, out.detected, out.in_scope], [null, 'BR', false]);
});

test('Admin: coverage by country and supplier, variant detail, bounded retries; configuration and data writes are owner-only', async () => {
  const rep = (await api('GET', '/api/admin/eligibility', null, { token: T.owner })).body;
  const nz = rep.markets.find((m) => m.country === 'NZ');
  assert.equal(nz.mode, 'enforce'); assert.equal(nz.max_days, 21, 'default: 3 weeks');
  assert.ok(nz.by_supplier.cj.available >= 1 && nz.by_supplier.cj.unavailable >= 1);
  const det = (await api('GET', `/api/admin/eligibility/listing/${L.mug.id}`, null, { token: T.owner })).body;
  const row = det.rows.find((x) => x.country === 'DE' && x.props === 'Black');
  assert.equal(row.state, 'unavailable'); assert.ok(row.verified_at && row.next_retry_at);
  const rt = (await api('POST', '/api/admin/eligibility/retry', { listing_ids: [L.mug.id], country: 'DE' }, { token: T.owner })).body;
  assert.equal(rt.queued, 2);
  assert.ok(E.nextTasks(1000).some((t) => t.l.id === L.mug.id && t.cc === 'DE'), 'retries go through the same queue');
  // staff who are not the owner: read only
  await api('POST', '/api/admin/staff', { email: 'ops@x.com', password: 'ops-password-1', name: 'Ops', role: 'admin', mailboxes: [] }, { token: T.owner });
  const ops = (await api('POST', '/api/auth/login', { email: 'ops@x.com', password: 'ops-password-1', app: 'admin' })).body.token;
  assert.equal((await api('GET', '/api/admin/eligibility', null, { token: ops })).status, 200);
  assert.equal((await api('PATCH', '/api/admin/eligibility/config', { rollback: true }, { token: ops })).status, 403);
  assert.equal((await api('POST', '/api/admin/eligibility/backfill', { apply: true }, { token: ops })).status, 403);
  assert.equal((await api('POST', '/api/admin/eligibility/backfill', { apply: false }, { token: ops })).status, 200, 'the shadow report is read-only');
  assert.equal((await api('GET', '/api/admin/eligibility', null, { token: T.buyer })).status, 403);
  assert.equal((await api('PATCH', '/api/admin/eligibility/config', { markets: { XX: 'enforce' } }, { token: T.owner })).status, 400);
});

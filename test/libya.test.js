'use strict';
/*
 * Libya market — acceptance tests (handoff section 11) plus the publishing, COD, permission and safety rules of
 * sections 8–10. Synthetic data only (temporary JSON database); no carrier, supplier or payment is called.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'libya-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', AI_AUTO_REVIEW: 'off', CAMPAIGNS_JSON: '[]', XMAS_AUTO: '0' });
for (const k of ['STRIPE_SECRET_KEY', 'CJ_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL']) delete process.env[k];

const auth = require('../src/auth');
const db = require('../src/db');
const LYS = require('../src/services/libya');
const { server } = require('../src/server');

let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, { token, country, city } = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(country ? { 'X-Kinan-Country': country } : {}), ...(city ? { 'X-Kinan-City': city } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (email, password, app = 'admin') => (await api('POST', '/api/auth/login', { email, password, app })).body.token;
const T = {}; const C = {}; const O = {}; let loc;
const recipient = (extra = {}) => ({ name: 'سالم علي', phone: '091 234 5678', city_id: C.tripoli.id, area_id: C.tripoli.areas[0].id, address: 'شارع عمر المختار', landmark: 'قرب المسجد', ...extra });
let keyN = 0; const key = (p = 'ev') => `${p}-${Date.now()}-${keyN++}`;

test('setup: owner opens Libya with two cities, a stock location and approved offers', async () => {
  T.owner = await login('boss@x.com', 'adminpass1');
  for (const who of ['a', 'b']) {
    await api('POST', '/api/auth/register', { role: 'buyer', email: `ly${who}@x.com`, password: 'buyerpass1', name: `Buyer ${who}` });
    T[who] = await login(`ly${who}@x.com`, 'buyerpass1', 'shop');
  }
  let r = await api('POST', '/api/admin/ly/cities', { name_ar: 'طرابلس', name_en: 'Tripoli', aliases: ['Tarabulus'], areas: [{ name_ar: 'سوق الجمعة', name_en: 'Souq Al Juma' }, { name_ar: 'جنزور', name_en: 'Janzour', cod: false }],
    routes: { local: { enabled: true, fee_lyd: 10, min_days: 1, max_days: 3, cod: true, carrier: 'Local courier' }, china: { enabled: true, verified: true, fee_lyd: 15, min_days: 18, max_days: 28, cod: false, carrier: 'Cargo', includes: 'International shipping and customs clearance' } } }, { token: T.owner });
  assert.equal(r.status, 200, JSON.stringify(r.body)); C.tripoli = r.body;
  r = await api('POST', '/api/admin/ly/cities', { name_ar: 'بنغازي', name_en: 'Benghazi', routes: { china: { enabled: true, verified: true, fee_lyd: 20, min_days: 20, max_days: 29, carrier: 'Cargo' } } }, { token: T.owner });
  C.benghazi = r.body;
  loc = (await api('POST', '/api/admin/ly/locations', { name: 'مخزن طرابلس', city_id: C.tripoli.id }, { token: T.owner })).body;
  const mk = async (b) => {
    const o = (await api('POST', '/api/admin/ly/offers', { category: 'home', images: ['https://img.example/ly.jpg'], ...b }, { token: T.owner })).body;
    assert.equal(o.status, 'draft');
    await api('POST', `/api/admin/ly/offers/${o.id}/review`, { approve_content: true }, { token: T.owner });
    return o;
  };
  O.lamp = await mk({ title_ar: 'مصباح طاولة', title_en: 'Desk lamp', route: 'local', variants: [{ props: 'أسود', price_lyd: 45, cost_lyd: 30 }], featured: true });
  O.last = await mk({ title_ar: 'آخر قطعة', title_en: 'Last unit', route: 'local', variants: [{ props: 'واحد', price_lyd: 99.5 }] });
  O.china = await mk({ title_ar: 'سماعات', title_en: 'Headphones', route: 'china', variants: [{ props: 'أبيض', price_lyd: 60 }] });
  for (const [o, n] of [[O.lamp, 10], [O.last, 1]]) await api('POST', '/api/admin/ly/stock', { offer_id: o.id, variant_id: o.variants[0].id, location_id: loc.id, delta: n, reason: 'received' }, { token: T.owner });
  for (const o of [O.lamp, O.last]) assert.equal((await api('POST', `/api/admin/ly/offers/${o.id}/status`, { status: 'published' }, { token: T.owner })).status, 200);
  assert.equal((await api('PATCH', '/api/admin/ly/config', { enabled: true }, { token: T.owner })).body.enabled, true);
});

test('Libya stays closed to customers until the owner opens it; then its own catalogue in LYD', async () => {
  LYS.saveConfig({ enabled: false });
  assert.equal((await api('GET', '/api/catalog', null, { country: 'LY' })).body.items.some((p) => String(p.id).startsWith('lyo_')), false);
  assert.equal((await api('POST', '/api/ly/checkout', { items: [], recipient: recipient() }, { token: T.a })).body.code, 'MARKET_CLOSED');
  LYS.saveConfig({ enabled: true });
  const info = (await api('GET', '/api/ly/info')).body;
  assert.equal(info.currency, 'LYD'); assert.ok(info.cities.some((c) => c.name_ar === 'طرابلس'));
  assert.ok(info.categories.some((c) => c.id === 'home'));
});

test('China route missing a shipping quote: the import offer stays unpublished until a verified quote exists', async () => {
  const r = await api('POST', `/api/admin/ly/offers/${O.china.id}/status`, { status: 'published' }, { token: T.owner });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'NOT_PUBLISHABLE'); assert.ok(r.body.details.why.includes('missing_china_quote'));
  assert.ok(!(await api('GET', '/api/catalog', null, { country: 'LY' })).body.items.some((p) => p.id === O.china.id));
  assert.equal((await api('POST', `/api/admin/ly/offers/${O.china.id}/review`, { china_quote: { quote_lyd: 12 } }, { token: T.owner })).status, 400, 'a quote needs its evidence');
  await api('POST', `/api/admin/ly/offers/${O.china.id}/review`, { china_quote: { quote_lyd: 12, evidence: 'Cargo rate card Nov 2026', includes: 'Air freight + clearance' } }, { token: T.owner });
  assert.equal((await api('POST', `/api/admin/ly/offers/${O.china.id}/status`, { status: 'published' }, { token: T.owner })).status, 200);
  const items = (await api('GET', '/api/catalog', null, { country: 'LY', city: C.tripoli.id })).body.items;
  const ch = items.find((p) => p.id === O.china.id);
  assert.equal(ch.route_label.ar, 'يُشحن من الصين'); assert.equal(ch.delivery.min_days, 18);
  assert.equal(items.find((p) => p.id === O.lamp.id).route_label.ar, 'متوفر داخل ليبيا');
  // a route that loses its verification takes the offer down from the shop
  await api('PATCH', `/api/admin/ly/cities/${C.tripoli.id}`, { routes: { china: { ...C.tripoli.routes.china, verified: false } } }, { token: T.owner });
  await api('PATCH', `/api/admin/ly/cities/${C.benghazi.id}`, { routes: { china: { ...C.benghazi.routes.china, verified: false } } }, { token: T.owner });
  assert.ok(!(await api('GET', '/api/catalog', null, { country: 'LY' })).body.items.some((p) => p.id === O.china.id));
  await api('PATCH', `/api/admin/ly/cities/${C.tripoli.id}`, { routes: { china: { ...C.tripoli.routes.china, verified: true } } }, { token: T.owner });
  await api('PATCH', `/api/admin/ly/cities/${C.benghazi.id}`, { routes: { china: { ...C.benghazi.routes.china, verified: true } } }, { token: T.owner });
});

test('select Libya or switch: Libya offers in LYD; a Libya-only offer disappears for Canada', async () => {
  const ly = (await api('GET', '/api/catalog?q=lamp', null, { country: 'LY' })).body;
  assert.equal(ly.items[0].id, O.lamp.id); assert.equal(ly.items[0].currency, 'LYD'); assert.equal(ly.items[0].min_price, 45);
  assert.ok(ly.check_city, 'before a city is chosen: a prompt to check local delivery');
  assert.ok(!('cost_lyd' in ly.items[0]) && !JSON.stringify(ly.items[0]).includes('cost'), 'no margins in the shop');
  const ca = (await api('GET', '/api/catalog?q=lamp', null, { country: 'CA' })).body;
  assert.ok(!ca.items.some((p) => p.id === O.lamp.id), 'not in Canada search');
  assert.equal((await api('GET', `/api/catalog/${O.lamp.id}`, null, { country: 'CA' })).status, 404, 'not in Canada detail');
  const chk = (await api('POST', '/api/cart/check', { country: 'CA', items: [{ listing_id: O.lamp.id, mp_sku_id: O.lamp.variants[0].id, qty: 1 }] })).body;
  assert.equal(chk.lines[0].reason, 'libya_only', 'not in Canada checkout');
  const co = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: O.lamp.id, mp_sku_id: O.lamp.variants[0].id, qty: 1 }], shipping_address: { name: 'A', phone: '+1 555 0100', country_code: 'CA', city: 'Toronto', line1: '1 King', postal_code: 'M5H 2N2' } }, { token: T.a });
  assert.equal(co.status, 409);
  const main = await api('POST', '/api/buyer/checkout', { items: [{ listing_id: O.lamp.id, mp_sku_id: O.lamp.variants[0].id, qty: 1 }], shipping_address: { name: 'A', phone: '+218911111111', country_code: 'LY', city: 'Tripoli', line1: 'x' } }, { token: T.a });
  assert.equal(main.body.code, 'USE_LIBYA_CHECKOUT');
});

test('an offer that delivers to one city: visible there; an unsupported final address cannot pass checkout', async () => {
  const trip = (await api('GET', '/api/catalog', null, { country: 'LY', city: C.tripoli.id })).body.items;
  const ben = (await api('GET', '/api/catalog', null, { country: 'LY', city: C.benghazi.id })).body.items;
  assert.ok(trip.some((p) => p.id === O.lamp.id)); assert.ok(!ben.some((p) => p.id === O.lamp.id), 'local stock is not offered in Benghazi');
  assert.equal(trip.find((p) => p.id === O.lamp.id).delivery.fee_lyd, 10);
  const d = (await api('GET', `/api/catalog/${O.lamp.id}?city=${C.benghazi.id}`, null, { country: 'LY' })).body;
  assert.equal(d.availability.available, false); assert.equal(d.availability.reason, 'not_delivered_to_city');
  const r = await api('POST', '/api/ly/checkout', { items: [{ offer_id: O.lamp.id, variant_id: O.lamp.variants[0].id, qty: 1 }], recipient: recipient({ city_id: C.benghazi.id, area_id: undefined }) }, { token: T.a });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'NOT_DELIVERABLE'); assert.equal(r.body.details.lines[0].reason, 'route_not_covered');
});

test('checkout: validated phone, area, LYD total with a separate delivery charge per route, COD rules', async () => {
  const items = [{ offer_id: O.lamp.id, variant_id: O.lamp.variants[0].id, qty: 2 }, { offer_id: O.china.id, variant_id: O.china.variants[0].id, qty: 1 }];
  const q = (await api('POST', '/api/ly/quote', { items, city_id: C.tripoli.id, area_id: C.tripoli.areas[0].id })).body;
  assert.deepEqual(q.deliveries.map((d) => [d.route, d.fee_lyd]), [['local', 10], ['china', 27]], 'two deliveries, each with its own charge (China: route fee + import quote)');
  assert.equal(q.totals.total_lyd, 45 * 2 + 60 + 10 + 27);
  assert.equal(q.payment.cod, false); assert.equal(q.payment.cod_reason, 'cod_not_on_route', 'no COD for the imported part by default');
  assert.equal((await api('POST', '/api/ly/checkout', { items, recipient: recipient() }, { token: T.a })).body.code, 'COD_UNAVAILABLE');
  assert.equal((await api('POST', '/api/ly/checkout', { items, recipient: recipient(), payment: 'online' }, { token: T.a })).body.code, 'PAYMENT_UNAVAILABLE', 'online payment off until verified');
  const one = [items[0]];
  assert.equal((await api('POST', '/api/ly/checkout', { items: one, recipient: recipient({ phone: '12345' }) }, { token: T.a })).body.code, 'RECIPIENT_INVALID');
  assert.equal((await api('POST', '/api/ly/checkout', { items: one, recipient: recipient({ area_id: undefined }) }, { token: T.a })).body.code, 'AREA_REQUIRED');
  assert.equal((await api('POST', '/api/ly/checkout', { items: one, recipient: recipient({ area_id: C.tripoli.areas[1].id }) }, { token: T.a })).body.code, 'COD_UNAVAILABLE', 'COD off in that area');
  assert.equal((await api('POST', '/api/ly/checkout', { items: one, recipient: recipient(), expected_total_lyd: 1 }, { token: T.a })).body.code, 'TOTAL_CHANGED');
  const r = await api('POST', '/api/ly/checkout', { items: one, recipient: recipient(), expected_total_lyd: 100 }, { token: T.a });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.recipient.phone, '+218912345678'); assert.equal(r.body.totals.total_lyd, 100); assert.equal(r.body.payment.method, 'cod');
  const saved = db.ly_orders.get(r.body.id);
  assert.equal(saved.quote.deliveries[0].fee_lyd, 10, 'quote breakdown saved on the order');
  assert.deepEqual([saved.delivery_status, saved.payment.status, saved.settlement_status], ['pending_confirmation', 'due_on_delivery', 'expected'], 'three independent statuses');
  assert.equal(db.orders.all().length, 0, 'never a shared (card / supplier) order');
  T.codOrder = r.body.id;
  // a city that needs a map pin
  await api('PATCH', `/api/admin/ly/cities/${C.tripoli.id}`, { require_pin: true }, { token: T.owner });
  assert.equal((await api('POST', '/api/ly/checkout', { items: one, recipient: recipient() }, { token: T.a })).body.code, 'PIN_REQUIRED');
  await api('PATCH', `/api/admin/ly/cities/${C.tripoli.id}`, { require_pin: false }, { token: T.owner });
});

test('two customers try to buy the last local unit: one reservation succeeds; cancellation or expiry releases it once', async () => {
  const items = [{ offer_id: O.last.id, variant_id: O.last.variants[0].id, qty: 1 }];
  const [r1, r2] = await Promise.all([api('POST', '/api/ly/checkout', { items, recipient: recipient() }, { token: T.a }), api('POST', '/api/ly/checkout', { items, recipient: recipient() }, { token: T.b })]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [201, 409]);
  const lost = r1.status === 409 ? r1 : r2; assert.ok(['OUT_OF_STOCK', 'NOT_DELIVERABLE'].includes(lost.body.code));
  const won = (r1.status === 201 ? r1 : r2).body;
  const sid = `${O.last.id}|${O.last.variants[0].id}|${loc.id}`;
  assert.deepEqual([db.ly_stock.get(sid).available, db.ly_stock.get(sid).reserved], [1, 1]);
  assert.ok(!(await api('GET', '/api/catalog', null, { country: 'LY', city: C.tripoli.id })).body.items.some((p) => p.id === O.last.id), 'sold out while reserved');
  // cancellation releases once
  assert.equal((await api('POST', `/api/admin/ly/orders/${won.id}/events`, { type: 'cancel', key: key('c'), reason: 'customer asked' }, { token: T.owner })).status, 200);
  assert.equal(db.ly_stock.get(sid).reserved, 0);
  assert.equal(LYS.release(db.ly_orders.get(won.id).reservation_id, 'again'), false, 'a second release changes nothing');
  assert.equal(db.ly_stock.get(sid).reserved, 0);
  // expiry releases once too
  const again = (await api('POST', '/api/ly/checkout', { items, recipient: recipient() }, { token: T.b })).body;
  const res = db.ly_orders.get(again.id).reservation_id;
  db.ly_reservations.update(res, { expires_at: Date.now() - 1 });
  assert.equal(LYS.releaseExpired(), 1); assert.equal(LYS.releaseExpired(), 0);
  assert.equal(db.ly_stock.get(sid).reserved, 0); assert.equal(db.ly_orders.get(again.id).delivery_status, 'cancelled');
});

test('COD delivered and settled later: delivery, cash collection and settlement recorded independently, duplicates ignored', async () => {
  const id = T.codOrder; const ev = (b) => api('POST', `/api/admin/ly/orders/${id}/events`, b, { token: T.owner });
  assert.equal((await ev({ type: 'deliver', key: key() })).status, 409, 'cannot deliver before dispatch');
  await ev({ type: 'confirm', key: key() }); await ev({ type: 'pack', key: key() });
  await ev({ type: 'dispatch', key: key(), tracking: 'LY-TRK-1', carrier: 'Local courier' });
  const sid = `${O.lamp.id}|${O.lamp.variants[0].id}|${loc.id}`;
  assert.deepEqual([db.ly_stock.get(sid).available, db.ly_stock.get(sid).reserved], [8, 0], 'dispatch takes the reserved units out of stock');
  await ev({ type: 'attempt', key: key(), note: 'no answer' }); await ev({ type: 'reschedule', key: key(), date: '2026-11-25' });
  const k = key('deliver');
  const d1 = (await ev({ type: 'deliver', key: k, cod_collected_lyd: 100, carrier_fee_lyd: 5 })).body;
  const d2 = (await ev({ type: 'deliver', key: k, cod_collected_lyd: 100, carrier_fee_lyd: 5 })).body;
  assert.equal(d1.duplicate, false); assert.equal(d2.duplicate, true);
  assert.equal(db.ly_cash.all((c) => c.order_id === id && c.kind === 'collected').length, 1, 'one cash entry');
  let o = db.ly_orders.get(id);
  assert.deepEqual([o.delivery_status, o.payment.status, o.settlement_status], ['delivered', 'collected', 'collected']);
  // settlement later, with the carrier's reference
  const rk = key('remit');
  const r1 = (await api('POST', '/api/admin/ly/cash/remit', { order_ids: [id], settlement_ref: 'CARRIER-STMT-77', key: rk }, { token: T.owner })).body;
  assert.equal(r1.orders[0].difference_lyd, 0);
  await api('POST', '/api/admin/ly/cash/remit', { order_ids: [id], settlement_ref: 'CARRIER-STMT-77', key: rk }, { token: T.owner });
  assert.equal(db.ly_cash.all((c) => c.order_id === id && c.kind === 'remitted').length, 1, 'remittance recorded once');
  o = db.ly_orders.get(id);
  assert.equal(o.settlement_status, 'remitted');
  const cash = (await api('GET', '/api/admin/ly/cash', null, { token: T.owner })).body;
  assert.deepEqual([cash.collected_lyd, cash.carrier_fees_lyd, cash.remitted_lyd, cash.unsettled_lyd], [100, 5, 95, 0]);
  assert.ok(db.audit.all((a) => a.libya?.kind === 'settlement').length >= 3, 'settlement changes in the audit log');
});

test('staff with catalogue access only: Libya listings yes; settlement, financial exports and other markets no', async () => {
  assert.equal((await api('POST', '/api/admin/staff', { email: 'cat@x.com', password: 'catalog-pass-12', name: 'Libya catalogue', role: 'ly_staff', ly_perms: ['catalog'] }, { token: T.owner })).status, 201);
  T.cat = await login('cat@x.com', 'catalog-pass-12');
  const mine = await api('POST', '/api/admin/ly/offers', { title_ar: 'كوب', title_en: 'Mug', route: 'local', images: ['https://img.example/m.jpg'], variants: [{ props: 'أحمر', price_lyd: 12, cost_lyd: 3 }] }, { token: T.cat });
  assert.equal(mine.status, 200); assert.equal(mine.body.variants[0].cost_lyd, undefined, 'no margins for catalogue staff');
  assert.equal(db.ly_offers.get(mine.body.id).variants[0].cost_lyd, null, 'and cannot set a cost');
  assert.equal((await api('PATCH', `/api/admin/ly/offers/${O.lamp.id}`, { variants: [{ ...O.lamp.variants[0], price_lyd: 47 }] }, { token: T.cat })).status, 200);
  assert.equal(db.ly_offers.get(O.lamp.id).variants[0].cost_lyd, 30, 'the owner\'s cost is kept');
  assert.ok(db.ly_offers.get(O.lamp.id).history.some((h) => h.changes.variants && h.actor.email === 'cat@x.com'), 'price change recorded with actor and time');
  for (const [m, p] of [['GET', '/api/admin/ly/cash'], ['GET', '/api/admin/ly/cash/export'], ['POST', '/api/admin/ly/cash/remit'], ['GET', '/api/admin/ly/orders'], ['GET', '/api/admin/ly/orders/export'], ['POST', '/api/admin/ly/stock'], ['POST', '/api/admin/ly/cities'], ['PATCH', '/api/admin/ly/config']]) {
    assert.equal((await api(m, p, m === 'GET' ? null : {}, { token: T.cat })).status, 403, `${m} ${p}`);
  }
  for (const p of ['/api/admin/orders', '/api/admin/eligibility', '/api/admin/users', '/api/admin/team-orders', '/api/admin/listings']) assert.equal((await api('GET', p, null, { token: T.cat })).status, 403, `other markets: ${p}`);
  const ov = (await api('GET', '/api/admin/ly/overview', null, { token: T.cat })).body;
  assert.deepEqual(ov.functions, ['catalog']); assert.equal(ov.unsettled_cod_lyd, null); assert.equal(ov.orders_by_status, null);
  assert.ok(db.audit.all((a) => a.actor?.email === 'cat@x.com' && a.status === 403).length >= 5, 'refused attempts are audited');
  // the owner widens their access; bulk edit needs a preview with the affected count
  await api('PATCH', `/api/admin/ly/staff/${db.users.find((u) => u.email === 'cat@x.com').id}`, { ly_perms: ['catalog', 'stock'] }, { token: T.owner });
  assert.equal((await api('GET', '/api/admin/ly/stock', null, { token: T.cat })).status, 200);
  const pv = (await api('POST', '/api/admin/ly/offers-bulk', { ids: [O.lamp.id, O.china.id], patch: { price_pct: 10 } }, { token: T.cat })).body;
  assert.equal(pv.preview, true); assert.equal(pv.affected, 2); assert.equal(db.ly_offers.get(O.lamp.id).variants[0].price_lyd, 47, 'preview changes nothing');
  const ap = (await api('POST', '/api/admin/ly/offers-bulk', { ids: [O.lamp.id, O.china.id], patch: { price_pct: 10 }, apply: true }, { token: T.cat })).body;
  assert.equal(ap.affected, 2); assert.equal(db.ly_offers.get(O.lamp.id).variants[0].price_lyd, 51.7);
});

test('returned stock is inspected: only approved units go back to sellable stock; refund and stock changes are audited', async () => {
  // a delivered order of 2 lamps
  const o = (await api('POST', '/api/ly/checkout', { items: [{ offer_id: O.lamp.id, variant_id: O.lamp.variants[0].id, qty: 2 }], recipient: recipient() }, { token: T.a })).body;
  const ev = (type, extra = {}) => api('POST', `/api/admin/ly/orders/${o.id}/events`, { type, key: key(type), ...extra }, { token: T.owner });
  for (const t of ['confirm', 'pack', 'dispatch']) await ev(t);
  await ev('deliver');
  const sid = `${O.lamp.id}|${O.lamp.variants[0].id}|${loc.id}`;
  const before = db.ly_stock.get(sid).available;
  const ret = (await api('POST', `/api/admin/ly/orders/${o.id}/returns`, { lines: [{ line: 0, qty: 2 }], reason: 'changed mind' }, { token: T.owner })).body;
  const insp = (await api('POST', `/api/admin/ly/returns/${ret.id}/inspect`, { results: [{ line: 0, approved_qty: 1, note: 'one scratched' }] }, { token: T.owner })).body;
  assert.equal(insp.inspection[0].approved_qty, 1); assert.equal(insp.inspection[0].rejected_qty, 1);
  assert.equal(db.ly_stock.get(sid).available, before + 1, 'only the approved unit is sellable again');
  assert.equal((await api('POST', `/api/admin/ly/returns/${ret.id}/inspect`, { results: [{ line: 0, approved_qty: 2 }] }, { token: T.owner })).body.duplicate, true);
  assert.equal(db.ly_stock.get(sid).available, before + 1, 'inspection applies once');
  assert.ok(db.ly_moves.all((m) => m.ref === ret.id && m.reason === 'return_inspected').length === 1);
  // refunds: finance only, once, audited
  assert.equal((await api('POST', `/api/admin/ly/returns/${ret.id}/refund`, { amount_lyd: 47 }, { token: T.cat })).status, 403);
  assert.equal((await api('POST', `/api/admin/ly/returns/${ret.id}/refund`, { amount_lyd: 9999 }, { token: T.owner })).status, 400);
  const rf = (await api('POST', `/api/admin/ly/returns/${ret.id}/refund`, { amount_lyd: 51.7, method: 'cash', ref: 'R-1' }, { token: T.owner })).body;
  assert.equal(rf.refund.amount_lyd, 51.7);
  assert.equal((await api('POST', `/api/admin/ly/returns/${ret.id}/refund`, { amount_lyd: 51.7 }, { token: T.owner })).body.duplicate, true);
  assert.ok(db.audit.all((a) => a.libya?.kind === 'refund').length === 1);
  assert.equal(db.ly_orders.get(o.id).delivery_status, 'returned');
});

test('the buyer sees their Libya orders; Admin export and overview are scoped to Libya', async () => {
  const mine = (await api('GET', '/api/ly/orders', null, { token: T.a })).body;
  assert.ok(mine.length >= 2 && mine.every((o) => o.currency === 'LYD'));
  assert.ok(!JSON.stringify(mine).includes('location_id'), 'no internal stock locations for customers');
  const csv = await fetch(`${base}/api/admin/ly/orders/export`, { headers: { Authorization: `Bearer ${T.owner}` } }).then((r) => r.text());
  assert.ok(csv.startsWith('order,created,city,area,status,routes,items,total_lyd'));
  const ov = (await api('GET', `/api/admin/ly/overview?city=${C.tripoli.id}`, null, { token: T.owner })).body;
  assert.equal(ov.market_open, true); assert.ok(ov.orders_by_status.delivered >= 1 || ov.orders_by_status.returned >= 1); assert.ok(Array.isArray(ov.low_stock));
});

test('Libya inbound cartons reconcile split orders and preserve tracking on a repeated receipt', async () => {
  const order = db.ly_orders.insert({
    delivery_status: 'confirmed',
    lines: [{ route: 'china', qty: 3, title: 'Test headphones', variant_id: 'test-variant' }],
  });
  const owner = { token: T.owner };
  const buyer = { token: T.a };
  const route = '/api/admin/ly/inbound';
  const scan = (code, credentials = owner) => api('GET', route + '/scan?code=' + encodeURIComponent(code), null, credentials);
  const register = (tracking, qty) => api('POST', route, {
    tracking, source_tracking: ['TEST-SOURCE'], items: [{ order_id: order.id, line_index: 0, qty }],
  }, owner);
  const receive = (code, quantities) => api('POST', route + '/receive', { code, quantities }, owner);
  const stages = () => (db.ly_orders.get(order.id).customer_tracking || []).map((event) => event.stage);

  assert.equal((await scan('TEST-CARTON-A', buyer)).status, 403);
  assert.equal((await scan('TEST-CARTON-A')).body.status, 'unmatched');
  assert.equal((await register('test-carton-a', 2)).body.status, 'expected');
  assert.equal((await scan(' test-carton-a ')).body.label, null);
  assert.equal((await scan('test-source')).body.tracking, 'TEST-CARTON-A');
  assert.equal((await register('TEST-CARTON-B', 2)).status, 409);
  assert.equal((await register('TEST-CARTON-B', 1)).status, 200);
  assert.equal((await scan('TEST-SOURCE')).status, 409);

  assert.equal((await receive('TEST-CARTON-A', [1])).status, 409);
  assert.deepEqual(stages(), []);
  const first = await receive('TEST-CARTON-A', [2]);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'received');
  assert.match(first.body.label, /^KN-LY-/);
  assert.deepEqual(stages(), ['libya_partial']);
  assert.equal((await scan(first.body.label)).body.tracking, 'TEST-CARTON-A');

  assert.equal((await receive('TEST-CARTON-B', [1])).status, 200);
  assert.deepEqual(stages(), ['libya_partial', 'libya_received']);
  assert.equal((await receive(first.body.label, [2])).body.received_at, first.body.received_at);
  assert.deepEqual(stages(), ['libya_partial', 'libya_received']);
});

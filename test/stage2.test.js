// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Bought together (bundle saving), delivery dates, AI review summary, gift cards and part-wallet payments. Fake Stripe + Gemini. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stage2-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_t', GEMINI_API_KEY: 'g-test', AI_AUTO_REVIEW: 'off', CAMPAIGNS_JSON: '[]', XMAS_AUTO: '0' });
delete process.env.CJ_API_KEY; delete process.env.ANTHROPIC_API_KEY;

const intents = {}; let n = 0; let AI = () => ({});
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname.includes('generativelanguage')) {
    const body = JSON.parse(opts.body); const text = body.contents[0].parts.map((x) => x.text || '').join('\n');
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(AI(text)) }] } }], usageMetadata: {} }) };
  }
  if (u.hostname !== 'api.stripe.com') return realFetch(url, opts);
  const method = opts.method || 'GET'; const b = new URLSearchParams(opts.body || '');
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.pathname === '/v1/payment_intents' && method === 'POST') {
    const id = `pi_${++n}`;
    intents[id] = { id, amount: Number(b.get('amount')), currency: b.get('currency'), status: 'requires_payment_method', client_secret: `${id}_secret`, metadata: { order_id: b.get('metadata[order_id]') }, livemode: false };
    return ok(intents[id]);
  }
  let m = u.pathname.match(/^\/v1\/payment_intents\/(pi_\d+)$/);
  if (m && method === 'GET') return ok(intents[m[1]]);
  m = u.pathname.match(/^\/v1\/payment_intents\/(pi_\d+)\/cancel$/);
  if (m) { intents[m[1]].status = 'canceled'; return ok(intents[m[1]]); }
  if (u.pathname === '/v1/refunds') return ok({ id: 're_1' });
  if (u.pathname.startsWith('/v1/customers')) return ok({ data: [] });
  throw new Error(`unexpected ${method} ${u.pathname}`);
};
const succeed = (id) => Object.assign(intents[id], { status: 'succeeded', amount_received: intents[id].amount });

const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token, headers = {}) {
  const res = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
function hook(pi) {
  const body = JSON.stringify({ id: `evt_${pi.id}_${Math.random()}`, type: 'payment_intent.succeeded', data: { object: pi } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_t').update(`${t}.${body}`).digest('hex');
  return api('POST', '/webhooks/stripe', body, null, { 'Stripe-Signature': `t=${t},v1=${sig}` });
}
const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
let A; let B; let cust; let friend;
const addr = { name: 'C', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' };

test('bought together: shown on the product, bundle saving at checkout', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('sel@x.com', 'sellerpass');
  const mk = async (title, price) => { const p = (await api('POST', '/api/seller/products/manual', { title, category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants: [{ name: 'One', price, stock: 10 }] }, sel)).body; await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss); return p; };
  A = await mk('Table Lamp', 20); B = await mk('LED Bulb Pack', 10);
  AI = (text) => (/bought_together|Main product/.test(text) ? { picks: [0] } : {});
  const first = (await api('GET', `/api/catalog/${A.id}/together`)).body;
  assert.ok(Array.isArray(first.items));
  for (let i = 0; i < 20 && !db.listings.get(A.id).together; i++) await wait(50); // the AI runs in the background
  const t = (await api('GET', `/api/catalog/${A.id}/together`)).body;
  assert.deepStrictEqual(t.items.map((x) => x.id), [B.id]);
  assert.strictEqual(t.pct, 5);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'C' });
  cust = await login('c@x.com', 'buyerpass1');
  const items = [{ listing_id: A.id, mp_sku_id: A.skus[0].mp_sku_id, qty: 1 }, { listing_id: B.id, mp_sku_id: B.skus[0].mp_sku_id, qty: 1 }];
  const q = (await api('POST', '/api/shipping/quote', { items, country_code: 'SA' })).body;
  assert.strictEqual(q.bundle_discount, 0.5, '5% off the bulb bought with the lamp');
  const o = (await api('POST', '/api/buyer/checkout', { items, shipping_address: addr }, cust)).body;
  assert.strictEqual(o.bundle_discount, 0.5);
  assert.strictEqual(o.total, Math.round((o.subtotal + o.shipping_fee - 0.5) * 100) / 100);
  const alone = (await api('POST', '/api/shipping/quote', { items: [items[0]], country_code: 'SA' })).body;
  assert.ok(!alone.bundle_discount, 'no saving for one item');
});

test('gift card: bought by card, emailed, added to a wallet once; wallet pays part, card the rest', async () => {
  const bad = await api('POST', '/api/buyer/giftcards', { amount: 2, to_email: 'f@x.com' }, cust);
  assert.strictEqual(bad.status, 400);
  const gc = (await api('POST', '/api/buyer/giftcards', { amount: 25, currency: 'USD', to_email: 'Friend@X.com', to_name: 'Sam', from_name: 'C', message: 'Happy Christmas' }, cust)).body;
  assert.ok(gc.client_secret);
  const pi = Object.values(intents).find((x) => x.metadata.order_id === gc.id);
  assert.strictEqual(pi.amount, 2500);
  await hook(succeed(pi.id)); await wait();
  const card = db.giftcards.get(gc.id);
  assert.strictEqual(card.status, 'active');
  assert.match(card.code, /^KINAN-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(db.mail.find((m) => m.to === 'friend@x.com' && /gift card/i.test(m.subject)), 'emailed to the friend');
  assert.strictEqual((await api('POST', `/api/buyer/giftcards/${gc.id}/confirm`, null, cust)).body.status, 'active', 'confirm is idempotent');
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'friend@x.com', password: 'buyerpass2', name: 'Sam' });
  friend = await login('friend@x.com', 'buyerpass2');
  assert.strictEqual((await api('POST', '/api/buyer/giftcards/redeem', { code: 'KINAN-AAAA-BBBB' }, friend)).status, 404);
  const r = (await api('POST', '/api/buyer/giftcards/redeem', { code: card.code.toLowerCase().replace(/-/g, ' ') }, friend)).body;
  assert.strictEqual(r.added, 25);
  assert.strictEqual(r.balance, 25);
  assert.strictEqual((await api('POST', '/api/buyer/giftcards/redeem', { code: card.code }, friend)).status, 409, 'only once');
  // spend: order bigger than the wallet → wallet part + card rest
  const o = (await api('POST', '/api/buyer/checkout', { items: [{ listing_id: A.id, mp_sku_id: A.skus[0].mp_sku_id, qty: 2 }], shipping_address: addr }, friend)).body;
  const full = o.total;
  assert.ok(full > 25);
  const w = (await api('POST', `/api/buyer/orders/${o.id}/apply-wallet`, null, friend)).body;
  assert.strictEqual(w.wallet_applied, 25);
  assert.strictEqual(w.total, Math.round((full - 25) * 100) / 100);
  const cp = (await api('POST', `/api/buyer/orders/${o.id}/card-payment`, null, friend)).body;
  const pi2 = intents[cp.client_secret.replace('_secret', '')];
  assert.strictEqual(pi2.amount, Math.round((full - 25) * 100), 'the card pays only the rest');
  await hook(succeed(pi2.id)); await wait();
  assert.strictEqual(db.orders.get(o.id).status !== 'pending_payment', true);
  assert.strictEqual((await api('GET', '/api/buyer/wallet', null, friend)).body.balance, 0, 'the wallet part was taken when the card paid');
  // cancel → card refunded and the wallet part comes back
  await require('../src/services/orders').cancelOrder(o.id, 'admin');
  assert.strictEqual((await api('GET', '/api/buyer/wallet', null, friend)).body.balance, 25);
});

test('delivery dates and the Christmas cut-off', () => {
  const catalog = require('../src/services/catalog');
  const l = db.listings.insert({ seller_id: 'x', source: 'cj', status: 'active', title: 'Bauble', cj_from: 'DE', skus: [{ cj_vid: 'V1', mp_sku_id: 'cj_V1', price: 5, stock: 5 }], cj_ship: { GB: { fee: 3, vid: 'V1', at: Date.now(), min: 4, max: 6 } } });
  const now = Date.UTC(2026, 11, 10, 10); // Thu 10 Dec
  const d = catalog.delivery(l.id, 'GB', now);
  assert.strictEqual(d.min_days, 4); assert.strictEqual(d.max_days, 6); assert.ok(d.known);
  assert.strictEqual(new Date(d.from).getUTCDate(), 15); assert.strictEqual(new Date(d.to).getUTCDate(), 17);
  assert.ok(d.christmas.before);
  const late = catalog.delivery(l.id, 'GB', Date.UTC(2026, 11, 21, 10));
  assert.strictEqual(late.christmas.before, false);
  const guess = catalog.delivery(l.id, 'FR', now);
  assert.ok(!guess.known && guess.max_days === 8, 'EU warehouse to EU: typical 3–8 days');
  assert.deepStrictEqual(catalog.delivery(l.id, null), { country: null });
});

test('AI review summary: from 3 written reviews, redone after 3 more', async () => {
  const growth = require('../src/services/growth');
  const l = db.listings.insert({ seller_id: 'x', source: 'cj', status: 'active', title: 'Fairy Lights', skus: [{ mp_sku_id: 'f1', price: 9, stock: 5 }] });
  const add = (rating, text) => db.reviews.insert({ listing_id: l.id, user_id: 'u', name: 'A', rating, text, photos: [], status: 'published' });
  add(5, 'Very bright and pretty lights'); add(4, 'Lovely warm colour, cable a bit short');
  assert.ok(!growth.reviewsFor(l.id).summary, 'not with 2');
  add(5, 'Great value, bright and easy to hang');
  let asked = 0;
  AI = (text) => { asked++; assert.match(text, /bright/); return { text: 'Customers love how bright they are. Some find the cable short.', text_ar: 'يحب العملاء سطوعها.', tags: [{ label: 'Bright', label_ar: 'ساطعة', good: true }, { label: 'Short cable', label_ar: 'سلك قصير', good: false }] }; };
  growth.reviewsFor(l.id);
  for (let i = 0; i < 20 && !db.listings.get(l.id).review_summary; i++) await wait(50);
  const s = growth.reviewsFor(l.id).summary;
  assert.match(s.text, /bright/); assert.strictEqual(s.based_on, 3); assert.strictEqual(s.tags.length, 2);
  growth.reviewsFor(l.id); await wait(100);
  assert.strictEqual(asked, 1, 'not redone until 3 more reviews');
});

test('eBay card picture: the owner uploads one, sellers see it; only images, and it can be removed', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  assert.strictEqual((await api('PUT', '/api/admin/ebay/icon', { image: 'data:text/html;base64,PGI+' }, boss)).status, 400);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const r = (await api('PUT', '/api/admin/ebay/icon', { image: `data:image/png;base64,${png}` }, boss)).body;
  assert.match(r.icon, /^\/brand\/ebay-icon\?v=\d+$/);
  const img = await realFetch(base + r.icon);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.strictEqual((await api('GET', '/api/config/public')).body.ebay_icon, r.icon);
  await api('PUT', '/api/admin/ebay/icon', { image: '' }, boss);
  assert.strictEqual((await api('GET', '/api/config/public')).body.ebay_icon, null);
  assert.strictEqual((await realFetch(`${base}/brand/ebay-icon`)).status, 404);
});

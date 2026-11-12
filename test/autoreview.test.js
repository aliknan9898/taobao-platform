// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Automatic AI review against a fake Gemini API: request shape, text and photo fixes, blocked products,
   Kinan's own products going live after the check, re-review on change, undo, quota pause. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autoreview-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', GEMINI_API_KEY: 'gem-test', AI_REVIEW_GAP_MS: '0' });
delete process.env.ANTHROPIC_API_KEY;

const calls = []; let mode = 'ok';
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://img.example.com/')) return new Response(Buffer.from('fakejpeg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  if (!u.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(url, opts);
  const body = JSON.parse(opts.body); calls.push({ url: u, headers: opts.headers, body });
  if (mode === 'broken') return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } }), { status: 400 });
  if (mode === 'quota') return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }), { status: 429 });
  const prompt = body.contents[0].parts.at(-1).text;
  const fake = /rolex/i.test(prompt)
    ? { decision: 'block', block_reason: 'Replica watch with a fake brand logo', title: 'Watch', description: 'x', title_ar: '', description_ar: '', keywords: [], category: 'men', photos: [], main_photo: 1, notes: [] }
    : { decision: 'ok', block_reason: '', title: 'Women’s Hooded Winter Puffer Jacket', description: 'Warm short puffer jacket with a hood.\n• Padded cotton filling\n• Loose fit<b>',
      title_ar: 'جاكيت شتوي منفوخ بقبعة للنساء', description_ar: 'جاكيت دافئ.', keywords: ['Puffer Jacket', 'winter coat', 'women jacket', 'جاكيت'], category: 'women',
      photos: [{ index: 1, verdict: 'remove', issue: 'Another shop logo' }, { index: 2, verdict: 'good', issue: '' }, { index: 3, verdict: 'fix', issue: 'Chinese text' }], main_photo: 2, notes: ['Options look like different products'] };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(fake) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
const ar = require('../src/services/autoreview');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const sku = (price) => ({ mp_sku_id: '1', props: 'Blue / M', price, stock: 5 });

test('every product is reviewed by the AI: text, photos, blocked items, own products go live, undo', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('sel@x.com', 'sellerpass');

  const imgs = ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg', 'https://img.example.com/3.jpg'];
  const jacket = db.listings.insert({ seller_id: reg.seller_id, source: 'cj', fulfillment: 'direct', status: 'active', title: 'Fashion Hooded Down Cotton Jacket Women Short Loose 2024 New Hot', description: '<p>cotton</p>', images: imgs, own_images: [], currency: 'USD', skus: [sku(14.99)], category: 'other' });
  const fake = db.listings.insert({ seller_id: reg.seller_id, source: 'aliexpress', fulfillment: 'direct', status: 'pending_review', review: { state: 'pending' }, title: 'Rolex style luxury watch men', description: '', images: ['https://img.example.com/r.jpg'], own_images: [], currency: 'USD', skus: [sku(20)] });
  const kinan = require('../src/services/buyforme').systemSeller();
  const own = db.listings.insert({ seller_id: kinan.id, source: 'cj', fulfillment: 'direct', title: 'Fashion Hooded Down Cotton Jacket', description: 'cotton', images: imgs, own_images: [], currency: 'USD', skus: [sku(19.99)], ...ar.holdOwn() });
  assert.strictEqual(own.status, 'pending_review', 'Kinan’s own new product waits for the AI');
  const xmasWaiting = db.listings.insert({ seller_id: kinan.id, source: 'cj', status: 'active', title: 'Xmas lights', images: imgs, currency: 'USD', skus: [sku(5)], xmas: { copy: 'supplier' } });

  assert.deepStrictEqual(ar.queue().map((l) => l.id).sort(), [jacket.id, fake.id, own.id].sort(), 'Christmas products wait for their own copy first');
  assert.strictEqual(await ar.tick(), 3);

  // Request sent to Gemini
  const c = calls[0];
  assert.match(c.url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.strictEqual(c.headers['x-goog-api-key'], 'gem-test');
  assert.strictEqual(c.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(c.body.generationConfig.responseJsonSchema.properties.photos);
  assert.match(c.body.systemInstruction.parts[0].text, /Do not mention China/);
  assert.ok(calls.some((x) => x.body.contents[0].parts.filter((p) => p.inline_data).length === 3), 'photos are sent inline');

  // Text and photos fixed, Arabic kept from the AI (no re-translation), not reviewed twice
  const j = db.listings.get(jacket.id);
  assert.strictEqual(j.title, 'Women’s Hooded Winter Puffer Jacket');
  assert.ok(!/<b>/.test(j.description));
  assert.deepStrictEqual(j.keywords, ['puffer jacket', 'winter coat', 'women jacket', 'جاكيت']);
  assert.strictEqual(j.category, 'women');
  assert.deepStrictEqual(j.images, [imgs[1], imgs[2]], 'logo photo removed, best photo first, text photo last');
  assert.strictEqual(j.title_ar, 'جاكيت شتوي منفوخ بقبعة للنساء');
  assert.strictEqual(j.ar_src, require('../src/services/translate').fingerprint(j));
  assert.strictEqual(j.status, 'active');
  assert.strictEqual(j.ai_review.decision, 'ok'); assert.strictEqual(j.ai_review.removed_photos, 1);
  assert.deepStrictEqual(j.ai_review.notes, ['Options look like different products']);
  assert.strictEqual(ar.needsReview(j), false);

  // Counterfeit stopped with the reason the seller sees
  const f = db.listings.get(fake.id);
  assert.strictEqual(f.status, 'rejected');
  assert.match(f.review.reason, /^AI check: Replica watch/);
  assert.strictEqual(f.title, 'Rolex style luxury watch men', 'a stopped product keeps its text for the seller to fix');

  // Kinan's own product went live after the check
  const o = db.listings.get(own.id);
  assert.strictEqual(o.status, 'active'); assert.strictEqual(o.review.decided_by, 'ai');
  assert.strictEqual(db.listings.get(xmasWaiting.id).ai_review, undefined);

  // Seller sees the check, not the stored "before" copy
  const mine = (await api('GET', '/api/seller/products', null, sel)).body;
  const mj = mine.find((x) => x.id === jacket.id);
  assert.strictEqual(mj.ai_review.decision, 'ok'); assert.strictEqual(mj.ai_review.before, undefined);

  // Admin dashboard
  const st = (await api('GET', '/api/admin/ai-review', null, boss)).body;
  assert.strictEqual(st.provider, 'gemini'); assert.strictEqual(st.reviewed, 3); assert.strictEqual(st.stopped, 1); assert.strictEqual(st.waiting, 0); assert.strictEqual(st.today, 3);

  // A change (re-import, seller edit) is reviewed again
  db.listings.update(jacket.id, { title: 'Supplier title again' });
  assert.strictEqual(ar.needsReview(db.listings.get(jacket.id)), true);
  db.listings.update(jacket.id, { title: j.title });

  // Undo puts it back and it is not reviewed again until it changes
  const u = await api('POST', `/api/admin/listings/${jacket.id}/ai-undo`, null, boss);
  assert.strictEqual(u.status, 200, JSON.stringify(u.body));
  const back = db.listings.get(jacket.id);
  assert.strictEqual(back.title, 'Fashion Hooded Down Cotton Jacket Women Short Loose 2024 New Hot');
  assert.deepStrictEqual(back.images, imgs);
  assert.strictEqual(ar.needsReview(back), false);
  const uf = await api('POST', `/api/admin/listings/${fake.id}/ai-undo`, null, boss);
  assert.strictEqual(uf.status, 200);
  assert.strictEqual(db.listings.get(fake.id).status, 'pending_review', 'undoing a stop sends it back to the admin');

  // Free quota used up: pause, no failure recorded
  mode = 'quota';
  const next = db.listings.insert({ seller_id: reg.seller_id, source: 'cj', status: 'active', title: 'Thermal gloves touch screen', description: '', images: [imgs[0]], currency: 'USD', skus: [sku(9)] });
  assert.strictEqual(await ar.tick(), 0);
  assert.strictEqual(db.listings.get(next.id).ai_review, undefined);
  assert.ok((await api('GET', '/api/admin/ai-review', null, boss)).body.paused_until > Date.now());

  // Kinan products are never kept hidden for ever: after 3 failed checks, after 24 hours, or when the AI is switched off
  mode = 'broken';
  const held1 = db.listings.insert({ seller_id: kinan.id, source: 'cj', title: 'Held product one', images: [imgs[0]], currency: 'USD', skus: [sku(5)], ...ar.holdOwn() });
  for (let i = 0; i < 3; i++) await ar.reviewListing(held1.id).catch(() => {});
  assert.strictEqual(db.listings.get(held1.id).status, 'active', 'goes live after 3 failed checks');
  assert.match(db.listings.get(held1.id).review.note, /without AI check/);
  const held2 = db.listings.insert({ seller_id: kinan.id, source: 'cj', title: 'Held product two', images: [imgs[0]], currency: 'USD', skus: [sku(5)], ...ar.holdOwn() });
  db.listings.update(held2.id, (x) => ({ ...x, review: { ...x.review, submitted_at: Date.now() - 25 * 3600e3 } }));
  const held3 = db.listings.insert({ seller_id: kinan.id, source: 'cj', title: 'Held product three', images: [imgs[0]], currency: 'USD', skus: [sku(5)], ...ar.holdOwn() });
  await ar.tick({ max: 0 });
  assert.strictEqual(db.listings.get(held2.id).status, 'active', 'goes live after 24 hours');
  assert.strictEqual(db.listings.get(held3.id).status, 'pending_review');
  process.env.AI_AUTO_REVIEW = 'off';
  assert.strictEqual(ar.holdOwn(), null, 'nothing is held when the review is off');
  await ar.tick();
  assert.strictEqual(db.listings.get(held3.id).status, 'active', 'held products go live when the review is switched off');
  delete process.env.AI_AUTO_REVIEW;

  // Sellers cannot use the admin routes
  assert.strictEqual((await api('POST', '/api/admin/ai-review/run', null, sel)).status, 403);
});

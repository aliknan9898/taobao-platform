// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* AI listing assistant against a fake Anthropic API: request shape, cleaned answer, daily limit, keywords make products findable. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', ANTHROPIC_API_KEY: 'sk-ant-test', AI_DAILY_LIMIT: '3' });

const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, opts);
  const body = JSON.parse(opts.body); calls.push({ headers: opts.headers, body });
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: 'listing_suggestions', input: {
    title: 'Waterproof Fleece-Lined Hiking Jacket', description: 'Warm jacket for cold days.\n• Fleece lining\n• Water-resistant shell<script>',
    title_ar: 'جاكيت تخييم مبطن مقاوم للماء', description_ar: 'جاكيت دافئ.', keywords: ['Hiking Jacket', 'hiking jacket', 'waterproof', 'جاكيت', 'x'],
    category: 'men', photos: [{ index: 1, verdict: 'remove', issues: ['Watermark from another shop'] }, { index: 2, verdict: 'weird', issues: [] }], tips: ['Add a size chart']
  } }] }) };
};

const auth = require('../src/auth');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('AI assistant suggests a cleaned listing, checks photos and respects the daily limit', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('sel@x.com', 'sellerpass');

  assert.strictEqual((await api('GET', '/api/config/public')).body.ai, true);
  const r = await api('POST', '/api/seller/ai/listing', { title: 'jacket 冲锋衣 waterproof', description: '', options: ['Black / XL'], category: 'men', images: [IMG, 'https://img.example.com/a.jpg', 'javascript:alert(1)'], lang: 'ar' }, sel);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const call = calls[0];
  assert.strictEqual(call.headers['x-api-key'], 'sk-ant-test');
  assert.deepStrictEqual(call.body.tool_choice, { type: 'tool', name: 'listing_suggestions' });
  const content = call.body.messages[0].content;
  assert.strictEqual(content.filter((c) => c.type === 'image').length, 2, 'bad image links are dropped');
  assert.strictEqual(content[0].source.type, 'base64'); assert.strictEqual(content[1].source.type, 'url');
  assert.match(call.body.system, /Arabic/); assert.match(call.body.system, /Do not mention China/);
  assert.ok(!/<script>/.test(r.body.description), 'no HTML');
  assert.deepStrictEqual(r.body.keywords, ['hiking jacket', 'waterproof', 'جاكيت'], 'lower case, unique, no 1-letter words');
  assert.strictEqual(r.body.category, 'men');
  assert.deepStrictEqual(r.body.photos.map((p) => p.verdict), ['remove', 'good']);
  assert.strictEqual(r.body.uses_left_today, 2);

  // Keywords saved on the product make it findable
  const p = (await api('POST', '/api/seller/products/manual', { title: r.body.title, description: r.body.description, keywords: r.body.keywords.join(', '), category: 'men', images: [IMG], variants: [{ name: 'One', price: 30, stock: 5 }] }, sel)).body;
  assert.deepStrictEqual(p.keywords, ['hiking jacket', 'waterproof', 'جاكيت']);
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);
  const found = (await api('GET', '/api/catalog?q=waterproof')).body;
  assert.ok((found.items || found).some((x) => x.id === p.id), 'found by keyword');

  // Daily limit
  await api('POST', '/api/seller/ai/listing', { title: 'jacket' }, sel);
  await api('POST', '/api/seller/ai/listing', { title: 'jacket' }, sel);
  assert.strictEqual((await api('POST', '/api/seller/ai/listing', { title: 'jacket' }, sel)).status, 429);
  // Buyers cannot use it
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'b@x.com', password: 'buyerpass1', name: 'B' });
  assert.strictEqual((await api('POST', '/api/seller/ai/listing', { title: 'jacket' }, await login('b@x.com', 'buyerpass1'))).status, 403);
});

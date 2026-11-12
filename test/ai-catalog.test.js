// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* AI for Kinan's own catalogue: off without a key, batch rewrite with undo, usage/cost counting, admin card data. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aicat-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example' });
delete process.env.ANTHROPIC_API_KEY; delete process.env.AI_MODEL;

const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, opts);
  const body = JSON.parse(opts.body); calls.push(body);
  const n = (body.messages[0].content.match(/^#\d+/gm) || []).length;
  return { ok: true, status: 200, json: async () => ({ usage: { input_tokens: 10000, output_tokens: 4000 }, content: [{ type: 'tool_use', name: 'product_copy', input: { products: Array.from({ length: n }, (_, i) => ({ index: i + 1, title: `Lovely Product Number ${i + 1}`, description: 'Nice.\n• Fact', title_ar: 'منتج', description_ar: 'وصف', keywords: ['gift'], ad_line: 'x' })) } }] }) };
};

const auth = require('../src/auth');
const db = require('../src/db');
const ai = require('../src/services/ai');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('Kinan catalogue copy: waits for the key, rewrites in batches, counts cost, can undo', async () => {
  const kinan = require('../src/services/buyforme').systemSeller();
  const mk = (i, extra = {}) => db.listings.insert({ seller_id: kinan.id, source: 'cj', status: 'active', title: `NEW Hot Sale Item ${i} Cross-border`, description: 'supplier text', skus: [{ mp_sku_id: `s${i}`, price: 5, stock: 3, props: 'Red' }], ...extra });
  const ids = Array.from({ length: 10 }, (_, i) => mk(i).id);
  mk(99, { xmas: { copy: 'template' } }); // seasonal products are left to the Christmas job
  const boss = (await api('POST', '/api/auth/login', { email: 'boss@x.com', password: 'adminpass1' })).body.token;

  let st = (await api('GET', '/api/admin/ai', null, boss)).body;
  assert.strictEqual(st.enabled, false); assert.strictEqual(st.model, 'claude-haiku-5-5'); assert.strictEqual(st.pending, 10);
  assert.deepStrictEqual(await ai.improveKinan(), { done: 0, left: 10 }, 'nothing happens without a key');
  assert.strictEqual(calls.length, 0);

  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const r = (await api('POST', '/api/admin/ai/improve', {}, boss)).body;
  assert.deepStrictEqual(r, { done: 10, left: 0 });
  assert.strictEqual(calls.length, 2, '8 + 2 products in two calls'); assert.strictEqual(calls[0].model, 'claude-haiku-5-5');
  const l = db.listings.get(ids[0]);
  assert.strictEqual(l.title, 'Lovely Product Number 1'); assert.strictEqual(l.title_ar, 'منتج'); assert.strictEqual(l.ai_prev.title, 'NEW Hot Sale Item 0 Cross-border');

  st = (await api('GET', '/api/admin/ai', null, boss)).body;
  assert.strictEqual(st.today.calls, 2); assert.strictEqual(st.today.kinds.copy, 2);
  assert.strictEqual(st.today.cost, 0.006, '2 × (10k × $0.10 + 4k × $0.50) / 1M');

  await api('POST', `/api/admin/ai/undo/${ids[0]}`, {}, boss);
  assert.strictEqual(db.listings.get(ids[0]).title, 'NEW Hot Sale Item 0 Cross-border');
  assert.strictEqual(ai.status().pending, 0, 'an undone product is not rewritten again');

  await api('PUT', '/api/admin/ai', { auto: false }, boss);
  mk(50); assert.strictEqual(await ai.tick(), null, 'automatic rewriting can be switched off');
  delete process.env.ANTHROPIC_API_KEY;
});

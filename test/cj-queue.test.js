// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* CJ queue: people before background work, retry after "too many requests", variant SKU lookup. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cjq-'));
Object.assign(process.env, { CJ_API_KEY: 'CJ1@api@abcdef999999', CJ_MIN_GAP_MS: '20', CJ_COOL_MS: '30' });
const order = []; let busyOnce = true;
global.fetch = async (url) => {
  const u = new URL(url); const ok = (data) => ({ ok: true, status: 200, json: async () => ({ code: 200, result: true, data }) });
  if (u.pathname.endsWith('/authentication/getAccessToken')) return ok({ accessToken: 't', refreshToken: 'r' });
  if (u.pathname.endsWith('/x')) { order.push(u.searchParams.get('n')); return ok({}); }
  if (u.pathname.endsWith('/busy')) { if (busyOnce) { busyOnce = false; return { ok: false, status: 429, json: async () => ({ code: 1600200, message: 'Too much request' }) }; } return ok({ fine: true }); }
  if (u.pathname.endsWith('/product/query')) {
    if (u.searchParams.get('productSku')) return { ok: true, status: 200, json: async () => ({ code: 1602001, result: false, message: 'Product not found' }) };
    if (u.searchParams.get('variantSku') === 'CJQB188313305EV') return ok({ pid: 'P1', productNameEn: 'Lamp', productSku: 'CJQB1883133', productImage: 'https://img.cj/a.jpg', variants: [{ vid: 'V1', variantSku: 'CJQB188313305EV', variantSellPrice: 3, variantKey: 'Red' }] });
  }
  throw new Error(`unexpected ${u.pathname}`);
};
const db = require('../src/db');
const cj = require('../src/cj/client');

test('interactive CJ calls go before queued background work', async () => {
  await db.init?.();
  await cj.token();
  const bg = cj.background(() => Promise.all([1, 2, 3, 4, 5].map((n) => cj.call('GET', '/x', { query: { n: `bg${n}` } }))));
  await new Promise((r) => setTimeout(r, 5));
  await cj.call('GET', '/x', { query: { n: 'person' } });
  await bg;
  assert.ok(order.indexOf('person') <= 1, `person waited behind background work: ${order}`);
});

test('"too many requests" is retried after a short pause', async () => {
  assert.deepStrictEqual(await cj.call('GET', '/busy'), { fine: true });
});

test('a variant SKU finds its product', async () => {
  const p = await require('../src/services/cj').fetchProduct('CJQB188313305EV');
  assert.strictEqual(p.title || p.name || p.title_en, 'Lamp');
});

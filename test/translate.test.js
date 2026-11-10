// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Arabic translation: automatic via DeepL, refreshed on text change, seller text never overwritten. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
process.env.DEEPL_API_KEY = 'abc:fx';
let calls = 0;
global.fetch = async (url, opts) => {
  calls++;
  assert.strictEqual(String(url), 'https://api-free.deepl.com/v2/translate');
  const b = JSON.parse(opts.body); assert.strictEqual(b.target_lang, 'AR');
  return { ok: true, status: 200, json: async () => ({ translations: b.text.map((t) => ({ text: `AR(${t})` })) }) };
};
const db = require('../src/db');
const tr = require('../src/services/translate');

test('translation lifecycle', async () => {
  await db.init();
  const l = db.listings.insert({ title: '战术冲锋衣', description: 'Warm <b>jacket</b>', status: 'active', skus: [] });
  await tr.translatePending();
  assert.strictEqual(db.listings.get(l.id).title_ar, 'AR(战术冲锋衣)');
  assert.strictEqual(db.listings.get(l.id).description_ar, 'AR(Warm jacket)');
  await tr.translatePending(); assert.strictEqual(calls, 1, 'not again while unchanged');
  db.listings.update(l.id, { title: 'Tactical jacket' });
  await tr.translatePending(); assert.strictEqual(db.listings.get(l.id).title_ar, 'AR(Tactical jacket)');
  db.listings.update(l.id, tr.manualPatch({ title_ar: 'جاكيت تكتيكي', description_ar: 'دافئ' }));
  db.listings.update(l.id, { title: 'Tactical jacket v2' });
  await tr.translatePending(); assert.strictEqual(db.listings.get(l.id).title_ar, 'جاكيت تكتيكي', 'seller text kept');
});

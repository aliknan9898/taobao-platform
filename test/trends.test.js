'use strict';
/* Free trends engine: Google suggestions → phrase bank, rising phrases, shop searches, sourcing queue, product keywords. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
process.env.TRENDS_SEEDS_PER_TICK = '1000';
const db = require('../src/db');
const T = require('../src/services/trends');

// fake Google: every query returns a few product phrases plus junk that must be filtered out
global.fetch = async (u) => {
  const q = decodeURIComponent(new URL(u).searchParams.get('q'));
  const base = q.replace(/^best /, '').replace(/ for$/, '');
  return { ok: true, status: 200, text: async () => JSON.stringify([q, [`${base} rechargeable`, `${base} near me`, `${base} argos`, `nike ${base}`, `${base} for kitchen uk`, base]]) };
};
setTimeout = ((orig) => (fn, ms, ...a) => orig(fn, 0, ...a))(setTimeout);

test('filters', () => {
  assert.strictEqual(T.clean('Garlic Press UK!'), 'garlic press');
  assert.ok(T.okPhrase('garlic press rechargeable'));
  assert.ok(!T.okPhrase('garlic press near me'));
  assert.ok(!T.okPhrase('nike running socks'));
  assert.ok(!T.okPhrase('lamp'));
});

test('daily scan fills the bank; hot keywords feed sourcing; products get phrases', async () => {
  const r = await T.tick({ force: true });
  assert.strictEqual(r.cursor, r.of);
  const top = T.top({ n: 500 });
  assert.ok(top.length > 20);
  assert.ok(top.every((x) => !/near me|argos|nike/.test(x.phrase)));
  assert.ok(top.some((x) => x.phrase === 'garlic press rechargeable'));

  // the shop: a search that found nothing twice becomes a sourcing keyword, first in the queue
  T.logSearch('Electric Spin Scrubber', 0); T.logSearch('electric spin scrubber', 0); T.logSearch('mug', 5);
  const hot = T.hotKeywords({ n: 50 });
  assert.strictEqual(hot[0].kw, 'electric spin scrubber');
  assert.strictEqual(hot[0].why, 'shop search');
  const S = require('../src/services/sourcing');
  const q = S.queue(S.prefs());
  assert.strictEqual(q[0].kw, 'electric spin scrubber');

  // Kinan product gets the real phrases that match it
  const kinan = require('../src/services/buyforme').systemSeller();
  const l = db.listings.insert({ seller_id: kinan.id, status: 'active', title: 'Stainless Garlic Press Rechargeable Electric', collections: ['home-kitchen'], keywords: [], skus: [] });
  assert.ok(T.enrich() >= 1);
  assert.ok(db.listings.get(l.id).keywords.includes('garlic press rechargeable'));
  const st = T.status();
  assert.ok(st.scan.done_today);
  assert.ok(st.popular.length);
});

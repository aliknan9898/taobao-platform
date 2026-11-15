// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Live visitors on Kinan Shop / Seller Center. */
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/services/presence');

test('live counts: heartbeats count for 75 s, closing the tab leaves at once, bad input ignored', () => {
  P.reset(); const t = Date.parse('2026-11-15T10:00:00Z');
  assert.ok(P.ping({ app: 'shop', id: 'aaaaaaaa1' }, t));
  assert.ok(P.ping({ app: 'shop', id: 'aaaaaaaa1' }, t + 1000), 'same tab counted once');
  P.ping({ app: 'shop', id: 'bbbbbbbb2' }, t); P.ping({ app: 'seller', id: 'cccccccc3' }, t);
  assert.strictEqual(P.ping({ app: 'admin', id: 'dddddddd4' }, t), false);
  assert.strictEqual(P.ping({ app: 'shop', id: 'x' }, t), false);
  assert.strictEqual(P.ping({ app: 'shop', id: '<script>alert(1)</script>' }, t), false);
  let c = P.counts(t + 2000); assert.deepStrictEqual([c.shop, c.seller], [2, 1]);
  P.ping({ app: 'shop', id: 'bbbbbbbb2', leave: true }, t + 3000);
  c = P.counts(t + 3000); assert.strictEqual(c.shop, 1); assert.strictEqual(c.peak_today.shop, 2);
  c = P.counts(t + 1000 + P.LIVE_MS + 1); assert.deepStrictEqual([c.shop, c.seller], [0, 0]);
  assert.strictEqual(c.peak_today.shop, 2, 'peak kept for the day');
});

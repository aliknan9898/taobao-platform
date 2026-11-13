// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Google Keyword Planner: connect, ideas, the busiest relevant searches become product keywords. Google is mocked. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-'));
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://kinan.example', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', GOOGLE_ADS_CUSTOMER_ID: '123-456-7890', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '111-222-3333', GOOGLE_ADS_DAILY_CALLS: '3' });
const calls = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  calls.push({ url: u.href, opts });
  if (u.hostname === 'oauth2.googleapis.com') {
    const f = new URLSearchParams(opts.body);
    if (f.get('grant_type') === 'authorization_code') { assert.strictEqual(f.get('redirect_uri'), 'https://kinan.example/oauth/google-ads/callback'); return { ok: true, status: 200, json: async () => ({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 }) }; }
    return { ok: true, status: 200, json: async () => ({ access_token: 'at2', expires_in: 3600 }) };
  }
  if (u.hostname === 'googleads.googleapis.com') {
    assert.match(u.pathname, /^\/v26\/customers\/1234567890:generateKeywordIdeas$/);
    assert.strictEqual(opts.headers['login-customer-id'], '1112223333');
    const b = JSON.parse(opts.body);
    assert.deepStrictEqual(b.geoTargetConstants, ['geoTargetConstants/2826']);
    return { ok: true, status: 200, json: async () => ({ results: [
      { text: 'dog harness', keywordIdeaMetrics: { avgMonthlySearches: '49500', competition: 'HIGH', competitionIndex: '100' } },
      { text: 'no pull dog harness', keywordIdeaMetrics: { avgMonthlySearches: '22200', competition: 'HIGH' } },
      { text: 'harness for dogs', keywordIdeaMetrics: { avgMonthlySearches: '8100', competition: 'HIGH' } },
      { text: 'dogs harness', keywordIdeaMetrics: { avgMonthlySearches: '1000' } },
      { text: 'ruffwear dog harness', keywordIdeaMetrics: { avgMonthlySearches: '5400' } },
      { text: 'julius k9 harness', keywordIdeaMetrics: { avgMonthlySearches: '9900' } },
      { text: 'cat litter', keywordIdeaMetrics: { avgMonthlySearches: '90000' } },
      { text: 'reflective dog vest', keywordIdeaMetrics: { avgMonthlySearches: '5' } }
    ] }) };
  }
  throw new Error(`unexpected ${u.href}`);
};

const db = require('../src/db');
const kw = require('../src/services/keywords');

test('Keyword Planner: busiest relevant Google searches become the keywords', async () => {
  assert.ok(kw.configured()); assert.ok(!kw.connected());
  const link = new URL(kw.authUrl());
  assert.strictEqual(link.searchParams.get('scope'), 'https://www.googleapis.com/auth/adwords');
  assert.strictEqual(link.searchParams.get('access_type'), 'offline');
  await assert.rejects(kw.handleCallback('c', 'bad'), /expired/);
  await kw.handleCallback('c', link.searchParams.get('state'));
  assert.ok(kw.connected());
  const l = db.listings.insert({ title: 'No Pull Dog Harness Reflective Adjustable', keywords: ['dog harness', 'reflective harness'], status: 'active', skus: [] });
  const r = await kw.improve(l.id);
  assert.deepStrictEqual(r.top.map((x) => x.text), ['dog harness', 'no pull dog harness'], 'no other topics, no brands, the same search once (harness for dogs = dog harness), tiny volumes out');
  assert.deepStrictEqual(db.listings.get(l.id).keywords.slice(0, 3), ['dog harness', 'no pull dog harness', 'reflective harness']);
  assert.strictEqual(db.listings.get(l.id).kw_stats.top[0].volume, 49500);
  // cached: a second product with the same seeds costs no call
  const before = calls.filter((c) => c.url.includes('googleads')).length;
  await kw.ideas(['dog harness', 'reflective harness', 'harness reflective', 'pull dog', 'dog harness reflective'].slice(0, 0).concat(kw.seedsFor(db.listings.get(l.id))).slice(0, 0));
  assert.strictEqual(calls.filter((c) => c.url.includes('googleads')).length, before);
  // daily limit
  await kw.ideas(['a b']); await kw.ideas(['c d']);
  await assert.rejects(kw.ideas(['e f']), (e) => e.status === 429);
  assert.strictEqual(kw.status().used_today, 3);
});

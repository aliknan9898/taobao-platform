// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Daily exchange rates: CNY cost rate with safety margin, display currencies, no refetch while fresh. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
delete process.env.CNY_PER_SALE_UNIT;
process.env.FX_CNY_BUFFER_PCT = '2';
let calls = 0;
global.fetch = async (url) => {
  calls++;
  assert.match(String(url), /open\.er-api\.com\/v6\/latest\/USD/);
  return { ok: true, status: 200, json: async () => ({ result: 'success', rates: { USD: 1, CNY: 7.1, SAR: 3.75, AED: 3.6725, EUR: 0.92, XXX: 5 } }) };
};

const db = require('../src/db');
const { config } = require('../src/config');
const fx = require('../src/services/fx');

test('rates refresh, cost margin and display currencies', async () => {
  await db.init();
  await fx.refresh();
  assert.strictEqual(config.cnyRate, 6.958, 'market 7.1 minus 2%');
  const pub = fx.publicRates();
  assert.strictEqual(pub.base, 'USD');
  assert.strictEqual(pub.rates.SAR, undefined, 'only USD, EUR and GBP');
  assert.strictEqual(pub.rates.EUR, 0.9292, 'EUR with the 1% conversion margin');
  assert.deepStrictEqual(['GB', 'MT', 'DE', 'SE', 'SA', 'US', 'EG'].map(fx.currencyFor), ['GBP', 'EUR', 'EUR', 'EUR', 'USD', 'USD', 'USD']);
  await fx.refresh();
  assert.strictEqual(calls, 1, 'fresh rates are not fetched again');
  assert.strictEqual(fx.status().cny_market, 7.1);
});

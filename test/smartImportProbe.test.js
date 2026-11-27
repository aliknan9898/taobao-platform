'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-probe-'));
process.env.DATA_DIR = data;
process.env.DATABASE_URL = '';
delete process.env.SMART_IMPORT_V2_PROBE;
const probe = require('../src/services/smartImportProbe');
const db = require('../src/db');

test.after(() => fs.rmSync(data, { recursive: true, force: true }));

test('probe defaults off, rejects unknown and unsupported operations, and validates inputs', async () => {
  assert.equal(probe.capability('cj').enabled, false);
  await assert.rejects(probe.request('cj', { action: 'discover', q: 'test', country: 'GB' }), { status: 403 });
  process.env.SMART_IMPORT_V2_PROBE = '1';
  await assert.rejects(probe.request('unknown', {}), { status: 404 });
  for (const supplier of ['taobao', '1688', 'buckydrop', 'hiobuy']) {
    await assert.rejects(probe.request(supplier, {}), { status: 501 });
  }
  await assert.rejects(probe.request('cj', { action: 'quote', sku: 'bad', country: 'XX' }), { status: 400 });
  await assert.rejects(probe.request('cj', { action: 'discover', q: 'test', country: 'GB', autoPublish: true }), { status: 400 });
});

test('read adapters share identical calls, persist an isolated operation budget and cool down on 429', async (t) => {
  const cj = require('../src/services/cj');
  const ae = require('../src/services/aeSourcing');
  const bg = require('../src/services/banggood');
  const search = t.mock.method(cj, 'search', async ({ q }) => ({ items: [{ pid: q }] }));
  const freight = t.mock.method(cj, 'freightOptions', async () => [{ fee: 3 }]);
  t.mock.method(ae, 'search', async () => [{ id: '10000000001' }]);
  t.mock.method(bg, 'listProducts', async () => ({ items: [{ pid: '1' }] }));
  const shipment = t.mock.method(bg, 'shipOptions', async () => {
    throw Object.assign(new Error('provider details'), { status: 429 });
  });

  const input = { action: 'discover', q: 'case', country: 'GB' };
  await Promise.all([probe.request('cj', input), probe.request('cj', input)]);
  assert.equal((await probe.request('cj', input)).cached, true);
  assert.equal(freight.mock.callCount(), 0);
  assert.equal(search.mock.callCount(), 1);
  assert.equal((await probe.request('cj', { action: 'quote', sku: 'sample', country: 'GB' })).operationsToday, 2);
  for (let i = 0; i < 10; i++) await probe.request('cj', { ...input, q: 'product-' + i });
  db._reset();
  await assert.rejects(probe.request('cj', { ...input, q: 'over quota' }), { status: 429 });
  assert.equal((await probe.request('aliexpress', input)).operationsToday, 1);
  assert.equal((await probe.request('banggood', { action: 'discover', category: '123' })).supplierPoints, null);
  const quote = { action: 'quote', product: '1', sku: '2', country: 'GB', warehouse: 'CN' };
  await assert.rejects(probe.request('banggood', quote), { status: 429, message: 'Supplier temporarily limited' });
  await assert.rejects(probe.request('banggood', quote), { status: 429, message: 'Supplier probe is cooling down' });
  assert.equal(shipment.mock.callCount(), 1);
  assert.equal(db.listings.peek().length, 0);
});

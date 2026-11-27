'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-smart-import-'));
process.env.DATA_DIR = directory;
process.env.DATABASE_URL = '';
delete process.env.SMART_IMPORT_V2_ENABLED;
const db = require('../src/db');
const auth = require('../src/auth');
const { server } = require('../src/server');
const endpoint = '/api/admin/smart-import';
let base, admin, seller;

test.before(async () => {
  admin = auth.createSession(db.users.insert({ role: 'admin', status: 'active' })).token;
  seller = auth.createSession(db.users.insert({ role: 'seller', status: 'active' })).token;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});

async function request(route = '', { method = 'GET', body, token = admin, contentType = 'application/json' } = {}) {
  const response = await fetch(base + endpoint + route, {
    method, headers: { 'Content-Type': contentType, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

test('only admins may read or edit smart-import, and settings stay supplier-specific', async () => {
  assert.equal((await request('', { token: null })).status, 401);
  assert.equal((await request('/cj/products', { token: seller })).status, 403);
  assert.equal((await request('/cj', { token: seller, method: 'PUT', body: { minSales: 0 } })).status, 403);
  assert.equal((await request('/cj', { method: 'PUT', body: { minSales: 321 } })).status, 200);
  const { data } = await request();
  assert.equal(data.length, 7);
  assert.equal(data.find(({ source }) => source === 'cj').policy.minSales, 321);
  assert.equal(data.find(({ source }) => source === 'taobao').policy.minSales, 1000);
  assert.equal(data[0].gateEnabled, false);
  assert.ok(data.every(({ policy }) => !policy.externalAI && !policy.autoPublish));
  assert.ok(db.audit.all().some((entry) => entry.status === 200 && entry.method === 'PUT' &&
    entry.path === endpoint + '/cj' && entry.fields.includes('minSales')));
});

test('settings rejects non-JSON, unknown suppliers, malformed bodies and enabled flags', async () => {
  assert.equal((await request('/unknown', { method: 'PUT', body: { minSales: 0 } })).status, 404);
  assert.equal((await request('/cj', { method: 'PUT', body: {}, contentType: 'text/plain' })).status, 415);
  for (const input of [null, [], {}, { source: 'taobao' }, { minSales: '4' }, { maxShippingDays: 8.5 },
    { minMargin: -1 }, { externalAI: 'false' }, JSON.parse('{"__proto__":{"minSales":0}}')]) {
    assert.equal((await request('/cj', { method: 'PUT', body: input })).status, 400);
  }
  for (const field of ['autoPublish', 'externalAI']) {
    assert.equal((await request('/cj', { method: 'PUT', body: { [field]: true } })).status, 403);
  }
});

test('dry run rejects supplied evidence and evaluates only a stored listing in the selected supplier', async () => {
  const listing = db.listings.insert({ source: 'cj', title: 'Test', status: 'pending_review',
    cj_listed: 5000, images: ['image'], imageReview: 'pass', complianceReview: 'pass' });
  const body = { listingId: listing.id };
  assert.equal((await request('/taobao/review', { method: 'POST', body })).status, 404);
  for (const evidence of [{ imageReview: 'pass' }, { complianceReview: 'pass' }, { images: ['image'] }, { margin: 1 },
    { note: 'not-for-audit' }]) {
    assert.equal((await request('/cj/review', { method: 'POST', body: { ...body, ...evidence } })).status, 400);
  }
  const { data, status } = await request('/cj/review', { method: 'POST', body });
  assert.equal(status, 200);
  assert.equal(data.status, 'review');
  assert.deepEqual(data.missing, ['shippingDays', 'margin', 'imageReview', 'complianceReview']);
  assert.deepEqual(db.listings.get(listing.id), listing);
  assert.ok(!JSON.stringify(db.audit.all()).includes('not-for-audit'));
});

test('supplier list filters, paginates, and omits raw supplier fields', async () => {
  for (let index = 0; index < 28; index++) db.listings.insert({
    id: 'page_' + index, source: 'banggood', status: 'paused', title: 'Matching product', privateData: 'omitted'
  });
  db.listings.insert({ source: 'cj', status: 'paused', title: 'Matching product' });
  const { data } = await request('/banggood/products?page=2&status=paused&q=matching');
  assert.equal(data.total, 28);
  assert.equal(data.items.length, 3);
  assert.deepEqual(Object.keys(data.items[0]), ['id', 'title', 'status']);
  for (const filter of ['page=0', 'page=1&page=2', 'status=bad', 'foreign=1']) {
    assert.equal((await request('/banggood/products?' + filter)).status, 400);
  }
});

test('publication guard covers legacy inserts, stock recovery, and policy-held writes when enabled', () => {
  const legacy = db.listings.insert({ source: 'cj', status: 'active', skus: [{ price: 29 }] });
  assert.equal(legacy.status, 'active');
  process.env.SMART_IMPORT_V2_ENABLED = '1';
  try {
    const queued = db.listings.insert({ source: 'cj', status: 'active', review: { auto: 'ai' } });
    assert.equal(queued.status, 'pending_review');
    assert.equal(queued.review.auto, undefined);
    assert.throws(() => require('../src/services/catalog').approve(queued.id, { id: 'admin' }), { status: 409 });
    assert.equal(db.listings.update(queued.id, (doc) => ({ ...doc, status: 'active' })).status, 'pending_review');
    const unavailable = db.listings.insert({ taobao_item_id: '123', status: 'unavailable' });
    assert.equal(db.listings.update(unavailable.id, { status: 'active' }).status, 'pending_review');
    assert.equal(db.listings.insert({ source: 'manual', status: 'active' }).status, 'active');
    assert.deepEqual(db.listings.update(legacy.id, { title: 'Revised' }).skus, legacy.skus);
    assert.equal(db.listings.get(legacy.id).status, 'active');
  } finally { delete process.env.SMART_IMPORT_V2_ENABLED; }
});

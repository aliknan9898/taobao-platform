'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

delete process.env.DATABASE_URL;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-ebay-full-'));
const db = require('../src/db');
const auth = require('../src/auth');
const { server } = require('../src/server');
const publisher = require('../src/services/ebayPublisher');
const sync = require('../src/services/ebaySyncBatch');
const setup = require('../scripts/ebay-setup-malta');

const env = {
  EBAY_CLIENT_ID: 'fixture-app', EBAY_CLIENT_SECRET: 'fixture-cert', EBAY_REFRESH_TOKEN: 'fixture-refresh',
  EBAY_MARKETPLACE: 'EBAY_DE', EBAY_CATEGORY_ID: '123', EBAY_FULFILLMENT_POLICY_ID: '100',
  EBAY_PAYMENT_POLICY_ID: '200', EBAY_RETURN_POLICY_ID: '300', EBAY_PUBLISH_ENABLED: '1'
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const product = (id = 'lst_ebay_fixture') => db.listings.insert({
  id, status: 'active', title: 'Fixture lamp', currency: 'EUR', images: ['https://cdn.example.test/lamp.png'],
  skus: [{ mp_sku_id: 'fixture-1', price: 12.5, stock: 3 }]
});
let base;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('HTTP deletion challenge hashes the configured exact endpoint; POST logs receipt and acknowledges', async (t) => {
  const verification = 'fixture_verification_token_for_test';
  const endpoint = 'https://example.test/webhooks/ebay/deletion';
  process.env.EBAY_VERIFICATION_TOKEN = verification;
  process.env.EBAY_DELETION_ENDPOINT = endpoint;
  t.after(() => { delete process.env.EBAY_VERIFICATION_TOKEN; delete process.env.EBAY_DELETION_ENDPOINT; });
  const log = t.mock.method(console, 'info', () => {});
  const path = base + '/webhooks/ebay/deletion';
  const response = await fetch(path + '?challenge_code=sample%2Bcode');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const expected = crypto.createHash('sha256').update('sample+code' + verification + endpoint).digest('hex');
  assert.deepEqual(await response.json(), { challengeResponse: expected });
  assert.equal((await fetch(path)).status, 400);
  const delivered = await fetch(path, { method: 'POST', body: JSON.stringify({ notification: { data: { username: 'fixture-user' } } }) });
  assert.equal(delivered.status, 200);
  assert.deepEqual(await delivered.json(), { ok: true });
  assert.equal(log.mock.callCount(), 1);
  assert.ok(!log.mock.calls[0].arguments.join(' ').includes('fixture-user'));
});

test('preflight rejects invalid photos, missing policies and zero inventory', () => {
  const entry = { sku: 'fixture', title: 'Lamp', price: 12, quantity: 1, imageUrls: ['https://example.test/lamp.jpg'],
    categoryId: 1, listingPolicies: { fulfillmentPolicyId: '2', paymentPolicyId: '3', returnPolicyId: '4' } };
  assert.equal(publisher.validateEbayListing(entry).listing.merchantLocationKey, 'KINAN_MALTA_HQ');
  const invalid = publisher.validateEbayListing({ ...entry, imageUrls: ['http://example.test/lamp.jpg'], listingPolicies: {}, quantity: 0 });
  assert.deepEqual(Object.keys(invalid.issues), ['quantity', 'imageUrls', 'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId']);
  assert.equal(publisher.validateEbayListing({ ...entry, imageUrls: ['https://example.test/proxy/image.jpg?url=fixture'] }).valid, false);
  assert.equal(publisher.validateEbayListing({ ...entry, imageUrls: ['https://example.test/product-page'] }).valid, false);
});

test('OAuth refresh is shared, cached and renewed before expiry', async () => {
  let now = 0;
  let refreshes = 0;
  const client = publisher.createClient({ env, now: () => now, fetcher: async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.sandbox.ebay.com');
    if (url.includes('/oauth2/token')) {
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.ok(options.body.get('refresh_token') === env.EBAY_REFRESH_TOKEN);
      refreshes++;
      return json({ access_token: 'fake-' + refreshes, expires_in: 60 });
    }
    assert.ok(options.headers.Authorization === 'Bearer fake-' + refreshes);
    return json({});
  } });
  await Promise.all([client.request('offer', 'GET', '/probe'), client.request('offer', 'GET', '/probe')]);
  assert.equal(refreshes, 1);
  now = 47000;
  await client.request('offer', 'GET', '/probe');
  assert.equal(refreshes, 1);
  now = 49000;
  await client.request('offer', 'GET', '/probe');
  assert.equal(refreshes, 2);
});

test('publisher performs the three mutations once, persists IDs and reuses a published offer on change', async () => {
  const doc = product();
  const calls = [];
  let status = 'missing';
  const client = publisher.createClient({ env, fetcher: async (url, options) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/token')) return json({ access_token: 'fake-access', expires_in: 1000 });
    assert.equal(options.headers['Content-Language'], 'de-DE');
    calls.push([options.method, pathname]);
    if (options.method === 'GET') return status === 'missing' ? json({ errors: [{ errorId: 25713 }] }, 400) :
      json({ offers: [{ offerId: 'offer-1', marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE', status, listing: { listingId: '123456' } }] });
    if (pathname.endsWith('/publish')) { status = 'PUBLISHED'; return json({ listingId: '123456' }); }
    if (pathname.endsWith('/offer') && options.method === 'POST') { status = 'UNPUBLISHED'; return json({ offerId: 'offer-1' }, 201); }
    return new Response(null, { status: 204 });
  } });
  const options = { client, env };
  const [first, concurrent] = await Promise.all([sync.publishOne(doc.id, options), sync.publishOne(doc.id, options)]);
  assert.equal(first.idempotencyKey, concurrent.idempotencyKey);
  assert.match(first.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.equal(db.listings.get(doc.id).ebay_listing_id, '123456');
  assert.deepEqual(calls.filter(([method]) => method !== 'GET').map(([method, target]) => [method, target.split('/')[4]]),
    [['PUT', 'inventory_item'], ['POST', 'offer'], ['POST', 'offer']]);
  const count = calls.length;
  assert.equal((await sync.publishOne(doc.id, options)).skipped, true);
  assert.equal((await sync.syncBatch({ ids: [doc.id] }, options)).results[0].skipped, true);
  assert.equal(calls.length, count);
  db.listings.update(doc.id, { title: 'Fixture lamp updated' });
  assert.equal((await sync.publishOne(doc.id, options)).ebay_listing_id, '123456');
  assert.equal(calls.at(-1)[0], 'PUT');
  assert.match(calls.at(-1)[1], /offer\/offer-1$/);
});

test('failed publish is classified and a retry reconciles the existing offer', async () => {
  const doc = product('lst_retry_fixture');
  let offerExists = false;
  let creates = 0;
  let attempts = 0;
  const client = { async request(stage, method) {
    if (stage === 'offer' && method === 'GET') return { offers: offerExists ? [{ offerId: 'only', marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE' }] : [] };
    if (stage === 'offer' && method === 'POST') { offerExists = true; creates++; return { offerId: 'only' }; }
    if (stage === 'publish') {
      if (++attempts === 1) throw publisher.stageError('publish', 'Fixture transient failure');
      return { listingId: '654321' };
    }
    return {};
  } };
  await assert.rejects(sync.publishOne(doc.id, { env, client }), { stage: 'publish' });
  assert.equal(db.listings.get(doc.id).ebay_listing_id, undefined);
  assert.equal((await sync.publishOne(doc.id, { env, client })).ebay_listing_id, '654321');
  assert.equal(creates, 1);
});

test('Malta dry-run outputs the correct payload with no transport, and honours overrides', async () => {
  const client = { request() { throw new Error('No request allowed'); } };
  const plan = await setup.run([], { env: {}, client });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.merchantLocationKey, 'KINAN_MALTA_HQ');
  assert.equal(plan.location.merchantLocationStatus, 'ENABLED');
  assert.deepEqual(plan.location.locationTypes, ['WAREHOUSE']);
  assert.deepEqual(Object.values(plan.location.location.address).slice(1), ['Naxxar', 'NXR 6015', 'MT']);
  const child = spawnSync(process.execPath, ['scripts/ebay-setup-malta.js', '--dry-run'], { encoding: 'utf8', env: { DATA_DIR: process.env.DATA_DIR } });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), plan);
  assert.equal((await setup.run(['--dry-run'], { env: { EBAY_LOC_CITY: 'Valletta' }, client })).location.location.address.city, 'Valletta');
});

test('Admin routes are protected, preview by default and require an explicit publication switch', async (t) => {
  const doc = product('lst_ebay_admin_fixture');
  for (const [key,value] of Object.entries({ ...env, EBAY_PUBLISH_ENABLED: '0' })) process.env[key] = value;
  t.after(() => { for (const key of Object.keys(env)) delete process.env[key]; });
  const validate = base + '/api/admin/ebay/validate/' + doc.id;
  assert.equal((await fetch(validate)).status, 401);
  const user = db.users.insert({ role: 'admin', status: 'active', email: 'fixture-admin@example.test' });
  const buyer = db.users.insert({ role: 'buyer', status: 'active', email: 'fixture-buyer@example.test' });
  const headers = { Authorization: 'Bearer ' + auth.createSession(user).token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(validate, { headers: { Authorization: 'Bearer ' + auth.createSession(buyer).token } })).status, 403);
  assert.equal((await fetch(base + '/admin/ebay', { headers })).status, 200);
  assert.equal((await (await fetch(validate, { headers })).json()).valid, true);
  const preview = await fetch(base + '/api/admin/ebay/sync-batch', { method: 'POST', headers, body: JSON.stringify({ ids: [doc.id] }) });
  assert.equal((await preview.json()).dryRun, true);
  const disabled = await fetch(base + '/api/admin/ebay/publish/' + doc.id, { method: 'POST', headers, body: '{}' });
  assert.equal(disabled.status, 423);
  assert.equal((await disabled.json()).stage, 'configuration');
  await assert.rejects(sync.syncBatch({ limit: 11 }), { status: 400 });
});


test('explicit setup execution uses an injected transport and lists existing business policies', async () => {
  const calls = [];
  const client = { async request(stage, method, path, options) {
    calls.push({ stage, method, path, options });
    if (stage === 'location' && method === 'GET') throw Object.assign(new Error('Fixture missing'), { ebayStatus: 404 });
    if (stage === 'policy') {
      const kind = path.split('/').at(-1).replace('_policy', '');
      return { [kind + 'Policies']: [{ [kind + 'PolicyId']: '123', name: 'Fixture policy' }] };
    }
    return {};
  } };
  await assert.rejects(setup.run(['--execute'], { env: {}, client }), { stage: 'configuration' });
  assert.equal(calls.length, 0);
  const locationEnv = { EBAY_LOC_ADDRESS1: 'Fixture street', EBAY_LOC_PHONE: '+356 00000000' };
  const result = await setup.run(['--execute'], { env: locationEnv, client });
  assert.equal(result.existing, false);
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'POST', 'GET', 'GET', 'GET']);
  assert.deepEqual(calls[1].options.body, setup.plan(locationEnv).location);
  assert.deepEqual(Object.keys(result.policies), ['fulfillment', 'payment', 'return']);
  assert.deepEqual(result.policies.payment, [{ id: '123', name: 'Fixture policy' }]);
});

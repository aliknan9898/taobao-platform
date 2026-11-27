'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-shadow-'));
process.env.DATABASE_URL = '';
const db = require('../src/db');
const shadow = require('../src/services/smartImportShadow');
const { SUPPLIERS } = require('../src/services/smartImportPolicy');
const id = 'local-test-run-01';

test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('shadow is off by default and adapters declare live limits explicitly', async () => {
  delete process.env.SMART_IMPORT_V2_SHADOW;
  assert.equal((await shadow.get('cj')).enabled, false);
  assert.throws(() => shadow.run('cj', { id, action: 'enqueue' }), { status: 403 });
  for (const source of SUPPLIERS) {
    assert.equal(shadow.adapter(source).capabilities().liveDiscovery, false);
    assert.deepEqual(shadow.adapter(source).quoteShipping(), { status: 'unsupported' });
  }
});

test('CJ shadow resumes a persisted checkpoint, deduplicates across batches and never calls a supplier', async (t) => {
  process.env.SMART_IMPORT_V2_SHADOW = '1';
  const fetch = t.mock.method(global, 'fetch', () => { throw Error('Unexpected network call'); });
  for (let i = 0; i < 26; i++) db.listings.insert({
    id: 'cj-' + String(i).padStart(2, '0'), source: 'cj', cj_pid: 'same-cj-id',
    title: 'Candidate', cj_listed: 1500, status: 'pending_review', images: ['https://example.test/image']
  });
  db.listings.insert({ source: 'aliexpress', ae_product_id: 'same-cj-id', title: 'Other supplier' });
  assert.throws(() => shadow.run('cj', { id, action: 'enqueue', autoPublish: true }), { status: 400 });
  const enqueue = await shadow.run('cj', { id, action: 'enqueue' });
  assert.equal(enqueue.total, 26);
  assert.deepEqual(await shadow.run('cj', { id, action: 'enqueue' }), enqueue);
  assert.equal((await shadow.run('cj', { id, action: 'step', cursor: 0 })).processed, 25);
  assert.equal((await shadow.run('cj', { id, action: 'step', cursor: 0 })).processed, 25);
  await shadow.run('cj', { id, action: 'pause' });
  db._reset();
  assert.equal((await shadow.get('cj')).job.state, 'paused');
  assert.equal((await shadow.run('cj', { id, action: 'step', cursor: 25 })).processed, 25);
  await shadow.run('cj', { id, action: 'resume' });
  const result = await shadow.run('cj', { id, action: 'step', cursor: 25 });
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.counts, { review: 1, rejected: 0, eligible: 0, duplicates: 25, missing: 0, reused: 0 });
  assert.deepEqual(result.usage, { supplierRequests: 0, supplierPoints: 0, externalAITokens: 0 });
  const followup = id + '-repeat';
  await shadow.run('cj', { id: followup, action: 'enqueue' });
  const reused = await shadow.run('cj', { id: followup, action: 'step', cursor: 0 });
  assert.equal(reused.counts.reused, 1);
  assert.equal(reused.counts.review, 1);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(db.listings.peek().length, 27);
  assert.equal((await shadow.run('aliexpress', { id, action: 'enqueue' })).total, 1);
  for (const source of SUPPLIERS.filter((x) => x !== 'cj' && x !== 'aliexpress')) {
    assert.equal((await shadow.run(source, { id, action: 'enqueue' })).total, 0);
    db.listings.insert({ source, title: 'Local supplier candidate' });
    const nextId = id + '-next';
    assert.equal((await shadow.run(source, { id: nextId, action: 'enqueue' })).total, 1);
    assert.equal((await shadow.run(source, { id: nextId, action: 'step', cursor: 0 })).counts.review, 1);
  }
});

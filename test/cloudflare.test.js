'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cloudflare = require('../src/services/cloudflare');

test('Cloudflare module exposes only read-only diagnostics', () => {
  assert.equal(typeof cloudflare.configured, 'function');
  assert.equal(typeof cloudflare.zone, 'function');
  assert.equal(typeof cloudflare.diagnose, 'function');
  assert.deepEqual(Object.keys(cloudflare).sort(), ['configured', 'diagnose', 'zone']);
});

test('Cloudflare reports missing token without making a request', async () => {
  const original = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    assert.equal(cloudflare.configured(), false);
    await assert.rejects(cloudflare.zone(), /not configured/);
  } finally {
    if (original !== undefined) process.env.CLOUDFLARE_API_TOKEN = original;
  }
});

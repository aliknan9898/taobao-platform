// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('failed PostgreSQL startup closes its pool and never activates database mode', async () => {
  const old = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/test';
  const configPath = require.resolve('../src/config');
  const dbPath = require.resolve('../src/db');
  delete require.cache[configPath];
  delete require.cache[dbPath];
  let closed = 0;
  class BrokenPool {
    async query() { throw new Error('database unavailable'); }
    async end() { closed++; }
  }
  try {
    const db = require('../src/db');
    await assert.rejects(db.init({ Pool: BrokenPool }), /database unavailable/);
    assert.equal(closed, 1);
    assert.equal(db.mode, 'json');
  } finally {
    delete require.cache[dbPath];
    delete require.cache[configPath];
    if (old === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = old;
  }
});

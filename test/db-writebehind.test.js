// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercise the PostgreSQL write-behind queue without a live database or network.
test('write-behind coalesces updates, persists deletes and keeps writes made during flush', async () => {
  const previous = { DATABASE_URL: process.env.DATABASE_URL, DATA_DIR: process.env.DATA_DIR };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-db-'));
  process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/test';
  process.env.DATA_DIR = dir;
  const configPath = require.resolve('../src/config');
  const dbPath = require.resolve('../src/db');
  delete require.cache[configPath];
  delete require.cache[dbPath];
  const rows = new Map();
  const queries = [];
  let db;
  let injectDuringWrite = false;
  let failNextWrite = false;
  class FakePool {
    async query(sql, args = []) {
      queries.push({ sql, args });
      if (sql.startsWith('SELECT')) return { rows: [] };
      if (sql.startsWith('INSERT') && failNextWrite) {
        failNextWrite = false;
        throw new Error('transient database error');
      }
      if (sql.startsWith('INSERT')) {
        const [coll, id, json] = args;
        rows.set(coll + ':' + id, JSON.parse(json));
        if (injectDuringWrite && id === 'first') {
          injectDuringWrite = false;
          db.listings.update('second', { title: 'newest' });
        }
      }
      if (sql.startsWith('DELETE')) rows.delete(args[0] + ':' + args[1]);
      return { rows: [] };
    }
    async end() {}
  }
  try {
    db = require('../src/db');
    assert.equal((await db.init({ Pool: FakePool })).mode, 'postgres');
    db.listings.insert({ id: 'first', title: 'original' });
    db.listings.update('first', { title: 'updated' });
    db.listings.insert({ id: 'second', title: 'old' });
    injectDuringWrite = true;
    await db.flush();
    assert.equal(rows.get('listings:first').title, 'updated');
    assert.equal(rows.get('listings:second').title, 'newest');
    assert.equal(db.pendingWrites(), 0);
    db.listings.remove('first');
    await db.flush();
    assert.equal(rows.has('listings:first'), false);
    assert.equal(rows.get('listings:second').title, 'newest');
    assert.ok(queries.some(q => q.sql.startsWith('DELETE')));
    // A transient SQL error must not silently lose the pending write.
    failNextWrite = true;
    db.listings.insert({ id: 'retry', title: 'survives failure' });
    await db.flush();
    assert.equal(rows.get('listings:retry').title, 'survives failure');
    assert.equal(db.pendingWrites(), 0);
    await db.close();
  } finally {
    delete require.cache[dbPath];
    delete require.cache[configPath];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

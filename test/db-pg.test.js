// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Fake `pg` Pool backed by a Map, standing in for PostgreSQL
const table = new Map();
let failNext = 0;
class FakePool {
  constructor(opts) { this.opts = opts; }
  async query(sql, p = []) {
    if (/^CREATE TABLE/.test(sql)) return { rows: [] };
    if (failNext > 0) { failNext -= 1; throw new Error('connection reset'); }
    if (/^SELECT coll, doc/.test(sql)) return { rows: [...table.values()].map(([coll, doc]) => ({ coll, doc: JSON.parse(doc) })) };
    if (/^INSERT INTO kinan_docs/.test(sql)) { table.set(`${p[0]}/${p[1]}`, [p[0], p[2]]); return { rows: [] }; }
    if (/^DELETE FROM kinan_docs/.test(sql)) { table.delete(`${p[0]}/${p[1]}`); return { rows: [] }; }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  async end() {}
}

function freshDb() {
  for (const k of Object.keys(require.cache)) if (/src[\\/](db|config)\.js$/.test(k)) delete require.cache[k];
  process.env.DATABASE_URL = 'postgres://kinan:x@dpg-test.frankfurt-postgres.render.com/kinan';
  return require('../src/db');
}

test('PostgreSQL store: changes survive a restart', async () => {
  let db = freshDb();
  assert.deepStrictEqual(await db.init({ Pool: FakePool }), { mode: 'postgres', records: 0 });
  assert.strictEqual(db.mode, 'postgres');
  const u = db.users.insert({ email: 'a@x.com', role: 'buyer' });
  const s = db.sellers.insert({ shop_name: 'Shop' });
  db.users.update(u.id, { name: 'Ali' });
  db.sellers.remove(s.id);
  db.oauthStates.insert({ id: 'st_1', kind: 'x' });
  await db.flush();
  assert.strictEqual(db.pendingWrites(), 0);
  assert.strictEqual(table.size, 2, 'user + oauth state; removed seller is deleted');

  // A failed write is retried, not lost
  failNext = 1;
  db.orders.insert({ id: 'ord_1', total: 10 });
  await db.flush();
  assert.ok(table.has('orders/ord_1'));

  // "Restart": new process state, everything loads back from the database
  db = freshDb();
  assert.strictEqual((await db.init({ Pool: FakePool })).records, 3);
  assert.strictEqual(db.users.all()[0].name, 'Ali');
  assert.strictEqual(db.sellers.all().length, 0);
  assert.strictEqual(db.orders.get('ord_1').total, 10);
  assert.strictEqual(db.oauthStates.get('st_1').kind, 'x');
});

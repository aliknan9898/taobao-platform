'use strict';
/* Region move: scripts/move-db.js copies the whole database into a new, empty one and proves it identical; and
   KINAN_COPY_MODE keeps the new web service away from the database while that runs. Copy tests run against two
   real PostgreSQL databases created for the test (KINAN_TEST_PG=1); nothing else is touched. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const RUN = process.env.KINAN_TEST_PG === '1';
const HOST = process.env.KINAN_TEST_PG_HOST || '127.0.0.1';

test('copy mode serves only /healthz and a moving page, without the database', async () => {
  const { copyModeServer } = require('../src/server');
  const s = copyModeServer(); await new Promise((r) => s.listen(0, r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const h = await fetch(`${base}/healthz`); assert.strictEqual(h.status, 200);
  const p = await fetch(`${base}/`); assert.strictEqual(p.status, 503); assert.match(await p.text(), /moving to a faster server/);
  assert.strictEqual((await fetch(`${base}/api/products`)).status, 503);
  s.close();
});

test('the real server in copy mode never connects to the database', async () => {
  const { spawn } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, KINAN_COPY_MODE: '1', PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'copymode-')), DATABASE_URL: 'postgres://nobody@127.0.0.1:1/unreachable' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    let body = '';
    for (let i = 0; i < 50 && !body; i += 1) { await new Promise((r) => setTimeout(r, 100)); body = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.text()).catch(() => ''); }
    assert.strictEqual(body, 'ok (copy mode)', out);
    assert.match(out, /\[copy-mode\] database untouched/); assert.ok(!/PostgreSQL|\[db\]/.test(out), out);
    assert.strictEqual(child.exitCode, null, 'still running (an app start would have exited on the unreachable database)');
  } finally { child.kill(); }
});

test('move-db refuses without both URLs or with the same database', async () => {
  const { main } = require('../scripts/move-db');
  const out = []; const log = (l) => out.push(l);
  assert.strictEqual(await main([], {}, { Pool: class {}, log }), 2);
  assert.strictEqual(await main([], { OLD_DATABASE_URL: 'postgres://a@h/x', DATABASE_URL: 'postgres://a@h/x' }, { Pool: class {}, log }), 2);
  assert.ok(out.every((l) => !/postgres:\/\//.test(l)), 'never prints a connection string');
});

test('move-db copies everything, identically, into an empty database (PostgreSQL)', { skip: !RUN && 'set KINAN_TEST_PG=1 with a local kinan_test database' }, async (t) => {
  const { Pool: MiniPool } = require('./support/minipg');
  const admin = MiniPool({ user: 'kinan_test', database: 'kinan_test', host: HOST });
  for (const d of ['kinan_move_src', 'kinan_move_dst']) { await admin.query(`DROP DATABASE IF EXISTS ${d}`); await admin.query(`CREATE DATABASE ${d}`); }
  // the script builds pools from URLs; the test client takes the same settings
  class Pool { constructor({ connectionString }) { const u = new URL(connectionString); return MiniPool({ user: u.username, database: u.pathname.slice(1), host: u.hostname }); } }
  const url = (d) => `postgres://kinan_test@${HOST}:5432/${d}`;
  const src = MiniPool({ user: 'kinan_test', database: 'kinan_move_src', host: HOST });
  const dst = MiniPool({ user: 'kinan_test', database: 'kinan_move_dst', host: HOST });
  const { schemaStatements } = require('../src/services/moveDb');
  const { main } = require('../scripts/move-db');
  const env = { OLD_DATABASE_URL: url('kinan_move_src'), DATABASE_URL: url('kinan_move_dst') };
  const run = async (args = []) => { const out = []; const code = await main(args, env, { Pool, log: (l) => out.push(l) }); return { code, out: out.join('\n') }; };
  const sum = async (pool, table) => (await pool.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(md5(x::text), ',' ORDER BY md5(x::text)), '')) AS s FROM ${table} x`)).rows[0];

  // a source shaped like production: documents with nested JSON, Arabic text, quotes, plus partner tables with FKs and serials
  for (const s of schemaStatements()) await src.query(s);
  const docs = Array.from({ length: 1200 }, (_, i) => [i % 7 === 0 ? 'orders' : i % 3 === 0 ? 'products' : 'users', `id_${i}`, JSON.stringify({ id: `id_${i}`, title: i % 2 ? `منتج "رقم" ${i}` : `Item 'x' ${i}`, tags: ['a', 'b', i], nested: { price_minor: i * 7, list: [{ k: null }, true] }, created_at: 1700000000000 + i })]);
  for (let i = 0; i < docs.length; i += 200) {
    const part = docs.slice(i, i + 200); const vals = part.flat();
    await src.query(`INSERT INTO kinan_docs (coll, id, doc) VALUES ${part.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::jsonb)`).join(', ')}`, vals);
  }
  await src.query(`INSERT INTO partner_quote (id, env, store_id, price_list_version, currency, dest_country, dest_postal, lines, totals, charges, contribution_minor, margin_bp, expires_at)
                   VALUES ('pq_1', 'sandbox', 'ps_1', 1, 'EUR', 'DE', '10115', '[{"variant_id":"kv_1","quantity":2}]', '{"payable_minor":4600}', '[]', 1400, 3043, now() + interval '15 minutes')`);
  await src.query(`INSERT INTO partner_order (id, env, store_id, external_order_ref, quote_id, commercial, ship_to) VALUES ('po_1', 'sandbox', 'ps_1', 'REF-1', 'pq_1', '{"items":[]}', '{"v":1,"iv":"x","ct":"y"}')`);
  for (let i = 0; i < 5; i += 1) await src.query(`INSERT INTO partner_outbox (env, store_id, event_id, type, resource_id, resource_version, payload) VALUES ('sandbox', 'ps_1', $1, 'order.updated', 'po_1', $2, '{"version":1}')`, [`evt_${i}`, i + 1]);
  const before = { docs: await sum(src, 'kinan_docs'), outbox: await sum(src, 'partner_outbox') };

  await t.test('copy: all tables identical; source untouched; serial counters continue', async () => {
    const r = await run();
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /RESULT: OK — all \d+ tables identical/);
    assert.match(r.out, /OK +kinan_docs: source 1200 rows, target 1200/);
    assert.ok(!/postgres:\/\//.test(r.out), 'no connection strings in the output');
    assert.deepStrictEqual(await sum(dst, 'kinan_docs'), before.docs);
    assert.deepStrictEqual(await sum(src, 'kinan_docs'), before.docs, 'source unchanged');
    const doc = (await dst.query(`SELECT doc FROM kinan_docs WHERE id = 'id_1'`)).rows[0].doc;
    assert.strictEqual(doc.title, 'منتج "رقم" 1'); assert.deepStrictEqual(doc.nested.list, [{ k: null }, true]);
    const next = (await dst.query(`INSERT INTO partner_outbox (env, store_id, event_id, type, resource_id, resource_version, payload) VALUES ('sandbox', 'ps_1', 'evt_new', 'order.updated', 'po_1', 9, '{}') RETURNING id`)).rows[0].id;
    assert.strictEqual(Number(next), 6, 'the next id follows the copied ones');
    await dst.query(`DELETE FROM partner_outbox WHERE event_id = 'evt_new'`);
  });

  await t.test('a second run refuses: the target is no longer empty', async () => {
    const r = await run(); assert.strictEqual(r.code, 1); assert.match(r.out, /target is not empty/);
    assert.deepStrictEqual(await sum(dst, 'kinan_docs'), before.docs, 'nothing written');
  });

  await t.test('--check compares without copying, and reports a difference', async () => {
    assert.strictEqual((await run(['--check'])).code, 0);
    await dst.query(`UPDATE kinan_docs SET doc = jsonb_set(doc, '{title}', '"changed"') WHERE id = 'id_5'`);
    const r = await run(['--check']); assert.strictEqual(r.code, 1); assert.match(r.out, /DIFF kinan_docs/); assert.match(r.out, /Do not switch the domain/);
  });

  await t.test('unknown tables in the source are refused before anything is copied', async () => {
    await admin.query('DROP DATABASE IF EXISTS kinan_move_dst'); await admin.query('CREATE DATABASE kinan_move_dst');
    await src.query('CREATE TABLE stray_table (x int)');
    const r = await run(); assert.strictEqual(r.code, 1); assert.match(r.out, /does not know: stray_table/);
    assert.strictEqual((await dst.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n, 0, 'target left empty');
    await src.query('DROP TABLE stray_table');
  });

  await t.test('a failure mid-copy leaves the target empty (one transaction)', async () => {
    await src.query(`INSERT INTO kinan_docs (coll, id, doc) VALUES ('users', 'bad', '"just a string"'::jsonb)`); // a JSON string document round-trips
    const r = await run(); assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual((await dst.query(`SELECT doc FROM kinan_docs WHERE id = 'bad'`)).rows[0].doc, 'just a string');
    await src.query(`DELETE FROM kinan_docs WHERE id = 'bad'`);
    // now force a failure: a target that already holds a conflicting partner table definition
    await admin.query('DROP DATABASE IF EXISTS kinan_move_dst'); await admin.query('CREATE DATABASE kinan_move_dst');
    await dst.query('CREATE TABLE partner_outbox (id int)');
    const r2 = await run(); assert.strictEqual(r2.code, 1, r2.out);
    assert.strictEqual((await dst.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'kinan_docs'`)).rows[0].n, 0, 'rolled back: no kinan_docs created');
  });

  t.after(async () => { for (const d of ['kinan_move_src', 'kinan_move_dst']) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {}); });
});

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Copy the whole KINAN database to a new, EMPTY PostgreSQL database (used to move Virginia → Frankfurt).
 *
 * Safety:
 * - The source is read in ONE read-only, repeatable-read transaction: a consistent snapshot, nothing is written there.
 * - The target must be empty (no rows in any table). Tables are created with the app's own definitions
 *   (kinan_docs as src/db.js creates it, partner tables from src/partner/migrations) and filled in ONE transaction:
 *   a failure leaves the target as it was.
 * - Tables the app does not know are refused (listed), never guessed.
 * - Afterwards every table is compared: row count and a checksum of every row's content (md5 over the rows' text,
 *   order-independent, UTC). Any difference = failure (exit code 1).
 * - Connection strings and row contents are never printed. */
'use strict';
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'partner', 'migrations');
const KINAN_DOCS_DDL = 'CREATE TABLE IF NOT EXISTS kinan_docs (coll text NOT NULL, id text NOT NULL, doc jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (coll, id))';
const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function tables(c) {
  return (await c.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
}
/** Tables in an order where every table comes after the tables it references. */
async function fkOrder(c, list) {
  const deps = (await c.query(`SELECT cl.relname AS child, pr.relname AS parent FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class pr ON pr.oid = k.confrelid
                               JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE k.contype = 'f' AND n.nspname = 'public'`)).rows;
  const out = []; const seen = new Set();
  const visit = (t, stack = new Set()) => {
    if (seen.has(t)) return; if (stack.has(t)) throw new Error(`circular foreign keys at ${t}`);
    stack.add(t); for (const d of deps.filter((x) => x.child === t && x.parent !== t)) visit(d.parent, stack); stack.delete(t);
    seen.add(t); out.push(t);
  };
  for (const t of list) visit(t);
  return out.filter((t) => list.includes(t));
}
async function count(c, t) { return Number((await c.query(`SELECT count(*)::bigint AS n FROM ${qi(t)}`)).rows[0].n); }
async function checksum(c, t) { return (await c.query(`SELECT md5(coalesce(string_agg(h, ',' ORDER BY h), '')) AS s FROM (SELECT md5(x::text) AS h FROM ${qi(t)} x) q`)).rows[0].s; }
async function columns(c, t) {
  return (await c.query(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t])).rows;
}
/** Statements of the app's own schema: kinan_docs + partner migrations (forward files, in order), structure only. */
function schemaStatements() {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.endsWith('.down.sql')).sort();
  const stmts = [KINAN_DOCS_DDL];
  // structure only: data rows (e.g. partner_schema versions) come from the source, so INSERTs are skipped here
  for (const f of files) for (const s of fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) if (!/^INSERT\b/i.test(s)) stmts.push(s);
  return stmts;
}

/**
 * Copy `from` (pg Pool) into `to` (pg Pool). Options: { log, check } — check=true only compares, copies nothing.
 * Returns { ok, tables: [{ table, source, target, same }] }.
 */
async function copyDatabase({ from, to, log = () => {}, check = false }) {
  const src = await from.connect(); const dst = await to.connect();
  try {
    await src.query("SET TIME ZONE 'UTC'"); await dst.query("SET TIME ZONE 'UTC'");
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const srcTables = await tables(src);
    if (!srcTables.length) throw new Error('The source database has no tables: check OLD_DATABASE_URL');
    const known = new Set(['kinan_docs']);
    // the app's own tables = kinan_docs + every table the partner migrations create
    for (const s of schemaStatements()) { const m = s.match(/^CREATE TABLE IF NOT EXISTS (\w+)/i); if (m) known.add(m[1]); }
    const unknown = srcTables.filter((t) => !known.has(t));
    if (unknown.length) throw new Error(`The source has tables this script does not know: ${unknown.join(', ')}. Nothing was copied.`);
    const order = await fkOrder(src, srcTables);
    const before = {};
    for (const t of order) before[t] = { rows: await count(src, t), sum: await checksum(src, t) };

    if (!check) {
      const dstTables = await tables(dst);
      for (const t of dstTables) { const n = await count(dst, t); if (n) throw new Error(`The target is not empty (${t}: ${n} rows). Copy only into a new, empty database.`); }
      await dst.query('BEGIN');
      try {
        for (const s of schemaStatements()) await dst.query(s);
        for (const t of order) {
          const cols = await columns(src, t);
          const names = cols.map((c) => qi(c.name)).join(', ');
          // every column travels as PostgreSQL's own text form and is cast back by the target: no JavaScript conversion
          // (pg would turn timestamptz into a millisecond Date, json into objects, arrays into JS arrays)
          const rows = (await src.query(`SELECT ${cols.map((c) => `${qi(c.name)}::text AS ${qi(c.name)}`).join(', ')} FROM ${qi(t)}`)).rows;
          const per = Math.max(1, Math.floor(30000 / Math.max(1, cols.length)));
          for (let i = 0; i < rows.length; i += per) {
            const part = rows.slice(i, i + per); const vals = []; const tuples = [];
            for (const r of part) {
              tuples.push(`(${cols.map((c) => { vals.push(r[c.name]); return `$${vals.length}`; }).join(', ')})`);
            }
            await dst.query(`INSERT INTO ${qi(t)} (${names}) VALUES ${tuples.join(', ')}`, vals);
          }
          // serial / identity counters continue after the copied ids
          for (const c of cols) {
            const seq = (await dst.query('SELECT pg_get_serial_sequence($1, $2) AS s', [t, c.name])).rows[0].s;
            if (seq) await dst.query(`SELECT setval($1, GREATEST((SELECT coalesce(max(${qi(c.name)}), 0) FROM ${qi(t)}), 1), (SELECT count(*) > 0 FROM ${qi(t)}))`, [seq]);
          }
          log(`copied ${t}: ${rows.length} rows`);
        }
        await dst.query('COMMIT');
      } catch (e) { await dst.query('ROLLBACK').catch(() => {}); throw e; }
    }
    await src.query('COMMIT');

    const report = []; let ok = true;
    for (const t of order) {
      const exists = (await tables(dst)).includes(t);
      const after = exists ? { rows: await count(dst, t), sum: await checksum(dst, t) } : { rows: null, sum: null };
      const same = after.rows === before[t].rows && after.sum === before[t].sum;
      if (!same) ok = false;
      report.push({ table: t, source: before[t].rows, target: after.rows, same });
      log(`${same ? 'OK  ' : 'DIFF'} ${t}: source ${before[t].rows} rows, target ${after.rows ?? 'missing'}${same ? '' : ' — contents differ'}`);
    }
    return { ok, tables: report };
  } finally {
    await src.query('ROLLBACK').catch(() => {});
    src.release(); dst.release();
  }
}

module.exports = { copyDatabase, schemaStatements, KINAN_DOCS_DDL };

#!/usr/bin/env node
// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Copy the KINAN database to a new, empty database (region move). Run it in the NEW service's Shell:
 *
 *   node scripts/move-db.js            copy OLD_DATABASE_URL → DATABASE_URL, then compare every table
 *   node scripts/move-db.js --check    compare only (copies nothing)
 *
 * OLD_DATABASE_URL = the old database's External URL (its access control must allow this service's outbound IPs).
 * DATABASE_URL     = the new database (Internal URL). Run with KINAN_COPY_MODE=1 set on the service, so the web
 *                    process does not touch the new database while the copy runs.
 * Prints table names and row counts only, never connection strings or data. Exit code 0 = identical. */
'use strict';
const { copyDatabase } = require('../src/services/moveDb');

function pool(url, Pool) {
  const u = new URL(url);
  const sslMode = u.searchParams.get('sslmode');
  const external = /\.render\.com$/.test(u.hostname) || ['require', 'verify-full', 'verify-ca'].includes(sslMode);
  return new Pool({ connectionString: url, ssl: external ? { rejectUnauthorized: true } : false, max: 2 });
}

async function main(argv = process.argv.slice(2), env = process.env, { Pool = require('pg').Pool, log = console.log } = {}) {
  const check = argv.includes('--check');
  if (!env.OLD_DATABASE_URL || !env.DATABASE_URL) { log('Set OLD_DATABASE_URL (old database, External URL) and DATABASE_URL (new database).'); return 2; }
  if (env.OLD_DATABASE_URL === env.DATABASE_URL) { log('OLD_DATABASE_URL and DATABASE_URL are the same database. Nothing done.'); return 2; }
  const from = pool(env.OLD_DATABASE_URL, Pool); const to = pool(env.DATABASE_URL, Pool);
  try {
    log(check ? 'Comparing the two databases (nothing is copied)…' : 'Copying the old database into the new one…');
    const r = await copyDatabase({ from, to, log, check });
    log(r.ok ? `RESULT: OK — all ${r.tables.length} tables identical (${r.tables.reduce((a, t) => a + t.source, 0)} rows).` : 'RESULT: FAILED — the databases differ. Do not switch the domain; follow the rollback plan.');
    return r.ok ? 0 : 1;
  } catch (e) {
    log(`RESULT: FAILED — ${e.message}`);
    return 1;
  } finally { for (const p of [from, to]) await Promise.resolve().then(() => p.end()).catch(() => {}); }
}

if (require.main === module) main().then((code) => process.exit(code));
module.exports = { main };

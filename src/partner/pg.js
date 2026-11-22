// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* PostgreSQL access for partner quotes and orders. These need real transactions and unique constraints, so they
   never use the in-memory document store. Ordering is off until the owner sets PARTNER_ORDERS_ENABLED=1; only then
   is the additive migration applied (once per process, under an advisory lock). */
'use strict';
const fs = require('fs');
const path = require('path');

let override = null; let ready = null;
const enabled = () => process.env.PARTNER_ORDERS_ENABLED === '1';

/** Tests inject a pool; production uses the app's pg pool (DATABASE_URL). */
function setPool(p) { override = p; ready = null; }
function pool() { return override || require('../db').pgPool(); }

async function ensureSchema() {
  if (ready) return ready;
  ready = (async () => {
    const c = await pool().connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(1262898244)'); // "KNPA"
      const sql = fs.readFileSync(path.join(__dirname, 'migrations', '001_partner_core.sql'), 'utf8');
      for (const stmt of sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await c.query(stmt);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); ready = null; throw e; } finally { c.release(); }
  })();
  return ready;
}

/** Run fn(client) inside BEGIN/COMMIT; ROLLBACK on any error. */
async function tx(fn, { isolation = 'READ COMMITTED' } = {}) {
  await ensureSchema();
  const c = await pool().connect();
  try {
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
async function q(text, values) { await ensureSchema(); return pool().query(text, values); }

module.exports = { enabled, setPool, pool, ensureSchema, tx, q };

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Document store with a synchronous, in-memory API (every service uses it synchronously).
 *  - DATABASE_URL set → PostgreSQL is the source of truth: everything is loaded at start-up,
 *    and every change is written to table kinan_docs in the background (write-behind, in order).
 *  - Otherwise → one JSON file per collection in DATA_DIR (local development and tests).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

const COLLECTIONS = [['users', 'usr'], ['sessions', 'ses'], ['sellers', 'sel'], ['listings', 'lst'], ['orders', 'ord'], ['parcels', 'pcl'],
  ['shipments', 'shp'], ['ledger', 'led'], ['inbox', 'msg'], ['oauth_states', 'st'], ['wallet', 'wal'], ['requests', 'req'], ['settings', 'set'],
  ['payouts', 'pay'], ['returns', 'ret'], ['tokens', 'tok'], ['mail', 'mail'],
  ['coupons', 'cpn'], ['reviews', 'rev'], ['wishlist', 'wsh'], ['carts', 'crt'], ['push_subs', 'psh'], ['messages', 'chat'], ['views', 'vw'], ['kyc_docs', 'kyc']];

let pool = null;          // pg Pool when DATABASE_URL is used
const cache = new Map();

if (!config.databaseUrl) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
  } catch (e) {
    // Typical cause on Render: DATA_DIR=/var/data set without an attached disk (Free plan has no disks)
    console.error(`[db] DATA_DIR "${config.dataDir}" is not writable (${e.code || e.message}). ` +
      'Remove DATA_DIR from the environment, or attach a persistent disk mounted at that path.');
    process.exit(1);
  }
}

function file(name) { return path.join(config.dataDir, `${name}.json`); }
function load(name) {
  if (!cache.has(name)) {
    let v = [];
    if (!pool) { try { v = JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { /* new */ } }
    cache.set(name, v);
  }
  return cache.get(name);
}

// ---- write-behind queue (PostgreSQL) ----
const pending = new Map(); // `${coll}\u0000${id}` → { coll, id } ; latest state is read from the cache at flush time
let flushing = null; let timer = null; let failures = 0;
function schedule() { if (!timer && !flushing) timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, 15); }
async function flush() {
  if (!pool) return;
  if (flushing) { await flushing; if (pending.size) return flush(); return; }
  flushing = (async () => {
    while (pending.size) {
      const batch = [...pending.values()]; pending.clear();
      try {
        for (const { coll, id } of batch) {
          const doc = load(coll).find((d) => d.id === id);
          if (doc) await pool.query('INSERT INTO kinan_docs (coll, id, doc, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (coll, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()', [coll, id, JSON.stringify(doc)]);
          else await pool.query('DELETE FROM kinan_docs WHERE coll = $1 AND id = $2', [coll, id]);
        }
        failures = 0;
      } catch (e) {
        for (const x of batch) pending.set(`${x.coll}\u0000${x.id}`, x); // keep for retry
        failures += 1;
        console.error(`[db] write to PostgreSQL failed (${failures}): ${e.message}`);
        await new Promise((r) => setTimeout(r, Math.min(30000, 500 * 2 ** failures)));
      }
    }
  })();
  try { await flushing; } finally { flushing = null; }
}
function persist(name, docId) {
  if (pool) { pending.set(`${name}\u0000${docId}`, { coll: name, id: docId }); schedule(); return; }
  const f = file(name);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name)), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** Connect to PostgreSQL (when configured) and load everything into memory. Call before serving requests. */
async function init({ Pool } = {}) {
  if (!config.databaseUrl) return { mode: 'json' };
  const PgPool = Pool || require('pg').Pool;
  const external = /\.render\.com|sslmode=require/.test(config.databaseUrl);
  pool = new PgPool({ connectionString: config.databaseUrl, ssl: external ? { rejectUnauthorized: false } : false, max: 5 });
  await pool.query('CREATE TABLE IF NOT EXISTS kinan_docs (coll text NOT NULL, id text NOT NULL, doc jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (coll, id))');
  const { rows } = await pool.query('SELECT coll, doc FROM kinan_docs');
  cache.clear();
  for (const [name] of COLLECTIONS) cache.set(name, []);
  for (const r of rows) { const d = typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc; (cache.get(r.coll) || cache.set(r.coll, []).get(r.coll)).push(d); }
  for (const list of cache.values()) list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  console.log(`[db] PostgreSQL connected — ${rows.length} records loaded`);
  return { mode: 'postgres', records: rows.length };
}

async function close() { await flush(); if (pool) await pool.end(); }

const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function collection(name, prefix) {
  return {
    all: (pred) => clone(pred ? load(name).filter(pred) : load(name)),
    get: (key) => clone(load(name).find((d) => d.id === key)),
    find: (pred) => clone(load(name).find(pred)),
    insert(doc) {
      const d = { id: doc.id || id(prefix), created_at: Date.now(), updated_at: Date.now(), ...doc };
      load(name).push(d); persist(name, d.id); return clone(d);
    },
    update(key, patch) {
      const list = load(name);
      const i = list.findIndex((d) => d.id === key);
      if (i < 0) return null;
      const next = typeof patch === 'function' ? patch(clone(list[i])) : { ...list[i], ...patch };
      list[i] = { ...next, id: list[i].id, updated_at: Date.now() };
      persist(name, list[i].id); return clone(list[i]);
    },
    remove(key) {
      const list = load(name); const i = list.findIndex((d) => d.id === key);
      if (i >= 0) { list.splice(i, 1); persist(name, key); }
    }
  };
}

/** Everything except sign-in sessions and one-time tokens, for backups. */
function exportAll() {
  const skip = new Set(['sessions', 'tokens', 'oauth_states', 'inbox']);
  return Object.fromEntries(COLLECTIONS.filter(([n]) => !skip.has(n)).map(([n]) => [n, clone(load(n))]));
}

module.exports = {
  id, init, flush, close, exportAll,
  get mode() { return pool ? 'postgres' : 'json'; },
  pendingWrites: () => pending.size,
  ...Object.fromEntries(COLLECTIONS.map(([name, prefix]) => [name === 'oauth_states' ? 'oauthStates' : name, collection(name, prefix)])),
  _reset() { cache.clear(); }
};

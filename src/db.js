'use strict';
/**
 * Minimal document store: one JSON file per collection, atomic writes, in-memory cache.
 * Single-process only. For production move to PostgreSQL (schema in docs/ARCHITECTURE.md).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const cache = new Map();

function file(name) { return path.join(config.dataDir, `${name}.json`); }
function load(name) {
  if (!cache.has(name)) {
    let v = [];
    try { v = JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { /* new */ }
    cache.set(name, v);
  }
  return cache.get(name);
}
function persist(name) {
  const f = file(name);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name)), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function collection(name, prefix) {
  return {
    all: (pred) => clone(pred ? load(name).filter(pred) : load(name)),
    get: (key) => clone(load(name).find((d) => d.id === key)),
    find: (pred) => clone(load(name).find(pred)),
    insert(doc) {
      const d = { id: doc.id || id(prefix), created_at: Date.now(), updated_at: Date.now(), ...doc };
      load(name).push(d); persist(name); return clone(d);
    },
    update(key, patch) {
      const list = load(name);
      const i = list.findIndex((d) => d.id === key);
      if (i < 0) return null;
      const next = typeof patch === 'function' ? patch(clone(list[i])) : { ...list[i], ...patch };
      list[i] = { ...next, id: list[i].id, updated_at: Date.now() };
      persist(name); return clone(list[i]);
    },
    remove(key) {
      const list = load(name); const i = list.findIndex((d) => d.id === key);
      if (i >= 0) { list.splice(i, 1); persist(name); }
    }
  };
}

module.exports = {
  id,
  users: collection('users', 'usr'),
  sessions: collection('sessions', 'ses'),
  sellers: collection('sellers', 'sel'),
  listings: collection('listings', 'lst'),
  orders: collection('orders', 'ord'),
  parcels: collection('parcels', 'pcl'),
  shipments: collection('shipments', 'shp'),
  ledger: collection('ledger', 'led'),
  inbox: collection('inbox', 'msg'),          // webhook queue + dedup
  oauthStates: collection('oauth_states', 'st'),
  _reset() { cache.clear(); }
};

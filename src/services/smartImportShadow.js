'use strict';

const { createHash } = require('node:crypto');
const db = require('../db');
const { httpError } = require('../auth');
const { SUPPLIERS, listingSource, review } = require('./smartImportPolicy');
const settings = require('./smartImportSettings');

const COLLECTION = 'smart_import_shadow';
const BATCH = 25;
const MAX_RECORDS = 1000;
const TTL = 30000;
const cache = new Map();
const enabled = () => process.env.SMART_IMPORT_V2_SHADOW === '1';
const usage = () => ({ supplierRequests: 0, supplierPoints: 0, externalAITokens: 0 });

function assertSource(source) {
  if (!SUPPLIERS.includes(source)) throw httpError(404, 'Unknown supplier');
}

function normalize(source, listing) {
  const ids = {
    taobao: listing.taobao_item_id || listing.mp_id,
    aliexpress: listing.ae_product_id,
    cj: listing.cj_pid,
    '1688': listing.external_id,
    buckydrop: listing.external_id,
    hiobuy: listing.external_id,
    banggood: listing.bg_product_id || listing.bg_pid
  };
  const externalId = typeof ids[source] === 'string' ? ids[source].trim() : '';
  return {
    source, id: listing.id, externalId,
    title: listing.title,
    sales: source === 'cj' ? listing.cj_listed : undefined,
    images: Array.isArray(listing.images) ? listing.images : []
  };
}

function adapter(source) {
  assertSource(source);
  return {
    capabilities: () => ({ mode: 'local-shadow', liveDiscovery: false, liveShipping: false }),
    usage,
    discover() {
      const now = Date.now();
      const version = db.version('listings');
      const previous = cache.get(source);
      if (previous?.version === version && previous.until > now) return previous.ids;
      const ids = db.listings.peek((item) => listingSource(item) === source)
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, MAX_RECORDS).map(({ id }) => id);
      cache.set(source, { version, until: now + TTL, ids });
      return ids;
    },
    fetchDetails(id) {
      const listing = db.listings.get(id);
      return listing && listingSource(listing) === source ? listing : null;
    },
    quoteShipping() { return { status: 'unsupported' }; },
    normalize: (listing) => normalize(source, listing)
  };
}

const jsonBusy = new Set();

// Use the existing (coll,id) primary key and a row lock, bypassing the process-local
// snapshot for queue state. No supplier calls, schema migration or new service.
async function transact(source, change) {
  const pool = db.pgPool();
  if (!pool) {
    if (jsonBusy.has(source)) throw httpError(409, 'Supplier job is busy');
    jsonBusy.add(source);
    try {
      const id = COLLECTION + '_' + source;
      const record = db.settings.get(id);
      const job = change(record?.job ?? null);
      if (record) db.settings.update(id, { job }); else db.settings.insert({ id, job });
      await db.flush();
      return job;
    } finally { jsonBusy.delete(source); }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO kinan_docs (coll, id, doc) VALUES ($1, $2, 'null'::jsonb) ON CONFLICT DO NOTHING", [COLLECTION, source]);
    const { rows } = await client.query('SELECT doc FROM kinan_docs WHERE coll=$1 AND id=$2 FOR UPDATE', [COLLECTION, source]);
    const job = change(rows[0].doc);
    await client.query('UPDATE kinan_docs SET doc=$3, updated_at=now() WHERE coll=$1 AND id=$2', [COLLECTION, source, JSON.stringify(job)]);
    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function get(source) {
  const supplier = adapter(source);
  const pool = db.pgPool();
  const job = pool
    ? (await pool.query('SELECT doc FROM kinan_docs WHERE coll=$1 AND id=$2', [COLLECTION, source])).rows[0]?.doc
    : db.settings.get(COLLECTION + '_' + source)?.job;
  return { enabled: enabled(), ...supplier.capabilities(), job: summary(job) };
}

function summary(job) {
  if (!job) return null;
  const { id, state, cursor, ids, counts, updatedAt, usage } = job;
  return { id, state, processed: cursor, total: ids.length, counts, updatedAt, usage };
}

function run(source, input) {
  const supplier = adapter(source);
  if (!enabled()) throw httpError(403, 'Smart Import shadow is disabled');
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).some((key) => !['id', 'action', 'cursor'].includes(key)) ||
      typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(input.id) ||
      !['enqueue', 'step', 'pause', 'resume'].includes(input.action) ||
      (input.action === 'step' ? !Number.isInteger(input.cursor) || input.cursor < 0 : Object.hasOwn(input, 'cursor'))) {
    throw httpError(400, 'Invalid shadow job request');
  }
  return transact(source, (job) => {
    if (input.action === 'enqueue') {
      if (job?.id === input.id) return job;
      if (job && job.state !== 'completed') throw httpError(409, 'Supplier already has a shadow job');
      const ids = supplier.discover();
      return { id: input.id, state: ids.length ? 'queued' : 'completed', cursor: 0, ids,
        policy: settings.get(source), seen: [], history: job?.history || [], counts: { review: 0, rejected: 0, eligible: 0, duplicates: 0, missing: 0, reused: 0 },
        usage: supplier.usage(), updatedAt: Date.now() };
    }
    if (job?.id !== input.id) throw httpError(404, 'Shadow job not found');
    if (job.state === 'completed') return job;
    if (input.action === 'pause') return { ...job, state: 'paused', updatedAt: Date.now() };
    if (input.action === 'resume') return { ...job, state: 'queued', updatedAt: Date.now() };
    if (job.state === 'paused' || input.cursor !== job.cursor) return job;
    const seen = new Set(job.seen);
    const history = new Map(job.history || []);
    job.counts.reused ??= 0;
    const ids = job.ids.slice(job.cursor, job.cursor + BATCH);
    for (const id of ids) {
      const listing = supplier.fetchDetails(id);
      if (!listing) { job.counts.missing++; continue; }
      const item = supplier.normalize(listing);
      if (item.externalId && seen.has(item.externalId)) { job.counts.duplicates++; continue; }
      if (item.externalId) seen.add(item.externalId);
      const key = item.externalId ? 'supplier:' + item.externalId : 'listing:' + item.id;
      const fingerprint = createHash('sha256').update(JSON.stringify([
        item.title, item.sales, item.images, job.policy
      ])).digest('hex');
      const old = history.get(key);
      if (old?.fingerprint === fingerprint && old.until > Date.now()) {
        job.counts.reused++;
        job.counts[old.status]++;
        continue;
      }
      const { status } = review(item, job.policy);
      history.delete(key);
      history.set(key, { fingerprint, status, until: Date.now() + 24 * 3600e3 });
      job.counts[status]++;
    }
    job.history = [...history].slice(-MAX_RECORDS);
    job.seen = [...seen];
    job.cursor += ids.length;
    job.state = job.cursor === job.ids.length ? 'completed' : 'queued';
    job.updatedAt = Date.now();
    return job;
  }).then(summary);
}

module.exports = { adapter, get, run, transact };

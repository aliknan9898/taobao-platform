'use strict';
const db = require('../db');
const { httpError } = require('../auth');
const { SUPPLIERS, DEFAULTS, review, listingSource, gateEnabled } = require('./smartImportPolicy');

const thresholds = {
  minSales: { min: 0, max: 100000000, integer: true },
  maxShippingDays: { min: 1, max: 90, integer: true },
  minMargin: { min: 0, max: 1 }
};
const flags = ['externalAI', 'autoPublish'];
const statuses = ['active', 'pending_review', 'rejected', 'paused', 'unavailable', 'private', 'draft'];

function validateSource(source) {
  if (!SUPPLIERS.includes(source)) throw httpError(404, 'Unknown supplier');
  return source;
}

function validateBody(input, allowed) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      !Object.keys(input).length || Object.keys(input).some((field) => !allowed.includes(field))) {
    throw httpError(400, 'Invalid request fields');
  }
}

function get(source) {
  const saved = db.settings.get('smart_import_v2_' + validateSource(source))?.policy || {};
  const policy = { ...DEFAULTS };
  for (const [name, rule] of Object.entries(thresholds)) {
    if (validNumber(saved[name], rule)) policy[name] = saved[name];
  }
  return policy;
}

function validNumber(value, { min, max, integer }) {
  return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

async function save(source, input) {
  const policy = get(source);
  validateBody(input, [...Object.keys(thresholds), ...flags]);
  for (const [name, rule] of Object.entries(thresholds)) {
    if (!Object.hasOwn(input, name)) continue;
    if (!validNumber(input[name], rule)) throw httpError(400, 'Invalid ' + name);
    policy[name] = input[name];
  }
  for (const flag of flags) {
    if (!Object.hasOwn(input, flag)) continue;
    if (typeof input[flag] !== 'boolean') throw httpError(400, 'Invalid feature flag');
    if (input[flag]) throw httpError(403, 'Not enabled during staged integration');
  }
  const id = 'smart_import_v2_' + source;
  if (db.settings.get(id)) db.settings.update(id, { policy }); else db.settings.insert({ id, policy });
  await db.flush();
  return policy;
}

function evaluate(source, input) {
  const policy = get(source);
  validateBody(input, ['listingId']);
  if (typeof input.listingId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.listingId)) {
    throw httpError(400, 'Invalid listingId');
  }
  const listing = db.listings.get(input.listingId);
  if (!listing || listingSource(listing) !== source) throw httpError(404, 'Listing not found for supplier');
  // Shipping, margin, and review evidence require trusted per-SKU pipelines in later phases.
  return review({
    source, id: listing.id, title: listing.title, sales: listing.cj_listed,
    images: [...(listing.images || []), ...(listing.own_images || [])]
  }, policy);
}

function products(source, query) {
  validateSource(source);
  for (const name of query.keys()) {
    if (!['page', 'status', 'q'].includes(name) || query.getAll(name).length !== 1) throw httpError(400, 'Invalid filter');
  }
  const page = query.get('page') ?? '1';
  const status = query.get('status') ?? '';
  const q = (query.get('q') ?? '').trim().toLowerCase();
  if (!/^[1-9]\d{0,5}$/.test(page) || (status && !statuses.includes(status)) || q.length > 100) {
    throw httpError(400, 'Invalid filter');
  }
  const size = 25;
  const start = (Number(page) - 1) * size;
  const matches = db.listings.peek((l) => listingSource(l) === source && (!status || status === l.status) &&
    (!q || [l.id, l.title, l.title_ar].some((value) => String(value || '').toLowerCase().includes(q))));
  matches.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  return {
    items: matches.slice(start, start + size).map(({ id, title, status }) => ({ id, title, status })),
    total: matches.length, page: Number(page), size
  };
}

function list() {
  const counts = new Map(SUPPLIERS.map((source) => [source, { total: 0, published: 0, pending: 0, rejected: 0 }]));
  for (const listing of db.listings.peek()) {
    const count = counts.get(listingSource(listing));
    if (!count) continue;
    count.total++;
    if (listing.status === 'active') count.published++;
    if (listing.status === 'pending_review') count.pending++;
    if (listing.status === 'rejected') count.rejected++;
  }
  return SUPPLIERS.map((source) => ({ source, policy: get(source), counts: counts.get(source), gateEnabled: gateEnabled() }));
}

module.exports = { get, save, evaluate, products, list };

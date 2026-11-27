'use strict';

const { httpError } = require('../auth');
const { isMarket } = require('../countries');
const { SUPPLIERS } = require('./smartImportPolicy');
const { transact } = require('./smartImportShadow');

const enabled = () => process.env.SMART_IMPORT_V2_PROBE === '1';
const DAILY_LIMIT = 12;
const CACHE_TTL = 10 * 60e3;
const MAX_RETRY_WINDOW = 24 * 3600e3;
const cache = new Map();
const inFlight = new Map();

const adapters = {
  cj: {
    discover: async ({ q, page, country }) => (await require('./cj').search({ q, page, country, size: 20 })).items,
    quote: ({ sku, country, origin }) => require('./cj').freightOptions(country, [{ vid: sku, qty: 1 }], origin)
  },
  aliexpress: {
    discover: ({ q, country }) => require('./aeSourcing').search(q, country),
    quote: ({ product, sku, country }) => require('./aeSourcing').freight(product, sku, country)
  },
  banggood: {
    discover: async ({ category, page }) => (await require('./banggood').listProducts({ cat_id: category, page })).items,
    quote: ({ product, warehouse, sku, country }) => require('./banggood').shipOptions(product, warehouse, sku, 1, country)
  }
};

function capability(source) {
  if (!SUPPLIERS.includes(source)) throw httpError(404, 'Unknown supplier');
  return { enabled: enabled(), readOnly: Boolean(adapters[source]), dailyOperationsLimit: DAILY_LIMIT };
}

function validate(source, input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || !['discover', 'quote'].includes(input.action)) {
    throw httpError(400, 'Invalid probe request');
  }
  const fields = input.action === 'discover'
    ? { cj: ['q', 'country', 'page'], aliexpress: ['q', 'country'], banggood: ['category', 'page'] }
    : { cj: ['sku', 'country', 'origin'], aliexpress: ['product', 'sku', 'country'], banggood: ['product', 'sku', 'country', 'warehouse'] };
  const allowed = fields[source];
  if (!allowed || Object.keys(input).some((key) => key !== 'action' && !allowed.includes(key))) {
    throw httpError(400, 'Invalid probe fields');
  }
  for (const key of allowed) {
    const value = input[key];
    if (key === 'page') {
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 500)) throw httpError(400, 'Invalid page');
    } else if (key === 'country') {
      if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value) || !isMarket(value)) throw httpError(400, 'Invalid country');
    } else if (key === 'origin') {
      if (value !== undefined && (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value))) throw httpError(400, 'Invalid origin');
    } else if (key === 'q') {
      if (typeof value !== 'string' || !value.trim() || value.length > 100) throw httpError(400, 'Invalid search');
    } else if (typeof value !== 'string' || !(key === 'category' ? /^\d{1,10}$/ : /^[a-zA-Z0-9_,;-]{1,100}$/).test(value)) {
      throw httpError(400, 'Invalid supplier identifier');
    }
  }
  return Object.fromEntries(['action', ...allowed].filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
}

const initial = (day) => ({ day, operations: 0, failures: 0, retryAt: 0 });
const dayAt = (now) => new Date(now).toISOString().slice(0, 10);

async function request(source, input) {
  const caps = capability(source);
  if (!caps.enabled) throw httpError(403, 'Supplier probe is disabled');
  if (!caps.readOnly) throw httpError(501, 'Supplier API contract is not available in KINAN');
  const params = validate(source, input);
  const key = JSON.stringify([source, params]);
  const hit = cache.get(key);
  if (hit?.until > Date.now()) return { ...hit.result, cached: true };
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = execute(source, params, key);
  inFlight.set(key, pending);
  try { return await pending; } finally { inFlight.delete(key); }
}

async function execute(source, params, key) {
  const slot = 'probe_' + source;
  const now = Date.now();
  const day = dayAt(now);
  const usage = await transact(slot, (stored) => {
    if (stored?.retryAt > now) throw httpError(429, 'Supplier probe is cooling down');
    const state = stored?.day === day ? stored : initial(day);
    if (state.operations >= DAILY_LIMIT) throw httpError(429, 'Daily supplier operation budget reached');
    return { ...state, operations: state.operations + 1 };
  });
  try {
    const response = await adapters[source][params.action](params);
    const data = Array.isArray(response) ? response.slice(0, 20) : response;
    const result = { source, operation: params.action, data, cached: false, operationsToday: usage.operations,
      supplierPoints: null, externalAITokens: 0 };
    cache.set(key, { result, until: Date.now() + CACHE_TTL });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return result;
  } catch (error) {
    const status = Number(error.status || error.statusCode);
    const limited = status === 429 || error.code === 'POINTS';
    const retryable = limited || status >= 500 || !status;
    if (retryable) {
      await transact(slot, (stored) => {
        const state = stored ?? initial(day);
        const failures = Math.min(8, state.failures + 1);
        const retryAfter = Number(error.retryAt || 0);
        const backoff = Date.now() + (limited ? 30000 : 5000) * 2 ** (failures - 1) + Math.floor(Math.random() * 1000);
        return { ...state, failures, retryAt: Math.max(state.retryAt, backoff, Math.min(Date.now() + MAX_RETRY_WINDOW, retryAfter || 0)) };
      });
    }
    throw httpError(limited ? 429 : 502, limited ? 'Supplier temporarily limited' : 'Supplier probe failed');
  }
}

module.exports = { capability, request };

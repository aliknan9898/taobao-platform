'use strict';

const db = require('../db');
const { config } = require('../config');
const { chargeRate } = require('./fx');
const legacy = require('./ebay');
const publisher = require('./ebayPublisher');

const MAX_BATCH = 10;
const running = new Map();
let defaultClient;

function listingInput(doc, env) {
  const options = doc.ebay_publish || {};
  const skus = doc.skus || [];
  const variant = options.variantId ? skus.find((sku) => sku.mp_sku_id === options.variantId) : skus[0];
  const marketplaceId = options.marketplaceId || env.EBAY_MARKETPLACE || 'EBAY_GB';
  const currency = publisher.MARKETS[marketplaceId]?.[1];
  const sourceCurrency = String(doc.currency || config.currency).toUpperCase();
  const exchangeRate = currency === sourceCurrency ? 1 : sourceCurrency === config.currency.toUpperCase() ? chargeRate(currency) : null;
  return {
    sku: options.sku || (variant ? legacy.skuKey(doc, variant) : ''),
    title: options.title ?? doc.title,
    description: options.description ?? doc.description,
    quantity: variant?.stock,
    price: options.price ?? (exchangeRate > 0 ? Number(variant?.price) * exchangeRate : null),
    imageUrls: options.imageUrls ?? doc.images,
    aspects: options.aspects,
    marketplaceId,
    categoryId: options.categoryId ?? doc.ebay?.category ?? env.EBAY_CATEGORY_ID,
    merchantLocationKey: options.merchantLocationKey ?? env.EBAY_MERCHANT_LOCATION_KEY,
    listingPolicies: {
      fulfillmentPolicyId: env.EBAY_FULFILLMENT_POLICY_ID, paymentPolicyId: env.EBAY_PAYMENT_POLICY_ID,
      returnPolicyId: env.EBAY_RETURN_POLICY_ID, ...options.listingPolicies
    }
  };
}

function validation(id, env = process.env, doc = db.listings.get(id)) {
  if (!doc) throw publisher.stageError('validation', 'Listing not found', 404);
  const result = publisher.validateEbayListing(listingInput(doc, env));
  const issues = result.issues || {};
  if (doc.status !== 'active') issues.status = 'Only active listings can be published';
  if ((doc.skus || []).length > 1 && !doc.ebay_publish?.variantId) issues.variantId = 'Choose a variant in ebay_publish.variantId';
  if (doc.ebay?.group) issues.group = 'Existing variation groups are managed by the legacy eBay integration';
  if (Object.keys(issues).length) return { valid: false, issues };
  const destination = [publisher.environment(env), result.listing.marketplaceId].join(':');
  const idempotencyKey = publisher.hash(JSON.stringify([destination, result.listing]));
  const saved = doc.ebay_publisher?.[destination];
  return { ...result, destination, idempotencyKey, unchanged: saved?.idempotencyKey === idempotencyKey && Boolean(saved.ebay_listing_id) };
}

async function publishOne(id, { env = process.env, client } = {}) {
  const prepared = validation(id, env);
  if (!prepared.valid) throw publisher.stageError('validation', 'Listing is not ready for eBay', 400, prepared.issues);
  const { listing, destination, idempotencyKey, unchanged } = prepared;
  if (unchanged) return { id, skipped: true, idempotencyKey, ebay_listing_id: db.listings.get(id).ebay_publisher[destination].ebay_listing_id };
  if (env.EBAY_PUBLISH_ENABLED !== '1') throw publisher.stageError('configuration', 'eBay publication is switched off', 423);
  if (!client) {
    if (env === process.env) {
      if (!defaultClient || defaultClient.environment !== publisher.environment(env)) defaultClient = publisher.createClient({ env });
      client = defaultClient;
    } else {
      client = publisher.createClient({ env });
    }
  }
  const lockKey = publisher.environment(env) + ':' + listing.sku;
  const lock = running.get(lockKey);
  if (lock) {
    if (lock.id === id && lock.idempotencyKey === idempotencyKey) return lock.promise;
    throw publisher.stageError('offer', 'This SKU is already being processed', 409);
  }
  const promise = (async () => {
    const { offerId, listingId } = await publisher.publishListing(listing, client);
    const result = { offerId, ebay_listing_id: String(listingId), idempotencyKey, publishedAt: Date.now() };
    const updated = db.listings.update(id, (doc) => ({
      ...doc, ebay_listing_id: result.ebay_listing_id,
      ebay_publisher: { ...doc.ebay_publisher, [destination]: result }
    }));
    if (!updated) throw publisher.stageError('persistence', 'Listing was removed during publication', 409);
    await db.flush();
    return { id, ...result };
  })();
  running.set(lockKey, { id, idempotencyKey, promise });
  try { return await promise; }
  finally { running.delete(lockKey); }
}

async function syncBatch({ ids, limit = MAX_BATCH, dryRun = false } = {}, options = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH ||
      (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_BATCH || ids.some((id) => typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id))))) {
    throw publisher.stageError('validation', 'Supply up to 10 listing IDs and a limit from 1 to 10', 400);
  }
  const env = options.env || process.env;
  const chosen = ids ? [...new Set(ids)].slice(0, limit) : [];
  if (!ids) {
    for (const doc of db.listings.peek((item) => item.status === 'active')) {
      const prepared = validation(doc.id, env, doc);
      if (prepared.valid && !prepared.unchanged) chosen.push(doc.id);
      if (chosen.length === limit) break;
    }
  }
  const results = [];
  for (const id of chosen) {
    try {
      results.push(dryRun ? { id, ...validation(id, env) } : await publishOne(id, options));
    } catch (error) {
      if (!error.stage) throw error;
      results.push({ id, error: error.message, stage: error.stage, details: error.details });
    }
  }
  return { dryRun, results };
}

module.exports = { validation, publishOne, syncBatch };

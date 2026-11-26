'use strict';

const { createHash } = require('node:crypto');
const SCOPES = ['api_scope/sell.inventory', 'api_scope/sell.account']
  .map((scope) => 'https://api.ebay.com/oauth/' + scope).join(' ');

const MARKETS = {
  EBAY_GB: ['en-GB', 'GBP'], EBAY_DE: ['de-DE', 'EUR'], EBAY_FR: ['fr-FR', 'EUR'],
  EBAY_IT: ['it-IT', 'EUR'], EBAY_ES: ['es-ES', 'EUR'], EBAY_US: ['en-US', 'USD'],
  EBAY_CA: ['en-CA', 'CAD'], EBAY_AU: ['en-AU', 'AUD']
};
const LOCATION_KEY = 'KINAN_MALTA_HQ';
const POLICIES = ['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId'];
const hash = (data) => createHash('sha256').update(data).digest('hex');
const environment = (env = process.env) => String(env.EBAY_ENV || '').toLowerCase() === 'production' ? 'production' : 'sandbox';

function stageError(stage, message, status = 502, details) {
  return Object.assign(new Error(message), { stage, code: 'EBAY_' + stage.toUpperCase(), status, details });
}

function directImage(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !/(^|\/)(redirect|proxy)(\/|$)/i.test(url.pathname) && ![...url.searchParams.keys()].some((key) => ['url', 'redirect', 'target'].includes(key.toLowerCase())) &&
      /\.(jpe?g|png|webp|gif)$/i.test(url.pathname);
  } catch { return false; }
}

function validateEbayListing(input = {}) {
  const listing = {
    sku: String(input.sku ?? '').trim(),
    title: typeof input.title === 'string' ? input.title.trim() : '',
    description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : '',
    price: Number(input.price), quantity: Number(input.quantity),
    imageUrls: input.imageUrls,
    aspects: input.aspects,
    categoryId: String(input.categoryId ?? '').trim(),
    marketplaceId: input.marketplaceId || 'EBAY_GB',
    merchantLocationKey: input.merchantLocationKey === undefined ? LOCATION_KEY : String(input.merchantLocationKey).trim(),
    listingPolicies: Object.fromEntries(POLICIES.map((key) => [key, String(input.listingPolicies?.[key] ?? '').trim()]))
  };
  const issues = {};
  if (!/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,50}$/.test(listing.sku)) issues.sku = 'Use 1–50 letters, digits, periods, underscores or hyphens';
  if (![...listing.title].length || [...listing.title].length > 80) issues.title = 'Title must be 1–80 characters';
  if (!Number.isFinite(listing.price) || listing.price < 0.01 || typeof input.price === 'boolean') issues.price = 'Price must be positive in currency minor units';
  if (!Number.isSafeInteger(listing.quantity) || listing.quantity < 1 || typeof input.quantity === 'boolean') issues.quantity = 'Stock must be a positive integer';
  if (!Array.isArray(listing.imageUrls) || !listing.imageUrls.length || listing.imageUrls.length > 12 ||
      !listing.imageUrls.every(directImage)) issues.imageUrls = 'Provide 1–12 direct HTTPS image URLs';
  if (listing.aspects !== undefined &&
      (!listing.aspects || typeof listing.aspects !== 'object' || Array.isArray(listing.aspects) ||
       Object.entries(listing.aspects).some(([name, values]) => !name.trim() || !Array.isArray(values) ||
         !values.length || values.some((value) => typeof value !== 'string' || !value.trim())))) {
    issues.aspects = 'Item specifics must be non-empty lists of strings';
  }
  if (!/^[1-9]\d*$/.test(listing.categoryId)) issues.categoryId = 'Category ID is required';
  for (const key of POLICIES) if (!/^\d+$/.test(listing.listingPolicies[key])) issues[key] = 'Policy ID is required';
  if (input.merchantLocationKey === null || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,50}$/.test(listing.merchantLocationKey)) issues.merchantLocationKey = 'Invalid inventory location key';
  if (!Object.hasOwn(MARKETS, listing.marketplaceId)) issues.marketplaceId = 'Unsupported marketplace';
  if (Object.keys(issues).length) return { valid: false, issues };
  if (listing.aspects) listing.aspects = Object.fromEntries(Object.entries(listing.aspects).sort(([a], [b]) => a.localeCompare(b)));
  listing.price = listing.price.toFixed(2);
  listing.description ||= listing.title;
  return { valid: true, listing };
}

function createClient({ env = process.env, fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
  const target = environment(env);
  const base = target === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
  let cached;
  let refreshing;

  async function accessToken() {
    if (cached && cached.expiresAt > now()) return cached.token;
    if (refreshing) return refreshing;
    const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN } = env;
    if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN) throw stageError('oauth', 'eBay OAuth credentials are incomplete', 503);
    refreshing = (async () => {
      const response = await fetcher(base + '/identity/v1/oauth2/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: 'Basic ' + Buffer.from(EBAY_CLIENT_ID + ':' + EBAY_CLIENT_SECRET).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: EBAY_REFRESH_TOKEN, scope: SCOPES })
      });
      const data = await response.json();
      if (!response.ok || typeof data.access_token !== 'string' || !data.access_token || (!Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0)) {
        throw stageError('oauth', 'eBay rejected the OAuth refresh', 422);
      }
      const lifetime = Number(data.expires_in) * 1000;
      cached = { token: data.access_token, expiresAt: now() + lifetime - Math.min(120000, lifetime / 5) };
      return cached.token;
    })().catch((error) => { throw error.stage ? error : stageError('oauth', 'eBay OAuth did not respond'); });
    try { return await refreshing; }
    finally { refreshing = null; }
  }

  async function request(stage, method, path, { body, query, marketplace = 'EBAY_GB' } = {}) {
    const token = await accessToken();
    const [lang] = MARKETS[marketplace] || MARKETS.EBAY_GB;
    const url = base + path + (query ? '?' + new URLSearchParams(query) : '');
    let response;
    try {
      response = await fetcher(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Accept-Language': lang,
          'Content-Language': lang, 'X-EBAY-C-MARKETPLACE-ID': marketplace,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch { throw stageError(stage, 'eBay did not respond during ' + stage); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && cached?.token === token) cached = null;
      const ids = Array.isArray(data.errors) ? data.errors.map((item) => Number(item?.errorId)).filter(Number.isSafeInteger) : [];
      const error = stageError(stage, 'eBay rejected ' + stage + ' (HTTP ' + response.status + ')',
        response.status >= 500 ? 502 : 422, { errorIds: ids });
      error.ebayStatus = response.status;
      throw error;
    }
    return data;
  }
  return { environment: target, request };
}

const inventoryPath = '/sell/inventory/v1';
async function publishListing(listing, client) {
  const { sku, marketplaceId, quantity, title, description, categoryId, listingPolicies, merchantLocationKey, price, imageUrls, aspects } = listing;
  const options = { marketplace: marketplaceId };
  const [, currency] = MARKETS[marketplaceId];
  await client.request('inventory', 'PUT', inventoryPath + '/inventory_item/' + encodeURIComponent(sku), {
    ...options, body: { availability: { shipToLocationAvailability: { quantity } },
      condition: 'NEW', product: { title, description, imageUrls, aspects } }
  });

  const offerBody = { sku, marketplaceId, format: 'FIXED_PRICE', availableQuantity: quantity, categoryId,
    listingDescription: description, listingPolicies, merchantLocationKey, pricingSummary: { price: { value: price, currency } } };
  const offerPath = inventoryPath + '/offer';
  const offers = await client.request('offer', 'GET', offerPath, {
    ...options, query: { sku, marketplace_id: marketplaceId, format: 'FIXED_PRICE' }
  }).catch((error) => {
    // eBay uses error 25713 when no offers exist for a SKU.
    if ([400, 404].includes(error.ebayStatus) && error.details?.errorIds?.includes(25713)) return { offers: [] };
    throw error;
  });
  if (offers.offers !== undefined && !Array.isArray(offers.offers)) throw stageError('offer', 'Invalid eBay offer response');
  const matches = (offers.offers || []).filter((offer) => offer.marketplaceId === marketplaceId && offer.format === 'FIXED_PRICE');
  if (matches.length > 1) throw stageError('offer', 'More than one matching eBay offer exists', 409);
  const existing = matches[0];
  let offerId = existing?.offerId;
  if (offerId) {
    // updateOffer replaces the offer. Preserve applicable optional settings it already has.
    const optional = ['charity', 'storeCategoryNames', 'tax', 'extendedProducerResponsibility', 'hideBuyerDetails',
      'includeCatalogProductDetails', 'listingDuration', 'listingStartDate', 'lotSize', 'regulatory', 'quantityLimitPerBuyer'];
    const retained = Object.fromEntries(optional.filter((key) => existing[key] !== undefined).map((key) => [key, existing[key]]));
    await client.request('offer', 'PUT', offerPath + '/' + encodeURIComponent(offerId), { ...options, body: { ...retained, ...offerBody } });
    if (existing.status === 'PUBLISHED' && existing.listing?.listingId) {
      return { offerId, listingId: existing.listing.listingId };
    }
  } else {
    const created = await client.request('offer', 'POST', offerPath, { ...options, body: offerBody });
    offerId = created.offerId;
  }
  if (!offerId) throw stageError('offer', 'eBay did not return an offer ID');
  const published = await client.request('publish', 'POST', offerPath + '/' + encodeURIComponent(offerId) + '/publish', options);
  if (!published.listingId) throw stageError('publish', 'eBay did not return a listing ID');
  return { offerId, listingId: published.listingId };
}
module.exports = { validateEbayListing, createClient, publishListing, stageError, environment, hash, LOCATION_KEY, MARKETS };

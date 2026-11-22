// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* KINAN for Shopify (Batch 4): connects a partner store's Shopify shop to the Partner API, run by KINAN.
 *
 *   KINAN catalogue ──► Shopify   products created as DRAFT (the merchant reviews and publishes them), stock kept in
 *                                  sync, KINAN ids and the wholesale price in metafields. The merchant's retail price,
 *                                  title and description are never overwritten unless settings.auto_price /
 *                                  settings.update_content say so. Withdrawn products go to 0 stock + tag.
 *   Shopify paid order ──► KINAN   quote + order through the Partner API (only the KINAN lines), exactly once per
 *                                  Shopify order: webhook (orders/paid) and a polling fallback for lost webhooks share
 *                                  one claim row; the Partner API order reference and Idempotency-Key are derived from
 *                                  the Shopify order id.
 *   Shopify cancellation ──► KINAN cancellation request.
 *   KINAN shipment ──► Shopify     fulfillment with carrier and tracking number on the matching fulfillment-order lines.
 *   app/uninstalled, shop/redact   credentials wiped / connection data deleted. customers/* privacy requests are
 *                                  recorded for KINAN staff.
 * Everything runs behind PARTNER_ORDERS_ENABLED=1 and PARTNER_SHOPIFY_ENABLED=1, and only for sandbox partner stores
 * until live is approved. No Shopify call ever runs inside a SQL transaction. */
'use strict';
const crypto = require('crypto');
const pg = require('../pg');
const db = require('../../db');
const catalog = require('../catalog');
const orders = require('../orders');
const { PartnerError } = catalog;
const C = require('./shopify-client');
const { rid, J, sha } = orders.internal;

const SCOPES = ['read_products', 'write_products', 'read_inventory', 'write_inventory', 'read_locations', 'read_orders', 'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders'];
const DEFAULTS = { market: 'DE', locale: 'de-DE', initial_markup_pct: 100, update_content: false, auto_price: false, notify_customer: true, import_orders: true, include_images: true, default_quantity: 5, location_id: null };
const enabled = () => process.env.PARTNER_SHOPIFY_ENABLED === '1';
const publicBase = () => require('../../config').config.publicBaseUrl;
const legacyId = (gid) => String(gid || '').split('/').pop();
const short = (s) => sha(String(s)).slice(0, 12);
const errText = (e) => String(e?.message || e).slice(0, 300);

// ---------- connections ----------
function view(c) {
  return {
    id: c.id, env: c.env, store_id: c.store_id, platform: c.platform, shop_domain: c.shop_domain, state: c.state, scopes: c.scopes || '',
    settings: c.settings, has_catalog_cursor: !!c.catalog_cursor, orders_since: c.orders_since ? new Date(c.orders_since).getTime() : null,
    last_sync_at: c.last_sync_at ? new Date(c.last_sync_at).getTime() : null, last_error: c.last_error || null, created_at: new Date(c.created_at).getTime()
  };
}
async function get(id) { const c = (await pg.q('SELECT * FROM partner_connection WHERE id = $1', [id])).rows[0]; if (!c) throw httpErr(404, 'Connection not found'); return c; }
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function storeFor(storeId) {
  const st = db.partner_stores.get(storeId);
  if (!st) throw httpErr(404, 'Partner store not found');
  return st;
}
function ctxFor(c) { return { env: c.env, store: storeFor(c.store_id), key: { scopes: [] } }; }

/** Create the connection after the merchant authorised the app (or for KINAN's own dev store). */
async function upsertConnection({ storeId, shop, tokens, env = 'sandbox' }) {
  const st = storeFor(storeId);
  if (st.status !== 'active') throw httpErr(409, 'The partner store is paused');
  const missing = SCOPES.filter((s) => !(tokens.scope || '').split(',').includes(s) && !(s.startsWith('read_') && (tokens.scope || '').split(',').includes(`write_${s.slice(5)}`)));
  if (missing.length) throw httpErr(403, `Shopify did not grant: ${missing.join(', ')}`);
  const other = (await pg.q(`SELECT id, store_id FROM partner_connection WHERE env = $1 AND store_id = $2 AND platform = 'shopify' AND shop_domain <> $3 AND state <> 'uninstalled'`, [env, storeId, shop])).rows[0];
  if (other) throw httpErr(409, 'This partner store is already connected to another Shopify shop');
  const existing = (await pg.q(`SELECT * FROM partner_connection WHERE platform = 'shopify' AND shop_domain = $1`, [shop])).rows[0];
  if (existing && existing.store_id !== storeId && existing.state !== 'uninstalled') throw httpErr(409, 'This Shopify shop is connected to another partner store');
  const sealed = J(orders.internal.seal(env, tokens));
  let c;
  if (existing) {
    c = (await pg.q(`UPDATE partner_connection SET store_id = $2, env = $3, state = 'active', credentials = $4, scopes = $5, last_error = NULL, updated_at = now()
                     ${existing.store_id !== storeId ? ', catalog_cursor = NULL' : ''} WHERE id = $1 RETURNING *`, [existing.id, storeId, env, sealed, tokens.scope || ''])).rows[0];
  } else {
    c = (await pg.q(`INSERT INTO partner_connection (id, env, store_id, platform, shop_domain, state, credentials, scopes, settings, orders_since)
                     VALUES ($1,$2,$3,'shopify',$4,'active',$5,$6,$7, now()) RETURNING *`, [rid('pcn'), env, storeId, shop, sealed, tokens.scope || '', J({ ...DEFAULTS, market: (st.entitlements.markets || ['DE'])[0] })])).rows[0];
  }
  await registerWebhooks(c).catch((e) => pg.q('UPDATE partner_connection SET last_error = $2 WHERE id = $1', [c.id, `Webhooks not registered yet: ${errText(e)}`]));
  return view(c);
}

/** Refuse early (before any token is requested) when the store already has another Shopify shop. */
async function assertFree(storeId, shop, env = 'sandbox') {
  const other = (await pg.q(`SELECT id FROM partner_connection WHERE env = $1 AND store_id = $2 AND platform = 'shopify' AND shop_domain <> $3 AND state <> 'uninstalled'`, [env, storeId, shop])).rows[0];
  if (other) throw httpErr(409, 'This partner store is already connected to another Shopify shop');
}

// ---------- OAuth install (authorization code grant, expiring offline tokens) ----------
async function installUrl(storeId, shop) {
  if (!C.configured()) throw httpErr(503, 'Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET first (KINAN app in the Shopify Dev Dashboard).');
  shop = String(shop || '').trim().toLowerCase();
  if (!C.validShop(shop)) throw httpErr(400, 'Enter the shop as name.myshopify.com');
  storeFor(storeId); await assertFree(storeId, shop);
  const state = crypto.randomBytes(24).toString('base64url');
  await pg.q(`DELETE FROM partner_connection_oauth WHERE created_at < now() - interval '1 hour'`);
  await pg.q('INSERT INTO partner_connection_oauth (state, store_id, shop_domain) VALUES ($1,$2,$3)', [state, storeId, shop]);
  const q = new URLSearchParams({ client_id: C.appKey(), scope: SCOPES.join(','), redirect_uri: `${publicBase()}/api/partner/connect/shopify/callback`, state });
  return { install_url: `https://${shop}/admin/oauth/authorize?${q}`, expires_in_minutes: 10 };
}
/** Shopify's HMAC over the sorted query (without hmac), hex, constant-time compare. */
function validQueryHmac(params) {
  const given = String(params.hmac || '');
  const msg = Object.keys(params).filter((k) => k !== 'hmac' && k !== 'signature').sort().map((k) => `${k}=${params[k]}`).join('&');
  const want = crypto.createHmac('sha256', C.appSecret()).update(msg).digest('hex');
  return given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}
async function callback(params) {
  if (!C.configured()) throw httpErr(503, 'Shopify app not configured');
  const shop = String(params.shop || '').toLowerCase();
  if (!C.validShop(shop)) throw httpErr(400, 'Invalid shop');
  if (!validQueryHmac(params)) throw httpErr(401, 'Invalid signature');
  if (Math.abs(Date.now() / 1000 - Number(params.timestamp || 0)) > 3600) throw httpErr(401, 'Link expired, start the installation again');
  const st = (await pg.q(`DELETE FROM partner_connection_oauth WHERE state = $1 AND shop_domain = $2 AND created_at > now() - interval '10 minutes' RETURNING *`, [String(params.state || ''), shop])).rows[0];
  if (!st) throw httpErr(403, 'Invalid or expired state, start the installation again');
  const tokens = await C.exchangeCode(shop, String(params.code || ''));
  return upsertConnection({ storeId: st.store_id, shop, tokens });
}
/** KINAN's own development store (same Shopify organisation): client credentials grant, no merchant redirect. */
async function connectDevStore(storeId, shop) {
  if (!C.configured()) throw httpErr(503, 'Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET first.');
  shop = String(shop || '').trim().toLowerCase();
  if (!C.validShop(shop)) throw httpErr(400, 'Enter the shop as name.myshopify.com');
  storeFor(storeId); await assertFree(storeId, shop);
  const tokens = await C.clientCredentials(shop);
  return upsertConnection({ storeId, shop, tokens });
}

const TOPICS = ['ORDERS_PAID', 'ORDERS_CANCELLED', 'APP_UNINSTALLED'];
async function registerWebhooks(c) {
  const uri = `${publicBase()}/api/partner/connect/shopify/webhooks`;
  if (!/^https:\/\//.test(uri)) return { skipped: 'PUBLIC_BASE_URL is not https; relying on polling' };
  const have = (await C.gql(c, `query KinanWebhooks { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`)).webhookSubscriptions.nodes;
  for (const topic of TOPICS) {
    if (have.some((h) => h.topic === topic && h.uri === uri)) continue;
    const d = await C.gql(c, `mutation KinanWebhookCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`, { topic, sub: { uri } });
    C.ok(d.webhookSubscriptionCreate, `webhook ${topic}`);
  }
  return { registered: TOPICS.length };
}

// ---------- catalogue → Shopify ----------
async function locationId(c) {
  if (c.settings.location_id) return c.settings.location_id;
  const nodes = (await C.gql(c, 'query KinanLocations { locations(first: 5) { nodes { id name isActive } } }')).locations.nodes.filter((l) => l.isActive !== false);
  if (!nodes.length) throw new C.ShopifyError('The shop has no active location');
  c.settings = { ...c.settings, location_id: nodes[0].id };
  await pg.q('UPDATE partner_connection SET settings = $2 WHERE id = $1', [c.id, J(c.settings)]);
  return nodes[0].id;
}
const quantityOf = (c, v) => (v.availability?.state === 'in_stock' ? Math.max(0, Math.min(v.availability.sellable_quantity ?? c.settings.default_quantity, 9999)) : 0);
/** First retail price: wholesale × (1 + markup), rounded up to .99. The merchant can change it afterwards. */
function retail(c, v) { const w = v.wholesale_unit_price_ex_tax.amount_minor; const m = Math.ceil((w * (1 + (Number(c.settings.initial_markup_pct) || 0) / 100)) / 100) * 100 - 1; return (Math.max(m, w) / 100).toFixed(2); }
const esc = (s) => String(s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function productInput(c, p, loc) {
  const keys = [...new Set(p.variants.flatMap((v) => Object.keys(v.options || {})))].slice(0, 3);
  const optionValue = (v, k) => String(v.options?.[k] ?? '—').slice(0, 255);
  const productOptions = keys.length ? keys.map((k, i) => ({ name: cap(k), position: i + 1, values: [...new Set(p.variants.map((v) => optionValue(v, k)))].map((name) => ({ name })) }))
    : [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }];
  const media = c.settings.include_images ? (p.media || []).filter((m) => /^https:\/\//.test(m.url) && !/\.example\.(com|org|net)\//.test(m.url)).slice(0, 10) : [];
  return {
    handle: `kinan-${p.product_id.replace(/_/g, '-')}`, title: p.title, descriptionHtml: `<p>${esc(p.description)}</p>`, vendor: 'KINAN', status: 'DRAFT', tags: ['kinan'],
    productOptions,
    metafields: [{ namespace: 'kinan', key: 'product_id', type: 'single_line_text_field', value: p.product_id }],
    ...(media.length ? { files: media.map((m) => ({ originalSource: m.url, alt: m.alt || p.title, contentType: 'IMAGE' })) } : {}),
    variants: p.variants.map((v) => ({
      optionValues: keys.length ? keys.map((k) => ({ optionName: cap(k), name: optionValue(v, k) })) : [{ optionName: 'Title', name: 'Default Title' }],
      sku: v.sku, price: retail(c, v), inventoryPolicy: 'DENY', inventoryItem: { tracked: true },
      inventoryQuantities: [{ locationId: loc, name: 'available', quantity: quantityOf(c, v) }],
      metafields: [{ namespace: 'kinan', key: 'variant_id', type: 'single_line_text_field', value: v.variant_id },
        { namespace: 'kinan', key: 'wholesale_price', type: 'money', value: JSON.stringify({ amount: (v.wholesale_unit_price_ex_tax.amount_minor / 100).toFixed(2), currency_code: 'EUR' }) }]
    }))
  };
}

async function setQuantities(c, productId, version, items) {
  if (!items.length) return;
  const loc = await locationId(c);
  for (let i = 0; i < items.length; i += 250) {
    const part = items.slice(i, i + 250);
    const key = sha(`${c.id}|${productId}|${version}|${JSON.stringify(part)}`).slice(0, 40);
    const d = await C.gql(c, `mutation KinanInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) @idempotent(key: "${key}") { inventoryAdjustmentGroup { id } userErrors { field message code } } }`,
    { input: { name: 'available', reason: 'correction', referenceDocumentUri: `kinan://partner-catalog/${c.id}/${productId}`, quantities: part.map((x) => ({ inventoryItemId: x.inventory_item_id, locationId: loc, quantity: x.quantity, changeFromQuantity: null })) } });
    C.ok(d.inventorySetQuantities, 'inventory');
    for (const x of part) await pg.q('UPDATE partner_connection_variant SET last_quantity = $3 WHERE connection_id = $1 AND variant_id = $2', [c.id, x.variant_id, x.quantity]);
  }
}

async function upsertProduct(c, p) {
  const row = (await pg.q('SELECT * FROM partner_connection_product WHERE connection_id = $1 AND product_id = $2', [c.id, p.product_id])).rows[0];
  if (!row) {
    // create once as a draft; the handle makes a retried create update the same product instead of duplicating it
    const loc = await locationId(c);
    const input = productInput(c, p, loc);
    const d = await C.gql(c, `mutation KinanProductSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
      productSet(input: $input, identifier: $identifier, synchronous: true) { product { id variants(first: 100) { nodes { id sku inventoryItem { id } } } } userErrors { field message code } } }`,
    { input, identifier: { handle: input.handle } });
    const prod = C.ok(d.productSet, 'productSet').product;
    for (const v of p.variants) {
      const sv = prod.variants.nodes.find((x) => x.sku === v.sku);
      if (!sv) continue;
      await pg.q(`INSERT INTO partner_connection_variant (connection_id, variant_id, product_id, external_variant_id, inventory_item_id, last_quantity) VALUES ($1,$2,$3,$4,$5,$6)
                  ON CONFLICT (connection_id, variant_id) DO UPDATE SET external_variant_id = EXCLUDED.external_variant_id, inventory_item_id = EXCLUDED.inventory_item_id, last_quantity = EXCLUDED.last_quantity`,
      [c.id, v.variant_id, p.product_id, sv.id, sv.inventoryItem.id, quantityOf(c, v)]);
    }
    await pg.q(`INSERT INTO partner_connection_product (connection_id, product_id, external_product_id, version, status) VALUES ($1,$2,$3,$4,'active')
                ON CONFLICT (connection_id, product_id) DO UPDATE SET external_product_id = EXCLUDED.external_product_id, version = EXCLUDED.version, status = 'active', updated_at = now()`, [c.id, p.product_id, prod.id, p.version]);
    return 'created';
  }
  if (p.version <= row.version && row.status === 'active') return 'unchanged';
  if (row.status === 'withdrawn') C.ok((await C.gql(c, 'mutation KinanTagsRemove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }', { id: row.external_product_id, tags: ['kinan-withdrawn'] })).tagsRemove, 'tagsRemove');
  if (c.settings.update_content) {
    C.ok((await C.gql(c, 'mutation KinanProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }',
      { product: { id: row.external_product_id, title: p.title, descriptionHtml: `<p>${esc(p.description)}</p>` } })).productUpdate, 'productUpdate');
  }
  const maps = (await pg.q('SELECT * FROM partner_connection_variant WHERE connection_id = $1 AND product_id = $2', [c.id, p.product_id])).rows;
  if (c.settings.auto_price) {
    const variants = p.variants.map((v) => ({ v, m: maps.find((x) => x.variant_id === v.variant_id) })).filter((x) => x.m).map(({ v, m }) => ({ id: m.external_variant_id, price: retail(c, v) }));
    if (variants.length) C.ok((await C.gql(c, 'mutation KinanPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }', { productId: row.external_product_id, variants })).productVariantsBulkUpdate, 'prices');
  }
  const changes = p.variants.map((v) => ({ v, m: maps.find((x) => x.variant_id === v.variant_id) })).filter((x) => x.m && x.m.last_quantity !== quantityOf(c, x.v))
    .map(({ v, m }) => ({ variant_id: v.variant_id, inventory_item_id: m.inventory_item_id, quantity: quantityOf(c, v) }));
  await setQuantities(c, p.product_id, p.version, changes);
  await pg.q(`UPDATE partner_connection_product SET version = $3, status = 'active', updated_at = now() WHERE connection_id = $1 AND product_id = $2`, [c.id, p.product_id, p.version]);
  return 'updated';
}

async function withdrawProduct(c, productId, version) {
  const row = (await pg.q('SELECT * FROM partner_connection_product WHERE connection_id = $1 AND product_id = $2', [c.id, productId])).rows[0];
  if (!row || row.status === 'withdrawn') return 'ignored';
  const maps = (await pg.q('SELECT * FROM partner_connection_variant WHERE connection_id = $1 AND product_id = $2', [c.id, productId])).rows;
  await setQuantities(c, productId, `w${version}`, maps.filter((m) => m.last_quantity !== 0).map((m) => ({ variant_id: m.variant_id, inventory_item_id: m.inventory_item_id, quantity: 0 })));
  C.ok((await C.gql(c, 'mutation KinanTagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }', { id: row.external_product_id, tags: ['kinan-withdrawn'] })).tagsAdd, 'tagsAdd');
  await pg.q(`UPDATE partner_connection_product SET status = 'withdrawn', version = GREATEST(version, $3), updated_at = now() WHERE connection_id = $1 AND product_id = $2`, [c.id, productId, Number(version) || row.version]);
  return 'withdrawn';
}

async function setCursor(c, cursor) { c.catalog_cursor = cursor; await pg.q('UPDATE partner_connection SET catalog_cursor = $2, updated_at = now() WHERE id = $1', [c.id, cursor]); }
/** Initial snapshot (when there is no cursor), then the change feed. Safe to rerun: creation is keyed by handle. */
async function syncCatalog(c, { maxPages = 20 } = {}) {
  const ctx = ctxFor(c); const s = c.settings; const out = { created: 0, updated: 0, withdrawn: 0, unchanged: 0, ignored: 0 };
  const tally = (r) => { out[r] = (out[r] || 0) + 1; };
  if (!c.catalog_cursor) {
    let cursor = ''; let page;
    do {
      page = catalog.snapshot(ctx, { market: s.market, locale: s.locale, limit: 50, cursor });
      for (const p of page.data) tally(await upsertProduct(c, p));
      cursor = page.next_cursor;
    } while (cursor);
    await setCursor(c, page.sync_cursor);
    return out;
  }
  for (let n = 0; n < maxPages; n += 1) {
    let ch;
    try { ch = catalog.changes(ctx, { market: s.market, locale: s.locale, cursor: c.catalog_cursor, limit: 100 }); } catch (e) {
      if (['CURSOR_EXPIRED', 'CURSOR_SCOPE_MISMATCH', 'INVALID_CURSOR'].includes(e.code)) { await setCursor(c, null); return syncCatalog(c); }
      throw e;
    }
    for (const ev of ch.data) tally(ev.type === 'upsert' ? await upsertProduct(c, ev.product) : await withdrawProduct(c, ev.product_id, ev.version));
    await setCursor(c, ch.next_cursor);
    if (!ch.has_more) break;
  }
  return out;
}

// ---------- Shopify orders → KINAN ----------
/** Order as both the webhook (REST JSON) and the GraphQL poll describe it. */
function fromWebhook(o) {
  const a = o.shipping_address || {};
  return {
    legacy_id: String(o.id), gid: o.admin_graphql_api_id || `gid://shopify/Order/${o.id}`, name: o.name, cancelled: !!o.cancelled_at,
    paid: ['paid', 'partially_refunded'].includes(o.financial_status),
    address: { name: a.name, address1: a.address1, address2: a.address2, city: a.city, zip: a.zip, country: a.country_code, phone: a.phone },
    lines: (o.line_items || []).filter((l) => l.variant_id).map((l) => ({ variant_gid: `gid://shopify/ProductVariant/${l.variant_id}`, quantity: Number(l.quantity) || 0 }))
  };
}
function fromGraphql(o) {
  const a = o.shippingAddress || {};
  return {
    legacy_id: String(o.legacyResourceId || legacyId(o.id)), gid: o.id, name: o.name, cancelled: !!o.cancelledAt, paid: ['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus),
    address: { name: a.name, address1: a.address1, address2: a.address2, city: a.city, zip: a.zip, country: a.countryCodeV2, phone: a.phone },
    lines: (o.lineItems?.nodes || []).filter((l) => l.variant?.id).map((l) => ({ variant_gid: l.variant.id, quantity: Number(l.quantity) || 0 }))
  };
}
const idemKey = (c, o, op = 'order') => `shopify-${op}-${o.legacy_id || o}-${short(c.id)}`;
const orderRef = (o) => `SHOPIFY-${o.legacy_id}`;

/** Import one paid Shopify order exactly once. Returns { state, partner_order_id?, reason? }. */
async function importOrder(c, o) {
  if (!c.settings.import_orders) return { state: 'off' };
  if (o.cancelled) return handleCancelled(c, o);
  if (!o.paid) return { state: 'not_paid' };
  let row = (await pg.q(`INSERT INTO partner_connection_order (connection_id, external_order_id, external_name, state, attempts) VALUES ($1,$2,$3,'importing',1)
                         ON CONFLICT DO NOTHING RETURNING *`, [c.id, o.legacy_id, o.name || null])).rows[0];
  if (!row) {
    row = (await pg.q(`UPDATE partner_connection_order SET state = 'importing', attempts = attempts + 1, updated_at = now()
                        WHERE connection_id = $1 AND external_order_id = $2
                          AND ((state = 'importing' AND updated_at < now() - interval '5 minutes') OR (state = 'failed' AND reason LIKE 'retry:%' AND attempts < 8))
                        RETURNING *`, [c.id, o.legacy_id])).rows[0];
    if (!row) { const cur = (await pg.q('SELECT state, partner_order_id FROM partner_connection_order WHERE connection_id = $1 AND external_order_id = $2', [c.id, o.legacy_id])).rows[0]; return { state: cur.state, partner_order_id: cur.partner_order_id, duplicate: true }; }
  }
  const finish = async (state, extra = {}) => {
    await pg.q('UPDATE partner_connection_order SET state = $3, partner_order_id = COALESCE($4, partner_order_id), reason = $5, updated_at = now() WHERE connection_id = $1 AND external_order_id = $2',
      [c.id, o.legacy_id, state, extra.partner_order_id || null, extra.reason || null]);
    return { state, ...extra };
  };
  const gids = o.lines.map((l) => l.variant_gid);
  const maps = gids.length ? (await pg.q('SELECT variant_id, external_variant_id FROM partner_connection_variant WHERE connection_id = $1 AND external_variant_id = ANY($2)', [c.id, gids])).rows : [];
  const items = new Map();
  for (const l of o.lines) { const m = maps.find((x) => x.external_variant_id === l.variant_gid); if (m && l.quantity > 0) items.set(m.variant_id, (items.get(m.variant_id) || 0) + l.quantity); }
  if (!items.size) return finish('skipped', { reason: 'no_kinan_items' });
  const a = o.address;
  const ctx = ctxFor(c);
  try {
    const q = await orders.createQuote(ctx, { currency: 'EUR', destination: { country: a.country, postal_code: a.zip }, items: [...items].map(([variant_id, quantity]) => ({ variant_id, quantity })) });
    const shipping = { recipient: a.name, line1: a.address1, ...(a.address2 ? { line2: a.address2 } : {}), city: a.city, postal_code: a.zip, country: a.country, ...(a.phone ? { phone: String(a.phone).slice(0, 30) } : {}) };
    const r = await orders.createOrder(ctx, { quote_id: q.quote_id, external_order_ref: orderRef(o), shipping_address: shipping }, idemKey(c, o));
    return finish('imported', { partner_order_id: r.body.order_id });
  } catch (e) {
    if (e instanceof PartnerError && ['IDEMPOTENCY_CONFLICT', 'ORDER_REFERENCE_CONFLICT'].includes(e.code)) {
      // an earlier attempt created it (crash between the Partner API commit and our bookkeeping)
      const found = (await orders.listOrders(ctx, { external_order_ref: orderRef(o), limit: 1 })).data[0];
      if (found) return finish('imported', { partner_order_id: found.order_id });
    }
    if (e instanceof PartnerError && e.status < 500) return finish('failed', { reason: `needs_attention: ${e.code}${e.detail ? ` — ${e.detail}` : ''}${e.extra?.errors ? ` ${JSON.stringify(e.extra.errors).slice(0, 200)}` : ''}`.slice(0, 500) });
    return finish('failed', { reason: `retry: ${errText(e)}` });
  }
}

async function handleCancelled(c, o) {
  const row = (await pg.q('SELECT * FROM partner_connection_order WHERE connection_id = $1 AND external_order_id = $2', [c.id, o.legacy_id])).rows[0];
  if (!row) { await pg.q(`INSERT INTO partner_connection_order (connection_id, external_order_id, external_name, state, reason) VALUES ($1,$2,$3,'cancelled','cancelled_in_shopify') ON CONFLICT DO NOTHING`, [c.id, o.legacy_id, o.name || null]); return { state: 'cancelled' }; }
  if (row.state !== 'imported' || !row.partner_order_id) { if (row.state !== 'cancelled') await pg.q(`UPDATE partner_connection_order SET state = 'cancelled', reason = 'cancelled_in_shopify', updated_at = now() WHERE connection_id = $1 AND external_order_id = $2`, [c.id, o.legacy_id]); return { state: 'cancelled' }; }
  if (/^cancellation_/.test(row.reason || '')) return { state: 'imported', cancellation: 'already_requested' };
  let reason;
  try {
    const r = await require('../fulfilment').requestCancellation(ctxFor(c), row.partner_order_id, { reason_code: 'customer_request', note: 'Cancelled in Shopify' }, idemKey(c, o, 'cancel'));
    reason = `cancellation_${r.body.state}`;
  } catch (e) {
    if (!(e instanceof PartnerError)) throw e;
    reason = e.code === 'CANCELLATION_PENDING' ? 'cancellation_requested' : `cancellation_refused: ${e.code}`;
  }
  await pg.q('UPDATE partner_connection_order SET reason = $3, updated_at = now() WHERE connection_id = $1 AND external_order_id = $2', [c.id, o.legacy_id, reason]);
  return { state: 'imported', cancellation: reason };
}

/** Polling fallback for lost webhooks: every order updated since the last poll (10 minutes overlap). */
async function pollOrders(c, { maxPages = 10 } = {}) {
  const since = new Date((c.orders_since ? new Date(c.orders_since).getTime() : Date.now() - 864e5) - 10 * 60e3).toISOString();
  const started = new Date(); let after = null; const out = { seen: 0, imported: 0 };
  for (let n = 0; n < maxPages; n += 1) {
    const d = await C.gql(c, `query KinanOrders($q: String!, $after: String) {
      orders(first: 25, after: $after, query: $q, sortKey: UPDATED_AT) {
        nodes { id legacyResourceId name updatedAt cancelledAt displayFinancialStatus
          shippingAddress { name address1 address2 city zip countryCodeV2 phone }
          lineItems(first: 100) { nodes { id quantity variant { id } } } }
        pageInfo { hasNextPage endCursor } } }`, { q: `updated_at:>='${since}'`, after });
    for (const node of d.orders.nodes) { out.seen += 1; const r = await importOrder(c, fromGraphql(node)); if (r.state === 'imported' && !r.duplicate) out.imported += 1; }
    if (!d.orders.pageInfo.hasNextPage) { await pg.q('UPDATE partner_connection SET orders_since = $2 WHERE id = $1', [c.id, started]); c.orders_since = started; break; }
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

// ---------- KINAN shipments → Shopify fulfillments ----------
async function writeBack(c, { limit = 20 } = {}) {
  const due = (await pg.q(`SELECT s.id, s.items, s.carrier, s.tracking_number, s.tracking_url, co.external_order_id
      FROM partner_shipment s JOIN partner_connection_order co ON co.partner_order_id = s.order_id AND co.connection_id = $1
      LEFT JOIN partner_connection_fulfillment f ON f.connection_id = co.connection_id AND f.shipment_id = s.id
     WHERE f.shipment_id IS NULL OR (f.state = 'failed' AND f.attempts < 10 AND f.updated_at < now() - interval '2 minutes')
        OR (f.state = 'creating' AND f.updated_at < now() - interval '5 minutes')
     ORDER BY s.created_at LIMIT $2`, [c.id, limit])).rows;
  const out = { done: 0, failed: 0 };
  for (const s of due) {
    const claim = (await pg.q(`INSERT INTO partner_connection_fulfillment (connection_id, shipment_id, state, attempts) VALUES ($1,$2,'creating',1)
        ON CONFLICT (connection_id, shipment_id) DO UPDATE SET state = 'creating', attempts = partner_connection_fulfillment.attempts + 1, updated_at = now()
        WHERE (partner_connection_fulfillment.state = 'failed' AND partner_connection_fulfillment.updated_at < now() - interval '2 minutes')
           OR (partner_connection_fulfillment.state = 'creating' AND partner_connection_fulfillment.updated_at < now() - interval '5 minutes')
        RETURNING attempts`, [c.id, s.id])).rows[0];
    if (!claim) continue;
    const done = async (state, extra = {}) => { await pg.q('UPDATE partner_connection_fulfillment SET state = $3, external_fulfillment_id = COALESCE($4, external_fulfillment_id), last_error = $5, updated_at = now() WHERE connection_id = $1 AND shipment_id = $2', [c.id, s.id, state, extra.id || null, extra.error || null]); out[state === 'done' ? 'done' : 'failed'] += 1; };
    try {
      const d = await C.gql(c, `query KinanOrderFulfil($id: ID!) { order(id: $id) {
          fulfillments(first: 20) { id trackingInfo(first: 5) { number } }
          fulfillmentOrders(first: 20) { nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { variant { id } } } } } } } }`, { id: `gid://shopify/Order/${s.external_order_id}` });
      const ord = d.order; if (!ord) { await done('failed', { error: 'Order not found in Shopify' }); continue; }
      const already = ord.fulfillments.find((f) => (f.trackingInfo || []).some((t) => t.number === s.tracking_number));
      if (already) { await done('done', { id: already.id }); continue; } // created before a crash: do not fulfil twice
      const maps = (await pg.q('SELECT variant_id, external_variant_id FROM partner_connection_variant WHERE connection_id = $1 AND variant_id = ANY($2)', [c.id, s.items.map((i) => i.variant_id)])).rows;
      const need = new Map(s.items.map((i) => [maps.find((m) => m.variant_id === i.variant_id)?.external_variant_id, i.quantity]).filter(([k]) => k));
      const groups = [];
      for (const fo of ord.fulfillmentOrders.nodes.filter((x) => ['OPEN', 'IN_PROGRESS'].includes(x.status))) {
        const lines = [];
        for (const li of fo.lineItems.nodes) {
          const v = li.lineItem?.variant?.id; const want = need.get(v) || 0; const q = Math.min(want, li.remainingQuantity);
          if (q > 0) { lines.push({ id: li.id, quantity: q }); need.set(v, want - q); }
        }
        if (lines.length) groups.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: lines });
      }
      if (!groups.length) { await done('failed', { error: 'Nothing left to fulfil in Shopify (already fulfilled by hand?)' }); continue; }
      let firstId = null;
      for (const g of groups) {
        const r = await C.gql(c, `mutation KinanFulfil($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id status } userErrors { field message } } }`,
          { fulfillment: { notifyCustomer: !!c.settings.notify_customer, trackingInfo: { company: s.carrier, number: s.tracking_number, ...(s.tracking_url ? { url: s.tracking_url } : {}) }, lineItemsByFulfillmentOrder: [g] } });
        firstId = firstId || C.ok(r.fulfillmentCreate, 'fulfillmentCreate').fulfillment.id;
      }
      await done('done', { id: firstId });
    } catch (e) { await done('failed', { error: errText(e) }); if (e.auth) throw e; }
  }
  return out;
}

// ---------- webhooks from Shopify ----------
function validWebhook(raw, header) {
  const want = crypto.createHmac('sha256', C.appSecret()).update(raw).digest('base64');
  const given = String(header || '');
  return !!C.appSecret() && given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}
/** Handle one webhook (raw body already verified by the caller). Returns a short status for logs and tests. */
async function onWebhook({ topic, shop, webhookId, body }) {
  if (webhookId) {
    const fresh = (await pg.q('INSERT INTO partner_connection_webhook (webhook_id, shop_domain, topic) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING webhook_id', [String(webhookId).slice(0, 100), shop, topic])).rowCount;
    if (!fresh) return 'duplicate';
  }
  if (topic === 'customers/data_request' || topic === 'customers/redact') {
    const ids = (body.orders_requested || body.orders_to_redact || []).map(String).slice(0, 500);
    await pg.q('INSERT INTO partner_connection_privacy (shop_domain, topic, order_ids) VALUES ($1,$2,$3)', [shop, topic, J(ids)]);
    return 'recorded';
  }
  if (topic === 'shop/redact') { await pg.q(`DELETE FROM partner_connection WHERE platform = 'shopify' AND shop_domain = $1`, [shop]); return 'deleted'; }
  const c = (await pg.q(`SELECT * FROM partner_connection WHERE platform = 'shopify' AND shop_domain = $1`, [shop])).rows[0];
  if (!c) return 'unknown_shop';
  if (topic === 'app/uninstalled') { await pg.q(`UPDATE partner_connection SET state = 'uninstalled', credentials = NULL, last_error = 'The merchant removed the app', updated_at = now() WHERE id = $1`, [c.id]); return 'uninstalled'; }
  if (c.state !== 'active') return `ignored_${c.state}`;
  if (topic === 'orders/paid' || topic === 'orders/cancelled') return (await importOrder(c, fromWebhook(body))).state;
  return 'ignored_topic';
}

// ---------- worker ----------
/** One full pass for a connection: catalogue, orders (lost-webhook fallback) and tracking write-back. */
async function syncOnce(c) {
  if (typeof c === 'string') c = await get(c);
  if (c.state !== 'active') return { skipped: c.state };
  const st = db.partner_stores.get(c.store_id);
  if (!st || st.status !== 'active') return { skipped: 'store_paused' };
  const out = {};
  try {
    out.catalog = await syncCatalog(c);
    out.orders = await pollOrders(c);
    out.fulfilments = await writeBack(c);
    await pg.q('UPDATE partner_connection SET last_sync_at = now(), last_error = NULL WHERE id = $1', [c.id]);
  } catch (e) {
    await pg.q('UPDATE partner_connection SET last_sync_at = now(), last_error = $2 WHERE id = $1', [c.id, errText(e)]);
    out.error = errText(e); out.auth = !!e.auth;
  }
  return out;
}
async function syncAll() {
  const list = (await pg.q(`SELECT * FROM partner_connection WHERE state = 'active' ORDER BY last_sync_at NULLS FIRST LIMIT 50`)).rows;
  for (const c of list) await syncOnce(c);
  return list.length;
}

// ---------- admin ----------
async function adminList() {
  const rows = (await pg.q(`SELECT c.*,
      (SELECT count(*) FROM partner_connection_product p WHERE p.connection_id = c.id AND p.status = 'active')::int AS products,
      (SELECT count(*) FROM partner_connection_order o WHERE o.connection_id = c.id AND o.state = 'imported')::int AS orders_imported,
      (SELECT count(*) FROM partner_connection_fulfillment f WHERE f.connection_id = c.id AND f.state = 'done')::int AS fulfilments_done
    FROM partner_connection c ORDER BY c.created_at DESC`)).rows;
  const problems = (await pg.q(`SELECT o.connection_id, o.external_order_id, o.external_name, o.state, o.reason, o.updated_at FROM partner_connection_order o
                                 WHERE o.state = 'failed' OR (o.state = 'importing' AND o.updated_at < now() - interval '5 minutes') ORDER BY o.updated_at DESC LIMIT 50`)).rows;
  const fulfilFails = (await pg.q(`SELECT connection_id, shipment_id, last_error, attempts FROM partner_connection_fulfillment WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 50`)).rows;
  const privacy = (await pg.q(`SELECT id, shop_domain, topic, order_ids, received_at FROM partner_connection_privacy WHERE state = 'open' ORDER BY received_at`)).rows;
  return {
    enabled: enabled(), configured: C.configured(), api_version: C.VERSION(), scopes: SCOPES,
    connections: rows.map((r) => ({ ...view(r), products: r.products, orders_imported: r.orders_imported, fulfilments_done: r.fulfilments_done })),
    order_problems: problems.map((p) => ({ ...p, updated_at: new Date(p.updated_at).getTime() })), fulfilment_problems: fulfilFails,
    privacy_requests: privacy.map((p) => ({ ...p, received_at: new Date(p.received_at).getTime() }))
  };
}
const SETTINGS = { market: (v) => /^[A-Z]{2}$/.test(v), locale: (v) => /^[a-z]{2}(-[A-Z]{2})?$/.test(v), initial_markup_pct: (v) => Number.isFinite(v) && v >= 0 && v <= 1000, update_content: (v) => typeof v === 'boolean', auto_price: (v) => typeof v === 'boolean', notify_customer: (v) => typeof v === 'boolean', import_orders: (v) => typeof v === 'boolean', include_images: (v) => typeof v === 'boolean', default_quantity: (v) => Number.isInteger(v) && v >= 0 && v <= 999 };
async function adminUpdate(id, body = {}) {
  const c = await get(id);
  let settings = c.settings;
  if (body.settings) {
    for (const [k, v] of Object.entries(body.settings)) { if (!SETTINGS[k] || !SETTINGS[k](v)) throw httpErr(400, `Invalid setting ${k}`); }
    settings = { ...settings, ...body.settings };
  }
  const resetCursor = settings.market !== c.settings.market || settings.locale !== c.settings.locale;
  let state = c.state;
  if (body.state !== undefined) {
    if (!['active', 'paused'].includes(body.state)) throw httpErr(400, 'state must be active or paused');
    if (['uninstalled', 'auth_failed'].includes(c.state) && body.state === 'active') throw httpErr(409, 'The merchant must install the app again first');
    state = body.state;
  }
  const u = (await pg.q(`UPDATE partner_connection SET settings = $2, state = $3, ${resetCursor ? 'catalog_cursor = NULL,' : ''} updated_at = now() WHERE id = $1 RETURNING *`, [id, J(settings), state])).rows[0];
  return view(u);
}
async function adminRetryOrder(id, externalOrderId) {
  const r = await pg.q(`UPDATE partner_connection_order SET state = 'failed', reason = 'retry: requested by admin', attempts = 0, updated_at = now() - interval '10 minutes' WHERE connection_id = $1 AND external_order_id = $2 AND state IN ('failed','importing') RETURNING *`, [id, String(externalOrderId)]);
  if (!r.rowCount) throw httpErr(409, 'Only failed or stuck orders can be retried');
  await pg.q('UPDATE partner_connection SET orders_since = LEAST(orders_since, $2) WHERE id = $1', [id, new Date(r.rows[0].created_at)]);
  return { queued: true };
}
async function adminDisconnect(id) {
  const u = (await pg.q(`UPDATE partner_connection SET state = 'uninstalled', credentials = NULL, last_error = 'Disconnected by KINAN admin', updated_at = now() WHERE id = $1 RETURNING *`, [id])).rows[0];
  if (!u) throw httpErr(404, 'Connection not found');
  return { ...view(u), note: 'Credentials deleted. Ask the merchant to remove the KINAN app in their Shopify admin as well.' };
}
async function adminPrivacyDone(id) { await pg.q(`UPDATE partner_connection_privacy SET state = 'done' WHERE id = $1`, [id]); return { ok: true }; }

module.exports = {
  SCOPES, DEFAULTS, enabled, installUrl, callback, connectDevStore, upsertConnection, registerWebhooks, validQueryHmac, validWebhook, onWebhook,
  syncCatalog, upsertProduct, withdrawProduct, importOrder, pollOrders, writeBack, syncOnce, syncAll, fromWebhook, fromGraphql,
  adminList, adminUpdate, adminRetryOrder, adminDisconnect, adminPrivacyDone, get, view
};

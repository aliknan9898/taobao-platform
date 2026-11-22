// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Platform-neutral part of the KINAN store connectors (Shopify, WooCommerce):
 * connections, the catalogue loop (snapshot then change feed), importing platform orders into the Partner API exactly
 * once, forwarding cancellations, the sync pass and admin actions. Each platform module supplies an adapter:
 *   { enabled(), upsertProduct(c, p), withdrawProduct(c, productId, version), pollOrders(c), writeBack(c), beforeSync?(c) }.
 * Platform calls never run inside SQL transactions. */
'use strict';
const pg = require('../pg');
const db = require('../../db');
const catalog = require('../catalog');
const orders = require('../orders');
const { PartnerError } = catalog;
const { J, sha } = orders.internal;

const ADAPTERS = { shopify: () => require('./shopify'), woocommerce: () => require('./woocommerce') };
const adapterFor = (c) => { const a = ADAPTERS[c.platform]; if (!a) throw httpErr(400, `Unknown platform ${c.platform}`); return a(); };
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

// ---------- catalogue helpers shared by the adapters ----------
const quantityOf = (c, v) => (v.availability?.state === 'in_stock' ? Math.max(0, Math.min(v.availability.sellable_quantity ?? c.settings.default_quantity, 9999)) : 0);
/** First retail price: wholesale × (1 + markup), rounded up to .99. The merchant can change it afterwards. */
function retail(c, v) { const w = v.wholesale_unit_price_ex_tax.amount_minor; const m = Math.ceil((w * (1 + (Number(c.settings.initial_markup_pct) || 0) / 100)) / 100) * 100 - 1; return (Math.max(m, w) / 100).toFixed(2); }
const esc = (s) => String(s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

async function setCursor(c, cursor) { c.catalog_cursor = cursor; await pg.q('UPDATE partner_connection SET catalog_cursor = $2, updated_at = now() WHERE id = $1', [c.id, cursor]); }
/** Initial snapshot (when there is no cursor), then the change feed. Safe to rerun: creation is keyed by handle. */
async function syncCatalog(c, adapter, { maxPages = 20 } = {}) {
  const ctx = ctxFor(c); const s = c.settings; const out = { created: 0, updated: 0, withdrawn: 0, unchanged: 0, ignored: 0 };
  const tally = (r) => { out[r] = (out[r] || 0) + 1; };
  if (!c.catalog_cursor) {
    let cursor = ''; let page;
    do {
      page = catalog.snapshot(ctx, { market: s.market, locale: s.locale, limit: 50, cursor });
      for (const p of page.data) tally(await adapter.upsertProduct(c, p));
      cursor = page.next_cursor;
    } while (cursor);
    await setCursor(c, page.sync_cursor);
    return out;
  }
  for (let n = 0; n < maxPages; n += 1) {
    let ch;
    try { ch = catalog.changes(ctx, { market: s.market, locale: s.locale, cursor: c.catalog_cursor, limit: 100 }); } catch (e) {
      if (['CURSOR_EXPIRED', 'CURSOR_SCOPE_MISMATCH', 'INVALID_CURSOR'].includes(e.code)) { await setCursor(c, null); return syncCatalog(c, adapter); }
      throw e;
    }
    for (const ev of ch.data) tally(ev.type === 'upsert' ? await adapter.upsertProduct(c, ev.product) : await adapter.withdrawProduct(c, ev.product_id, ev.version));
    await setCursor(c, ch.next_cursor);
    if (!ch.has_more) break;
  }
  return out;
}

// ---------- platform orders → KINAN ----------
// Partner API Idempotency-Key and order reference derived from the platform order id (stable across retries and processes)
const idemKey = (c, o, op = 'order') => `${c.platform}-${op}-${o.legacy_id || o}-${short(c.id)}`;
const REF = { shopify: 'SHOPIFY', woocommerce: 'WOO' };
const orderRef = (c, o) => `${REF[c.platform]}-${o.legacy_id}`;

/** Import one paid platform order exactly once (normalised: legacy_id, name, paid, cancelled, address, lines[variant_gid, quantity]). Returns { state, partner_order_id?, reason? }. */
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
    const r = await orders.createOrder(ctx, { quote_id: q.quote_id, external_order_ref: orderRef(c, o), shipping_address: shipping }, idemKey(c, o));
    return finish('imported', { partner_order_id: r.body.order_id });
  } catch (e) {
    if (e instanceof PartnerError && ['IDEMPOTENCY_CONFLICT', 'ORDER_REFERENCE_CONFLICT'].includes(e.code)) {
      // an earlier attempt created it (crash between the Partner API commit and our bookkeeping)
      const found = (await orders.listOrders(ctx, { external_order_ref: orderRef(c, o), limit: 1 })).data[0];
      if (found) return finish('imported', { partner_order_id: found.order_id });
    }
    if (e instanceof PartnerError && e.status < 500) return finish('failed', { reason: `needs_attention: ${e.code}${e.detail ? ` — ${e.detail}` : ''}${e.extra?.errors ? ` ${JSON.stringify(e.extra.errors).slice(0, 200)}` : ''}`.slice(0, 500) });
    return finish('failed', { reason: `retry: ${errText(e)}` });
  }
}

async function handleCancelled(c, o) {
  const row = (await pg.q('SELECT * FROM partner_connection_order WHERE connection_id = $1 AND external_order_id = $2', [c.id, o.legacy_id])).rows[0];
  if (!row) { await pg.q(`INSERT INTO partner_connection_order (connection_id, external_order_id, external_name, state, reason) VALUES ($1,$2,$3,'cancelled','cancelled_in_store') ON CONFLICT DO NOTHING`, [c.id, o.legacy_id, o.name || null]); return { state: 'cancelled' }; }
  if (row.state !== 'imported' || !row.partner_order_id) { if (row.state !== 'cancelled') await pg.q(`UPDATE partner_connection_order SET state = 'cancelled', reason = 'cancelled_in_store', updated_at = now() WHERE connection_id = $1 AND external_order_id = $2`, [c.id, o.legacy_id]); return { state: 'cancelled' }; }
  if (/^cancellation_/.test(row.reason || '')) return { state: 'imported', cancellation: 'already_requested' };
  let reason;
  try {
    const r = await require('../fulfilment').requestCancellation(ctxFor(c), row.partner_order_id, { reason_code: 'customer_request', note: `Cancelled in ${c.platform === 'shopify' ? 'Shopify' : 'WooCommerce'}` }, idemKey(c, o, 'cancel'));
    reason = `cancellation_${r.body.state}`;
  } catch (e) {
    if (!(e instanceof PartnerError)) throw e;
    reason = e.code === 'CANCELLATION_PENDING' ? 'cancellation_requested' : `cancellation_refused: ${e.code}`;
  }
  await pg.q('UPDATE partner_connection_order SET reason = $3, updated_at = now() WHERE connection_id = $1 AND external_order_id = $2', [c.id, o.legacy_id, reason]);
  return { state: 'imported', cancellation: reason };
}

// ---------- worker ----------
/** One full pass for a connection: catalogue, orders (lost-webhook fallback) and tracking write-back. */
async function syncOnce(c) {
  if (typeof c === 'string') c = await get(c);
  if (c.state !== 'active') return { skipped: c.state };
  if (!adapterFor(c).enabled()) return { skipped: 'connector_off' };
  const st = db.partner_stores.get(c.store_id);
  if (!st || st.status !== 'active') return { skipped: 'store_paused' };
  const out = {};
  try {
    const adapter = adapterFor(c);
    if (adapter.beforeSync) await adapter.beforeSync(c);
    out.catalog = await syncCatalog(c, adapter);
    out.orders = await adapter.pollOrders(c);
    out.fulfilments = await adapter.writeBack(c);
    await pg.q('UPDATE partner_connection SET last_sync_at = now(), last_error = NULL WHERE id = $1', [c.id]);
  } catch (e) {
    await pg.q('UPDATE partner_connection SET last_sync_at = now(), last_error = $2 WHERE id = $1', [c.id, errText(e)]);
    out.error = errText(e); out.auth = !!e.auth;
  }
  return out;
}
async function syncAll() {
  const on = Object.keys(ADAPTERS).filter((k) => ADAPTERS[k]().enabled());
  if (!on.length) return 0;
  const list = (await pg.q(`SELECT * FROM partner_connection WHERE state = 'active' AND platform = ANY($1) ORDER BY last_sync_at NULLS FIRST LIMIT 50`, [on])).rows;
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
  const S = ADAPTERS.shopify(); const SC = require('./shopify-client');
  return {
    enabled: S.enabled(), configured: SC.configured(), api_version: SC.VERSION(), scopes: S.SCOPES,
    woocommerce: { enabled: ADAPTERS.woocommerce().enabled() },
    connections: rows.map((r) => ({ ...view(r), products: r.products, orders_imported: r.orders_imported, fulfilments_done: r.fulfilments_done })),
    order_problems: problems.map((p) => ({ ...p, updated_at: new Date(p.updated_at).getTime() })), fulfilment_problems: fulfilFails,
    privacy_requests: privacy.map((p) => ({ ...p, received_at: new Date(p.received_at).getTime() }))
  };
}
const SETTINGS = { market: (v) => /^[A-Z]{2}$/.test(v), locale: (v) => /^[a-z]{2}(-[A-Z]{2})?$/.test(v), initial_markup_pct: (v) => Number.isFinite(v) && v >= 0 && v <= 1000, update_content: (v) => typeof v === 'boolean', auto_price: (v) => typeof v === 'boolean', notify_customer: (v) => typeof v === 'boolean', import_orders: (v) => typeof v === 'boolean', include_images: (v) => typeof v === 'boolean', mark_completed: (v) => typeof v === 'boolean', default_quantity: (v) => Number.isInteger(v) && v >= 0 && v <= 999 };
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
  const cur = await get(id);
  const a = adapterFor(cur);
  if (a.onDisconnect && cur.state !== 'uninstalled') await a.onDisconnect(cur).catch(() => {}); // e.g. remove KINAN's webhooks from the shop
  const u = (await pg.q(`UPDATE partner_connection SET state = 'uninstalled', credentials = NULL, last_error = 'Disconnected by KINAN admin', updated_at = now() WHERE id = $1 RETURNING *`, [id])).rows[0];
  if (!u) throw httpErr(404, 'Connection not found');
  return { ...view(u), note: u.platform === 'shopify' ? 'Credentials deleted. Ask the merchant to remove the KINAN app in their Shopify admin as well.' : 'Credentials and KINAN webhooks deleted. Ask the shop owner to revoke the KINAN key in WooCommerce → Settings → Advanced → REST API as well.' };
}
async function adminPrivacyDone(id) { await pg.q(`UPDATE partner_connection_privacy SET state = 'done' WHERE id = $1`, [id]); return { ok: true }; }

module.exports = {
  ADAPTERS, adapterFor, short, errText, view, get, httpErr, storeFor, ctxFor, quantityOf, retail, esc, cap, setCursor, syncCatalog,
  idemKey, orderRef, importOrder, handleCancelled, syncOnce, syncAll, adminList, adminUpdate, adminRetryOrder, adminDisconnect, adminPrivacyDone
};

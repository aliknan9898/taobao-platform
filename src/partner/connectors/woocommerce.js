// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* KINAN for WooCommerce: connects a partner store's WooCommerce shop to the Partner API, run by KINAN.
 *
 *   KINAN catalogue ──► WooCommerce  draft products (simple, or variable with variations), stock managed by KINAN,
 *                                     KINAN ids and the wholesale price in meta data, SKUs prefixed "KINAN-" so they
 *                                     never collide with the merchant's own. The merchant's prices and texts are kept
 *                                     unless settings.auto_price / settings.update_content say otherwise.
 *   WooCommerce paid order ──► KINAN  (status processing/completed with a payment date) through the shared core:
 *                                     exactly once, webhook (order.created / order.updated) plus polling.
 *   WooCommerce cancellation ──► KINAN cancellation request.
 *   KINAN shipment ──► WooCommerce    order note with carrier and tracking number (emailed to the buyer when
 *                                     notify_customer is on), the Shipment Tracking extension when installed, and
 *                                     status "completed" once every line has shipped (mark_completed).
 * Connecting uses WooCommerce's own key-approval screen (/wc-auth/v1/authorize); the shop owner approves read/write
 * access and WooCommerce posts the keys to KINAN. Behind PARTNER_ORDERS_ENABLED=1 and PARTNER_WOOCOMMERCE_ENABLED=1. */
'use strict';
const crypto = require('crypto');
const pg = require('../pg');
const orders = require('../orders');
const core = require('./core');
const WC = require('./woo-client');
const { rid, J } = orders.internal;
const { view, get, httpErr, storeFor, quantityOf, retail, cap, importOrder, errText } = core;

const DEFAULTS = { market: 'DE', locale: 'de-DE', initial_markup_pct: 100, update_content: false, auto_price: false, notify_customer: true, mark_completed: true, import_orders: true, include_images: true, default_quantity: 5 };
const TOPICS = ['order.created', 'order.updated'];
const enabled = () => process.env.PARTNER_WOOCOMMERCE_ENABLED === '1';
const publicBase = () => require('../../config').config.publicBaseUrl;
const hookUrl = (c) => `${publicBase()}/api/partner/connect/woocommerce/webhooks/${c.id}`;
const kinanSku = (s) => `KINAN-${s}`.slice(0, 100);
const strip = (s) => String(s || '').replace(/<[^>]*>/g, '');

// ---------- connecting ----------
async function assertFree(storeId, key, env = 'sandbox') {
  const other = (await pg.q(`SELECT id FROM partner_connection WHERE env = $1 AND store_id = $2 AND shop_domain <> $3 AND state <> 'uninstalled'`, [env, storeId, key])).rows[0];
  if (other) throw httpErr(409, 'This partner store is already connected to another shop');
}
/** Link for the shop owner: WooCommerce shows its own approval screen and then posts the keys to KINAN. */
async function connectUrl(storeId, storeUrl) {
  const { base, key } = WC.normalizeBase(storeUrl);
  const st = storeFor(storeId); if (st.status !== 'active') throw httpErr(409, 'The partner store is paused');
  await assertFree(storeId, key);
  if (!/^https:\/\//.test(publicBase())) throw httpErr(503, 'PUBLIC_BASE_URL must be https for WooCommerce to send the keys');
  const state = crypto.randomBytes(24).toString('base64url');
  await pg.q(`DELETE FROM partner_connection_oauth WHERE created_at < now() - interval '1 hour'`);
  await pg.q('INSERT INTO partner_connection_oauth (state, store_id, shop_domain) VALUES ($1,$2,$3)', [state, storeId, `woo:${key}`]);
  const q = new URLSearchParams({ app_name: 'KINAN', scope: 'read_write', user_id: state, return_url: `${publicBase()}/api/partner/connect/woocommerce/return`, callback_url: `${publicBase()}/api/partner/connect/woocommerce/callback` });
  return { connect_url: `${base}/wc-auth/v1/authorize?${q}`, expires_in_minutes: 30 };
}
const KEY_RE = /^ck_[a-f0-9]{40}$/; const SECRET_RE = /^cs_[a-f0-9]{40}$/;
/** WooCommerce posts {key_id, user_id, consumer_key, consumer_secret, key_permissions} to the callback. */
async function onAuthCallback(body = {}) {
  const st = (await pg.q(`DELETE FROM partner_connection_oauth WHERE state = $1 AND shop_domain LIKE 'woo:%' AND created_at > now() - interval '30 minutes' RETURNING *`, [String(body.user_id || '')])).rows[0];
  if (!st) throw httpErr(403, 'Unknown or expired connection request');
  if (body.key_permissions !== 'read_write') throw httpErr(400, 'KINAN needs read/write access');
  return connectWithKeys(st.store_id, `https://${st.shop_domain.slice(4)}`, body.consumer_key, body.consumer_secret);
}
/** Connect with keys the shop owner created (WooCommerce → Settings → Advanced → REST API, read/write). */
async function connectWithKeys(storeId, storeUrl, consumerKey, consumerSecret, env = 'sandbox') {
  const { key } = WC.normalizeBase(storeUrl);
  if (!KEY_RE.test(String(consumerKey || '')) || !SECRET_RE.test(String(consumerSecret || ''))) throw httpErr(400, 'The key must look like ck_… and the secret like cs_… (40 characters after the prefix)');
  const st = storeFor(storeId); if (st.status !== 'active') throw httpErr(409, 'The partner store is paused');
  await assertFree(storeId, key, env);
  const creds = { consumer_key: consumerKey, consumer_secret: consumerSecret };
  const probe = { env, shop_domain: key };
  try { await WC.api(probe, 'GET', '/products', { query: { per_page: 1 }, creds }); } catch (e) { throw httpErr(e.auth ? 403 : 502, e.auth ? 'WooCommerce refused these keys' : `Could not reach WooCommerce: ${e.message}`); }
  const existing = (await pg.q(`SELECT * FROM partner_connection WHERE platform = 'woocommerce' AND shop_domain = $1`, [key])).rows[0];
  if (existing && existing.store_id !== storeId && existing.state !== 'uninstalled') throw httpErr(409, 'This shop is connected to another partner store');
  const prev = existing?.credentials ? orders.internal.open(existing.env, existing.credentials) : null;
  const sealed = J(orders.internal.seal(env, { ...creds, webhook_secret: prev?.webhook_secret || crypto.randomBytes(24).toString('base64url') }));
  let c;
  if (existing) {
    c = (await pg.q(`UPDATE partner_connection SET store_id = $2, env = $3, state = 'active', credentials = $4, scopes = 'read_write', last_error = NULL, updated_at = now()
                     ${existing.store_id !== storeId ? ', catalog_cursor = NULL' : ''} WHERE id = $1 RETURNING *`, [existing.id, storeId, env, sealed])).rows[0];
  } else {
    c = (await pg.q(`INSERT INTO partner_connection (id, env, store_id, platform, shop_domain, state, credentials, scopes, settings, orders_since)
                     VALUES ($1,$2,$3,'woocommerce',$4,'active',$5,'read_write',$6, now()) RETURNING *`, [rid('pcn'), env, storeId, key, sealed, J({ ...DEFAULTS, market: (st.entitlements.markets || ['DE'])[0] })])).rows[0];
  }
  await registerWebhooks(c).catch((e) => pg.q('UPDATE partner_connection SET last_error = $2 WHERE id = $1', [c.id, `Webhooks not registered yet: ${errText(e)}`]));
  return view(c);
}

const checked = new Map(); // connection id → time the webhooks were last checked (WooCommerce disables a hook after repeated failures)
async function registerWebhooks(c) {
  if (!/^https:\/\//.test(publicBase())) return { skipped: 'PUBLIC_BASE_URL is not https; relying on polling' };
  const secret = orders.internal.open(c.env, c.credentials).webhook_secret;
  const have = (await WC.api(c, 'GET', '/webhooks', { query: { per_page: 100 } })).data.filter((h) => h.delivery_url === hookUrl(c));
  for (const topic of TOPICS) {
    const h = have.find((x) => x.topic === topic);
    if (!h) await WC.api(c, 'POST', '/webhooks', { body: { name: `KINAN ${topic}`, topic, delivery_url: hookUrl(c), secret, status: 'active' } });
    else if (h.status !== 'active') await WC.api(c, 'PUT', `/webhooks/${h.id}`, { body: { status: 'active', secret } });
  }
  checked.set(c.id, Date.now());
  return { registered: TOPICS.length };
}
async function beforeSync(c) { if (Date.now() - (checked.get(c.id) || 0) > 3600e3) await registerWebhooks(c).catch(() => {}); }

/** Remove KINAN's webhooks from the shop (best effort) before the credentials are deleted. */
async function onDisconnect(c) {
  if (!c.credentials) return;
  const have = (await WC.api(c, 'GET', '/webhooks', { query: { per_page: 100 } })).data.filter((h) => h.delivery_url === hookUrl(c));
  for (const h of have) await WC.api(c, 'DELETE', `/webhooks/${h.id}`, { query: { force: true } }).catch(() => {});
}

// ---------- catalogue → WooCommerce ----------
const media = (c, p) => (c.settings.include_images ? (p.media || []).filter((m) => /^https:\/\//.test(m.url) && !/\.example\.(com|org|net)\//.test(m.url)).slice(0, 10).map((m) => ({ src: m.url, alt: m.alt || p.title })) : []);
const optionKeys = (p) => [...new Set(p.variants.flatMap((v) => Object.keys(v.options || {})))].slice(0, 3);
const isSimple = (p) => p.variants.length === 1 && !optionKeys(p).length;
const wholesale = (v) => (v.wholesale_unit_price_ex_tax.amount_minor / 100).toFixed(2);

async function saveVariant(c, p, v, extId) {
  await pg.q(`INSERT INTO partner_connection_variant (connection_id, variant_id, product_id, external_variant_id, inventory_item_id, last_quantity) VALUES ($1,$2,$3,$4,$4,$5)
              ON CONFLICT (connection_id, variant_id) DO UPDATE SET external_variant_id = EXCLUDED.external_variant_id, inventory_item_id = EXCLUDED.inventory_item_id, last_quantity = EXCLUDED.last_quantity`,
  [c.id, v.variant_id, p.product_id, extId, quantityOf(c, v)]);
}

async function upsertProduct(c, p) {
  const row = (await pg.q('SELECT * FROM partner_connection_product WHERE connection_id = $1 AND product_id = $2', [c.id, p.product_id])).rows[0];
  if (!row) {
    // look the product up by its KINAN SKU first, so a create retried after a crash does not duplicate it
    const sku = kinanSku(p.product_id); const simple = isSimple(p);
    let prod = (await WC.api(c, 'GET', '/products', { query: { sku, status: 'any' } })).data[0];
    if (!prod) {
      const keys = optionKeys(p); const v0 = p.variants[0];
      prod = (await WC.api(c, 'POST', '/products', { body: {
        name: p.title, type: simple ? 'simple' : 'variable', status: 'draft', description: `<p>${core.esc(p.description)}</p>`,
        sku: simple ? kinanSku(v0.sku) : sku, images: media(c, p),
        meta_data: [{ key: 'kinan_product_id', value: p.product_id }, ...(simple ? [{ key: 'kinan_variant_id', value: v0.variant_id }, { key: 'kinan_wholesale_price', value: wholesale(v0) }] : [])],
        ...(simple ? { regular_price: retail(c, v0), manage_stock: true, stock_quantity: quantityOf(c, v0), backorders: 'no' }
          : { attributes: keys.map((k, i) => ({ name: cap(k), position: i, visible: true, variation: true, options: [...new Set(p.variants.map((v) => String(v.options?.[k] ?? '—')))] })) })
      } })).data;
    }
    if (simple) await saveVariant(c, p, p.variants[0], String(prod.id));
    else {
      const keys = optionKeys(p);
      const existing = (await WC.api(c, 'GET', `/products/${prod.id}/variations`, { query: { per_page: 100 } })).data;
      const missing = p.variants.filter((v) => !existing.some((e) => e.sku === kinanSku(v.sku)));
      let created = [];
      if (missing.length) {
        const r = (await WC.api(c, 'POST', `/products/${prod.id}/variations/batch`, { body: { create: missing.map((v) => ({
          sku: kinanSku(v.sku), regular_price: retail(c, v), manage_stock: true, stock_quantity: quantityOf(c, v), backorders: 'no',
          attributes: keys.map((k) => ({ name: cap(k), option: String(v.options?.[k] ?? '—') })),
          meta_data: [{ key: 'kinan_variant_id', value: v.variant_id }, { key: 'kinan_wholesale_price', value: wholesale(v) }]
        })) } })).data;
        const bad = (r.create || []).filter((x) => x.error);
        if (bad.length) throw new WC.WooError(`Variation not created: ${bad[0].error.message || bad[0].error.code}`);
        created = r.create || [];
      }
      for (const v of p.variants) {
        const ext = [...existing, ...created].find((e) => e.sku === kinanSku(v.sku));
        if (ext) await saveVariant(c, p, v, `${prod.id}/${ext.id}`);
      }
    }
    await pg.q(`INSERT INTO partner_connection_product (connection_id, product_id, external_product_id, version, status) VALUES ($1,$2,$3,$4,'active')
                ON CONFLICT (connection_id, product_id) DO UPDATE SET external_product_id = EXCLUDED.external_product_id, version = EXCLUDED.version, status = 'active', updated_at = now()`, [c.id, p.product_id, String(prod.id), p.version]);
    return 'created';
  }
  if (p.version <= row.version && row.status === 'active') return 'unchanged';
  const pid = row.external_product_id;
  const productPatch = {};
  if (row.status === 'withdrawn') productPatch.meta_data = [{ key: 'kinan_withdrawn', value: '0' }];
  if (c.settings.update_content) Object.assign(productPatch, { name: p.title, description: `<p>${core.esc(p.description)}</p>` });
  if (Object.keys(productPatch).length) await WC.api(c, 'PUT', `/products/${pid}`, { body: productPatch });
  const maps = (await pg.q('SELECT * FROM partner_connection_variant WHERE connection_id = $1 AND product_id = $2', [c.id, p.product_id])).rows;
  const changes = p.variants.map((v) => ({ v, m: maps.find((x) => x.variant_id === v.variant_id) })).filter((x) => x.m)
    .map(({ v, m }) => ({ m, quantity: quantityOf(c, v), ...(c.settings.auto_price ? { price: retail(c, v) } : {}) }))
    .filter((x) => x.price !== undefined || x.m.last_quantity !== x.quantity);
  await setStock(c, changes);
  await pg.q(`UPDATE partner_connection_product SET version = $3, status = 'active', updated_at = now() WHERE connection_id = $1 AND product_id = $2`, [c.id, p.product_id, p.version]);
  return 'updated';
}

/** Absolute stock (and price when auto_price) per item; variations in one batch per product. */
async function setStock(c, changes) {
  const byProduct = new Map();
  for (const ch of changes) { const [pid, vid] = ch.m.external_variant_id.split('/'); (byProduct.get(pid) || byProduct.set(pid, []).get(pid)).push({ ...ch, vid }); }
  for (const [pid, list] of byProduct) {
    const patch = (x) => ({ stock_quantity: x.quantity, ...(x.price !== undefined ? { regular_price: x.price } : {}) });
    if (list[0].vid) {
      const r = (await WC.api(c, 'POST', `/products/${pid}/variations/batch`, { body: { update: list.map((x) => ({ id: Number(x.vid), ...patch(x) })) } })).data;
      const bad = (r.update || []).filter((x) => x.error); if (bad.length) throw new WC.WooError(`Stock not updated: ${bad[0].error.message || bad[0].error.code}`);
    } else await WC.api(c, 'PUT', `/products/${pid}`, { body: patch(list[0]) });
    for (const x of list) await pg.q('UPDATE partner_connection_variant SET last_quantity = $3 WHERE connection_id = $1 AND variant_id = $2', [c.id, x.m.variant_id, x.quantity]);
  }
}

async function withdrawProduct(c, productId, version) {
  const row = (await pg.q('SELECT * FROM partner_connection_product WHERE connection_id = $1 AND product_id = $2', [c.id, productId])).rows[0];
  if (!row || row.status === 'withdrawn') return 'ignored';
  const maps = (await pg.q('SELECT * FROM partner_connection_variant WHERE connection_id = $1 AND product_id = $2', [c.id, productId])).rows;
  await setStock(c, maps.filter((m) => m.last_quantity !== 0).map((m) => ({ m, quantity: 0 })));
  await WC.api(c, 'PUT', `/products/${row.external_product_id}`, { body: { meta_data: [{ key: 'kinan_withdrawn', value: '1' }] } });
  await pg.q(`UPDATE partner_connection_product SET status = 'withdrawn', version = GREATEST(version, $3), updated_at = now() WHERE connection_id = $1 AND product_id = $2`, [c.id, productId, Number(version) || row.version]);
  return 'withdrawn';
}

// ---------- WooCommerce orders → KINAN ----------
function fromWoo(o) {
  const s = o.shipping?.address_1 ? o.shipping : (o.billing || {});
  return {
    legacy_id: String(o.id), name: `#${o.number || o.id}`,
    paid: ['processing', 'completed'].includes(o.status) && !!(o.date_paid || o.date_paid_gmt),
    cancelled: ['cancelled', 'refunded'].includes(o.status),
    address: { name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || s.company, address1: s.address_1, address2: s.address_2, city: s.city, zip: s.postcode, country: s.country, phone: s.phone || o.billing?.phone },
    lines: (o.line_items || []).map((l) => ({ variant_gid: l.variation_id ? `${l.product_id}/${l.variation_id}` : `${l.product_id}`, quantity: Number(l.quantity) || 0 }))
  };
}
async function pollOrders(c, { maxPages = 10 } = {}) {
  const since = new Date((c.orders_since ? new Date(c.orders_since).getTime() : Date.now() - 864e5) - 10 * 60e3).toISOString();
  const started = new Date(); const out = { seen: 0, imported: 0 };
  for (let page = 1; page <= maxPages; page += 1) {
    const r = await WC.api(c, 'GET', '/orders', { query: { modified_after: since, dates_are_gmt: 'true', orderby: 'modified', order: 'asc', per_page: 50, page } });
    for (const o of r.data) { out.seen += 1; const x = await importOrder(c, fromWoo(o)); if (x.state === 'imported' && !x.duplicate) out.imported += 1; }
    const pages = Number(r.headers['x-wp-totalpages'] || 1);
    if (page >= pages || !r.data.length) { await pg.q('UPDATE partner_connection SET orders_since = $2 WHERE id = $1', [c.id, started]); c.orders_since = started; break; }
  }
  return out;
}

// ---------- KINAN shipments → WooCommerce ----------
async function writeBack(c, { limit = 20 } = {}) {
  const due = (await pg.q(`SELECT s.id, s.items, s.carrier, s.tracking_number, s.tracking_url, s.order_id, co.external_order_id
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
    const done = async (state, extra = {}) => { await pg.q('UPDATE partner_connection_fulfillment SET state = $3, external_fulfillment_id = COALESCE($4, external_fulfillment_id), last_error = $5, updated_at = now() WHERE connection_id = $1 AND shipment_id = $2', [c.id, s.id, state, extra.id ? String(extra.id) : null, extra.error || null]); out[state === 'done' ? 'done' : 'failed'] += 1; };
    try {
      const oid = s.external_order_id;
      const notes = (await WC.api(c, 'GET', `/orders/${oid}/notes`, { query: { type: 'any' } })).data;
      let note = notes.find((n) => strip(n.note).includes(s.tracking_number)); // added before a crash: do not add twice
      if (!note) {
        const text = `Your order has shipped with ${s.carrier}. Tracking number: ${s.tracking_number}${s.tracking_url ? ` (${s.tracking_url})` : ''}`;
        note = (await WC.api(c, 'POST', `/orders/${oid}/notes`, { body: { note: text, customer_note: !!c.settings.notify_customer } })).data;
        if (c.settings.tracking_extension !== false) {
          try { await WC.api(c, 'POST', `/orders/${oid}/shipment-trackings`, { namespace: 'wc-shipment-tracking/v3', body: { custom_tracking_provider: s.carrier, tracking_number: s.tracking_number, ...(s.tracking_url ? { custom_tracking_link: s.tracking_url } : {}) } }); } catch (e) {
            if (e.status === 404) { c.settings = { ...c.settings, tracking_extension: false }; await pg.q('UPDATE partner_connection SET settings = $2 WHERE id = $1', [c.id, J(c.settings)]); } else if (e.auth) throw e;
          }
        }
      }
      if (c.settings.mark_completed) await maybeComplete(c, s.order_id, oid);
      await done('done', { id: note.id });
    } catch (e) { await done('failed', { error: errText(e) }); if (e.auth) throw e; }
  }
  return out;
}
/** Mark the WooCommerce order completed once KINAN shipped everything and the order holds only KINAN lines. */
async function maybeComplete(c, partnerOrderId, oid) {
  const po = (await pg.q('SELECT fulfillment_state FROM partner_order WHERE id = $1', [partnerOrderId])).rows[0];
  if (!po || !['shipped', 'delivered'].includes(po.fulfillment_state)) return;
  const o = (await WC.api(c, 'GET', `/orders/${oid}`)).data;
  if (o.status !== 'processing') return;
  const keys = o.line_items.map((l) => (l.variation_id ? `${l.product_id}/${l.variation_id}` : `${l.product_id}`));
  const mapped = (await pg.q('SELECT count(*)::int AS n FROM partner_connection_variant WHERE connection_id = $1 AND external_variant_id = ANY($2)', [c.id, keys])).rows[0].n;
  if (mapped < new Set(keys).size) return; // the merchant ships their own products themselves
  await WC.api(c, 'PUT', `/orders/${oid}`, { body: { status: 'completed' } });
}

// ---------- webhooks from WooCommerce ----------
/** Verify and handle one delivery. Returns a short status; throws {status} for refusals. */
async function onWebhook(connectionId, headers, raw) {
  const text = raw.toString('utf8');
  const sig = headers['x-wc-webhook-signature'];
  if (!sig && /^webhook_id=\d+$/.test(text.trim())) return 'ping'; // WooCommerce pings a new webhook without a signature
  const c = (await pg.q(`SELECT * FROM partner_connection WHERE id = $1 AND platform = 'woocommerce'`, [String(connectionId)])).rows[0];
  if (!c || !c.credentials) throw httpErr(401, 'invalid signature');
  const secret = orders.internal.open(c.env, c.credentials).webhook_secret;
  const want = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  if (!sig || String(sig).length !== want.length || !crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(want))) throw httpErr(401, 'invalid signature');
  const delivery = headers['x-wc-webhook-delivery-id'];
  if (delivery) {
    const fresh = (await pg.q('INSERT INTO partner_connection_webhook (webhook_id, shop_domain, topic) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING webhook_id', [`woo:${c.id}:${String(delivery).slice(0, 60)}:${String(headers['x-wc-webhook-topic'] || '')}`, c.shop_domain, String(headers['x-wc-webhook-topic'] || '')])).rowCount;
    if (!fresh) return 'duplicate';
  }
  if (c.state !== 'active') return `ignored_${c.state}`;
  if (!/^order\.(created|updated)$/.test(String(headers['x-wc-webhook-topic'] || ''))) return 'ignored_topic';
  let body; try { body = JSON.parse(text); } catch { throw httpErr(400, 'invalid json'); }
  return (await importOrder(c, fromWoo(body))).state;
}

module.exports = {
  DEFAULTS, TOPICS, enabled, connectUrl, onAuthCallback, connectWithKeys, registerWebhooks, beforeSync, onDisconnect,
  upsertProduct, withdrawProduct, pollOrders, writeBack, onWebhook, fromWoo, kinanSku,
  syncCatalog: (c, o) => core.syncCatalog(c, module.exports, o), syncOnce: core.syncOnce, get
};

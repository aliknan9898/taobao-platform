'use strict';
/* In-memory fake of the parts of Shopify the KINAN connector uses (Admin GraphQL 2026-10 + OAuth token endpoint).
   It enforces what the real API enforces for these calls: access token on every request, expiring tokens with
   rotating refresh tokens, @idempotent key and changeFromQuantity on inventorySetQuantities, productSet upsert by
   handle, fulfillment only up to the remaining quantity. Merchant actions (publish, edit price, place/cancel orders,
   revoke access) are helpers. Use fake.fetch as the connector transport. */
const crypto = require('crypto');

function createFakeShopify({ shop = 'kinan-demo.myshopify.com', clientId = 'test-key', clientSecret = 'test-secret', version = '2026-10', scopes } = {}) {
  let n = 1000; const id = (type) => `gid://shopify/${type}/${++n}`;
  const st = {
    shop, tokens: new Map(), refresh: new Map(), products: new Map(), variants: new Map(), levels: new Map(), orders: new Map(),
    webhooks: [], idem: new Map(), calls: [], location: 'gid://shopify/Location/1', expiresIn: 3600
  };
  const SC = scopes || 'read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders';
  const issue = (withRefresh) => {
    const t = { access_token: `shpat_${crypto.randomBytes(12).toString('hex')}`, scope: SC, expires_in: withRefresh ? st.expiresIn : 86399 };
    st.tokens.set(t.access_token, Date.now() + t.expires_in * 1000);
    if (withRefresh) { t.refresh_token = `shprt_${crypto.randomBytes(12).toString('hex')}`; t.refresh_token_expires_in = 7776000; st.refresh.set(t.refresh_token, true); }
    return t;
  };
  const resp = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function token(url, init) {
    const f = Object.fromEntries(new URLSearchParams(init.body));
    if (f.client_id !== clientId || f.client_secret !== clientSecret) return resp(401, { error: 'invalid_client' });
    if (f.code) return f.code === 'good-code' ? resp(200, issue(f.expiring === '1')) : resp(400, { error: 'invalid_grant' });
    if (f.grant_type === 'client_credentials') return resp(200, issue(false));
    if (f.grant_type === 'refresh_token') { if (!st.refresh.get(f.refresh_token)) return resp(401, { error: 'invalid_grant' }); st.refresh.delete(f.refresh_token); return resp(200, issue(true)); }
    return resp(400, { error: 'unsupported' });
  }

  const ue = (message, field = []) => ({ userErrors: [{ field, message }] });
  const variantView = (v) => ({ id: v.id, sku: v.sku, inventoryItem: { id: v.inventory_item_id } });
  const ops = {
    KinanWebhooks: () => ({ webhookSubscriptions: { nodes: st.webhooks } }),
    KinanWebhookCreate: (vars) => { const w = { id: id('WebhookSubscription'), topic: vars.topic, uri: vars.sub.uri }; st.webhooks.push(w); return { webhookSubscriptionCreate: { webhookSubscription: { id: w.id }, userErrors: [] } }; },
    KinanLocations: () => ({ locations: { nodes: [{ id: st.location, name: 'Shop location', isActive: true }] } }),
    KinanProductSet: (vars) => {
      const inp = vars.input; const handle = vars.identifier?.handle || inp.handle;
      if (!inp.productOptions?.length) return { productSet: ue('productOptions required') };
      let p = [...st.products.values()].find((x) => x.handle === handle);
      if (!p) { p = { id: id('Product'), handle, variants: [], tags: [] }; st.products.set(p.id, p); }
      Object.assign(p, { title: inp.title, descriptionHtml: inp.descriptionHtml, status: inp.status, vendor: inp.vendor, tags: inp.tags || [], metafields: inp.metafields, files: inp.files || [] });
      const old = p.variants; p.variants = [];
      for (const vi of inp.variants) {
        if (!vi.inventoryQuantities?.every((q) => q.locationId === st.location)) return { productSet: ue('unknown location') };
        const prev = old.find((x) => x.sku === vi.sku);
        const v = prev || { id: id('ProductVariant'), inventory_item_id: id('InventoryItem') };
        Object.assign(v, { sku: vi.sku, price: String(vi.price), product_id: p.id, options: vi.optionValues, metafields: vi.metafields, policy: vi.inventoryPolicy });
        st.variants.set(v.id, v); p.variants.push(v);
        st.levels.set(v.inventory_item_id, vi.inventoryQuantities[0].quantity);
      }
      for (const o of old) if (!p.variants.includes(o)) st.variants.delete(o.id);
      return { productSet: { product: { id: p.id, variants: { nodes: p.variants.map(variantView) } }, userErrors: [] } };
    },
    KinanInventory: (vars, query) => {
      const m = query.match(/@idempotent\(key:\s*"([^"]+)"\)/);
      if (!m) return { inventorySetQuantities: ue('An idempotency key is required (@idempotent directive)') };
      const inp = vars.input;
      if (inp.quantities.some((q) => !('changeFromQuantity' in q))) return { inventorySetQuantities: ue('changeFromQuantity is required (null to skip the check)') };
      const sig = JSON.stringify(inp);
      if (st.idem.has(m[1])) { if (st.idem.get(m[1]) !== sig) return { inventorySetQuantities: { ...ue('IDEMPOTENCY_KEY_PARAMETER_MISMATCH'), inventoryAdjustmentGroup: null } }; return { inventorySetQuantities: { inventoryAdjustmentGroup: { id: 'gid://shopify/InventoryAdjustmentGroup/replayed' }, userErrors: [] } }; }
      st.idem.set(m[1], sig);
      for (const q of inp.quantities) {
        if (q.locationId !== st.location) return { inventorySetQuantities: ue('unknown location') };
        if (q.changeFromQuantity !== null && st.levels.get(q.inventoryItemId) !== q.changeFromQuantity) return { inventorySetQuantities: ue('CHANGE_FROM_QUANTITY_STALE') };
        st.levels.set(q.inventoryItemId, q.quantity);
      }
      return { inventorySetQuantities: { inventoryAdjustmentGroup: { id: id('InventoryAdjustmentGroup') }, userErrors: [] } };
    },
    KinanTagsAdd: (vars) => { const p = st.products.get(vars.id); p.tags = [...new Set([...p.tags, ...vars.tags])]; return { tagsAdd: { userErrors: [] } }; },
    KinanTagsRemove: (vars) => { const p = st.products.get(vars.id); p.tags = p.tags.filter((t) => !vars.tags.includes(t)); return { tagsRemove: { userErrors: [] } }; },
    KinanProductUpdate: (vars) => { const p = st.products.get(vars.product.id); Object.assign(p, { title: vars.product.title, descriptionHtml: vars.product.descriptionHtml }); return { productUpdate: { product: { id: p.id }, userErrors: [] } }; },
    KinanPrices: (vars) => { for (const v of vars.variants) st.variants.get(v.id).price = String(v.price); return { productVariantsBulkUpdate: { userErrors: [] } }; },
    KinanOrders: (vars) => {
      const since = vars.q.match(/updated_at:>='([^']+)'/)[1];
      const list = [...st.orders.values()].filter((o) => o.updatedAt >= since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const start = vars.after ? Number(vars.after) : 0; const page = list.slice(start, start + 25);
      return { orders: { nodes: page.map(gqlOrder), pageInfo: { hasNextPage: start + 25 < list.length, endCursor: String(start + 25) } } };
    },
    KinanOrderFulfil: (vars) => {
      const o = st.orders.get(vars.id); if (!o) return { order: null };
      return { order: { fulfillments: o.fulfillments.map((f) => ({ id: f.id, trackingInfo: [{ number: f.tracking.number }] })), fulfillmentOrders: { nodes: [{ id: o.fo, status: o.lines.some((l) => l.remaining > 0) ? 'OPEN' : 'CLOSED', lineItems: { nodes: o.lines.map((l) => ({ id: l.fo_line, remainingQuantity: l.remaining, lineItem: { variant: l.variant_id ? { id: l.variant_id } : null } })) } }] } } };
    },
    KinanFulfil: (vars) => {
      const f = vars.fulfillment; const g = f.lineItemsByFulfillmentOrder[0];
      const o = [...st.orders.values()].find((x) => x.fo === g.fulfillmentOrderId);
      for (const li of g.fulfillmentOrderLineItems) { const l = o.lines.find((x) => x.fo_line === li.id); if (!l || li.quantity > l.remaining) return { fulfillmentCreate: ue('Invalid fulfillment order line item quantity requested') }; }
      for (const li of g.fulfillmentOrderLineItems) o.lines.find((x) => x.fo_line === li.id).remaining -= li.quantity;
      const ful = { id: id('Fulfillment'), tracking: f.trackingInfo, notify: f.notifyCustomer, lines: g.fulfillmentOrderLineItems };
      o.fulfillments.push(ful); o.updatedAt = new Date().toISOString();
      return { fulfillmentCreate: { fulfillment: { id: ful.id, status: 'SUCCESS' }, userErrors: [] } };
    }
  };
  function gqlOrder(o) {
    return { id: o.id, legacyResourceId: o.legacy, name: o.name, updatedAt: o.updatedAt, cancelledAt: o.cancelledAt, displayFinancialStatus: o.paid ? 'PAID' : 'PENDING',
      shippingAddress: { name: o.address.name, address1: o.address.address1, address2: o.address.address2 || null, city: o.address.city, zip: o.address.zip, countryCodeV2: o.address.country_code, phone: o.address.phone || null },
      lineItems: { nodes: o.lines.map((l) => ({ id: l.id, quantity: l.quantity, variant: l.variant_id ? { id: l.variant_id } : null })) } };
  }

  async function fetchLike(url, init = {}) {
    const u = new URL(url);
    let q = ''; try { q = String(JSON.parse(init.body || '{}').query || ''); } catch { /* form body */ }
    st.calls.push({ path: u.pathname, op: (q.match(/(?:query|mutation)\s+(\w+)/) || [])[1] });
    if (u.hostname !== shop) throw new Error(`fake shopify: unexpected host ${u.hostname}`);
    if (init.redirect !== 'error') throw new Error('fake shopify: redirects must be refused');
    if (u.pathname === '/admin/oauth/access_token' && init.method === 'POST') return token(url, init);
    if (u.pathname !== `/admin/api/${version}/graphql.json`) return resp(404, { errors: 'Not Found' });
    const tk = init.headers['X-Shopify-Access-Token']; const exp = st.tokens.get(tk);
    if (!exp || exp < Date.now()) return resp(401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' });
    const { query, variables } = JSON.parse(init.body);
    const op = (query.match(/(?:query|mutation)\s+(\w+)/) || [])[1];
    if (!ops[op]) return resp(200, { errors: [{ message: `fake: unknown operation ${op}` }] });
    return resp(200, { data: ops[op](variables || {}, query) });
  }

  // ---- merchant actions ----
  const productByKinan = (kp) => [...st.products.values()].find((p) => p.metafields?.some((m) => m.key === 'product_id' && m.value === kp));
  const variantByKinan = (kv) => [...st.variants.values()].find((v) => v.metafields?.some((m) => m.key === 'variant_id' && m.value === kv));
  function placeOrder({ lines, address, paid = true }) {
    const legacy = String(++n); const o = { id: `gid://shopify/Order/${legacy}`, legacy, name: `#${legacy}`, paid, cancelledAt: null, updatedAt: new Date().toISOString(), address, fulfillments: [], fo: id('FulfillmentOrder'),
      lines: lines.map((l) => ({ id: id('LineItem'), fo_line: id('FulfillmentOrderLineItem'), variant_id: l.kinan ? variantByKinan(l.kinan).id : (l.variant_id || null), quantity: l.quantity, remaining: l.quantity, title: l.title || '' })) };
    st.orders.set(o.id, o); return o;
  }
  function restPayload(o) {
    return { id: Number(o.legacy), admin_graphql_api_id: o.id, name: o.name, financial_status: o.paid ? 'paid' : 'pending', cancelled_at: o.cancelledAt,
      email: 'buyer@example.test', shipping_address: o.address, line_items: o.lines.map((l) => ({ id: Number(l.id.split('/').pop()), variant_id: l.variant_id ? Number(l.variant_id.split('/').pop()) : null, quantity: l.quantity, title: l.title })) };
  }
  function cancel(o) { o.cancelledAt = new Date().toISOString(); o.updatedAt = o.cancelledAt; }
  function revoke() { st.tokens.clear(); st.refresh.clear(); }
  const sign = (raw) => crypto.createHmac('sha256', clientSecret).update(raw).digest('base64');
  const callbackQuery = (params) => { const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&'); return { ...params, hmac: crypto.createHmac('sha256', clientSecret).update(msg).digest('hex') }; };
  return { st, fetch: fetchLike, productByKinan, variantByKinan, placeOrder, restPayload, cancel, revoke, sign, callbackQuery, level: (v) => st.levels.get(v.inventory_item_id) };
}

module.exports = { createFakeShopify };

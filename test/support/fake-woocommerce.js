'use strict';
/* In-memory fake of the WooCommerce REST API (wc/v3) parts the KINAN connector uses. It enforces Basic auth with the
   issued key, unique SKUs, absolute stock, paging headers and webhook secrets; merchant actions are helpers.
   Use fake.transport as the connector transport ({status, headers, text} like the pinned HTTPS client). */
const crypto = require('crypto');

function createFakeWoo({ base = 'https://woo-demo.example.org/shop', trackingExtension = false } = {}) {
  const u0 = new URL(base); const prefix = u0.pathname.replace(/\/+$/, '');
  let n = 100; const next = () => ++n;
  const st = { keys: new Map(), products: new Map(), webhooks: [], orders: new Map(), calls: [], trackings: [], trackingExtension };
  const hex = (k) => crypto.randomBytes(k).toString('hex');
  const issueKeys = () => { const k = { consumer_key: `ck_${hex(20)}`, consumer_secret: `cs_${hex(20)}` }; st.keys.set(k.consumer_key, k.consumer_secret); return k; };
  const out = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, text: JSON.stringify(body) });
  const err = (status, code, message) => out(status, { code, message, data: { status } });
  const allSkus = () => [...st.products.values()].flatMap((p) => [p.sku, ...(p.variations || []).map((v) => v.sku)]).filter(Boolean);
  const meta = (o, k) => (o.meta_data || []).find((m) => m.key === k)?.value;

  function route(method, path, q, body) {
    let m;
    if (path === '/products' && method === 'GET') return out(200, [...st.products.values()].filter((p) => !q.get('sku') || p.sku === q.get('sku')));
    if (path === '/products' && method === 'POST') {
      if (body.sku && allSkus().includes(body.sku)) return err(400, 'product_invalid_sku', 'Invalid or duplicated SKU.');
      const p = { id: next(), ...body, variations: [], meta_data: body.meta_data || [] }; st.products.set(p.id, p); return out(201, p);
    }
    if ((m = path.match(/^\/products\/(\d+)$/)) && method === 'PUT') {
      const p = st.products.get(Number(m[1])); if (!p) return err(404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.');
      const { meta_data: md, ...rest } = body; Object.assign(p, rest);
      for (const x of md || []) { const e = p.meta_data.find((y) => y.key === x.key); if (e) e.value = x.value; else p.meta_data.push(x); }
      return out(200, p);
    }
    if ((m = path.match(/^\/products\/(\d+)\/variations$/)) && method === 'GET') return out(200, st.products.get(Number(m[1])).variations);
    if ((m = path.match(/^\/products\/(\d+)\/variations\/batch$/)) && method === 'POST') {
      const p = st.products.get(Number(m[1])); const res = {};
      if (body.create) res.create = body.create.map((v) => { if (allSkus().includes(v.sku)) return { id: 0, error: { code: 'product_invalid_sku', message: 'Invalid or duplicated SKU.' } }; const x = { id: next(), ...v }; p.variations.push(x); return x; });
      if (body.update) res.update = body.update.map((v) => { const x = p.variations.find((y) => y.id === v.id); if (!x) return { id: v.id, error: { code: 'invalid', message: 'Invalid ID' } }; Object.assign(x, v); return x; });
      return out(200, res);
    }
    if (path === '/webhooks' && method === 'GET') return out(200, st.webhooks);
    if (path === '/webhooks' && method === 'POST') { const h = { id: next(), ...body }; st.webhooks.push(h); return out(201, h); }
    if ((m = path.match(/^\/webhooks\/(\d+)$/))) {
      const i = st.webhooks.findIndex((h) => h.id === Number(m[1])); if (i < 0) return err(404, 'woocommerce_rest_webhook_invalid_id', 'Invalid ID.');
      if (method === 'PUT') { Object.assign(st.webhooks[i], body); return out(200, st.webhooks[i]); }
      if (method === 'DELETE') { const [h] = st.webhooks.splice(i, 1); return out(200, h); }
    }
    if (path === '/orders' && method === 'GET') {
      const since = q.get('modified_after');
      const list = [...st.orders.values()].filter((o) => !since || o.date_modified_gmt >= since.replace(/Z$/, '').slice(0, 19)).sort((a, b) => a.date_modified_gmt.localeCompare(b.date_modified_gmt));
      const per = Number(q.get('per_page') || 10); const page = Number(q.get('page') || 1);
      return out(200, list.slice((page - 1) * per, page * per), { 'x-wp-total': String(list.length), 'x-wp-totalpages': String(Math.max(1, Math.ceil(list.length / per))) });
    }
    if ((m = path.match(/^\/orders\/(\d+)$/))) {
      const o = st.orders.get(Number(m[1])); if (!o) return err(404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.');
      if (method === 'PUT') { Object.assign(o, body); touch(o); }
      return out(200, o);
    }
    if ((m = path.match(/^\/orders\/(\d+)\/notes$/))) {
      const o = st.orders.get(Number(m[1]));
      if (method === 'GET') return out(200, o.notes);
      const note = { id: next(), note: body.note, customer_note: !!body.customer_note, date_created: new Date().toISOString() }; o.notes.push(note); return out(201, note);
    }
    return err(404, 'rest_no_route', 'No route was found matching the URL and request method.');
  }
  function touch(o) { o.date_modified_gmt = new Date().toISOString().slice(0, 19); }

  async function transport(url, init = {}) {
    const u = new URL(url);
    st.calls.push(`${init.method || 'GET'} ${u.pathname}`);
    if (u.host !== u0.host || !u.pathname.startsWith(`${prefix}/wp-json/`)) return { status: 404, headers: {}, text: '<html>not found</html>' };
    const auth = String(init.headers?.Authorization || '');
    const [ck, cs] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
    if (!st.keys.has(ck) || st.keys.get(ck) !== cs) return err(401, 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.');
    const rest = u.pathname.slice(`${prefix}/wp-json/`.length);
    const body = init.body ? JSON.parse(init.body) : {};
    if (rest.startsWith('wc-shipment-tracking/v3/')) {
      if (!st.trackingExtension) return err(404, 'rest_no_route', 'No route was found matching the URL and request method.');
      const m = rest.match(/orders\/(\d+)\/shipment-trackings$/); st.trackings.push({ order: Number(m[1]), ...body }); return out(201, { tracking_id: hex(4), ...body });
    }
    if (!rest.startsWith('wc/v3/')) return err(404, 'rest_no_route', 'No route');
    return route(init.method || 'GET', rest.slice('wc/v3'.length), u.searchParams, body);
  }

  // ---- merchant actions ----
  const variationByKinan = (kv) => { for (const p of st.products.values()) { if (meta(p, 'kinan_variant_id') === kv) return { p, v: null }; const v = p.variations.find((x) => meta(x, 'kinan_variant_id') === kv); if (v) return { p, v }; } return null; };
  const productByKinan = (kp) => [...st.products.values()].find((p) => meta(p, 'kinan_product_id') === kp);
  function placeOrder({ lines, status = 'processing', address, paid = true }) {
    const id = next();
    const o = {
      id, number: String(id), status, date_paid: paid ? new Date().toISOString() : null, date_paid_gmt: paid ? new Date().toISOString() : null, notes: [],
      shipping: { first_name: 'Sandbox', last_name: 'Buyer', company: '', address_1: 'Example Street 1', address_2: '', city: 'Berlin', postcode: '10115', country: 'DE', phone: '+49 30 1234567', ...address },
      billing: { email: 'buyer@example.test', phone: '+49 30 1234567' },
      line_items: lines.map((l) => { if (l.kinan) { const f = variationByKinan(l.kinan); return { id: next(), product_id: f.p.id, variation_id: f.v ? f.v.id : 0, quantity: l.quantity, sku: (f.v || f.p).sku }; } return { id: next(), product_id: l.product_id || 9999, variation_id: 0, quantity: l.quantity, sku: 'OWN-1' }; })
    };
    touch(o); st.orders.set(id, o); return o;
  }
  const secretFor = (topic) => st.webhooks.find((h) => h.topic === topic)?.secret;
  const sign = (raw, secret) => crypto.createHmac('sha256', secret).update(raw).digest('base64');
  return { st, base, transport, issueKeys, placeOrder, productByKinan, variationByKinan, meta, secretFor, sign, revoke: () => st.keys.clear(), touch };
}

module.exports = { createFakeWoo };

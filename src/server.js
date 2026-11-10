'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { config, configProblems } = require('./config');
const db = require('./db');
const auth = require('./auth');
const sellerAuth = require('./taobao/sellerAuth');
const catalog = require('./services/catalog');
const orders = require('./services/orders');
const warehouse = require('./services/warehouse');
const admin = require('./services/admin');
const stripe = require('./payments/stripe');
const webhooks = require('./webhooks');

const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024;
const { httpError } = auth;

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const c = [];
    req.on('data', (d) => { n += d.length; if (n > MAX_BODY) { reject(httpError(413, 'Body too large')); req.destroy(); } else c.push(d); });
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw httpError(400, 'Invalid JSON'); }
}
function page(res, file) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"
  });
  fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
}

// Simple login throttling (per IP)
const attempts = new Map();
function throttle(ip) {
  const now = Date.now(); const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60e3) { a.n = 0; a.t = now; }
  a.n += 1; attempts.set(ip, a);
  if (a.n > 20) throw httpError(429, 'Too many attempts, try again later');
}

// ---------- routes ----------
// [method, pattern, roles (null = public), handler({req,res,params,url,user,seller,body})]
const routes = [];
const r = (method, pattern, roles, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]{1,80})')}$`), roles, handler });
const ADMIN = ['admin']; const SELLER = ['seller']; const BUYER = ['buyer']; const WH = ['warehouse', 'admin'];

// Auth
r('POST', '/api/auth/register', null, async ({ req }) => auth.register(await readJson(req)));
r('POST', '/api/auth/login', null, async ({ req, res }) => {
  throttle(req.socket.remoteAddress);
  const { email, password } = await readJson(req);
  const out = auth.login(email, password);
  const secure = config.publicBaseUrl.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(out.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${secure}`);
  return out;
});
r('POST', '/api/auth/logout', null, async ({ req, res }) => {
  const h = req.headers.authorization || ''; const c = (req.headers.cookie || '').match(/sid=([^;]+)/);
  const t = h.startsWith('Bearer ') ? h.slice(7) : c && decodeURIComponent(c[1]);
  if (t) auth.logout(t);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
});
r('GET', '/api/me', ['admin', 'seller', 'buyer', 'warehouse'], async ({ user }) => user);

// Catalog (public for browsing)
r('GET', '/api/catalog', null, async ({ url }) => catalog.browse(Object.fromEntries(url.searchParams)));
r('GET', '/api/catalog/:id', null, async ({ params }) => catalog.buyerListing(params.id));
r('GET', '/api/config/public', null, async () => ({ currency: config.currency, shipping_flat: config.shippingFlat, payments: stripe.demoMode() ? 'demo' : 'stripe' }));

// Buyer
r('POST', '/api/buyer/checkout', BUYER, async ({ req, user }) => orders.buyerView(await orders.checkout(user, await readJson(req))));
r('GET', '/api/buyer/orders', BUYER, async ({ user }) => db.orders.all((o) => o.buyer_id === user.id).sort((a, b) => b.created_at - a.created_at).map(orders.buyerView));
r('GET', '/api/buyer/orders/:id', BUYER, async ({ user, params }) => {
  const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found'); return orders.buyerView(o);
});
r('POST', '/api/buyer/orders/:id/cancel', BUYER, async ({ user, params }) => {
  const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found');
  if (!['pending_payment', 'paid'].includes(o.status)) throw httpError(409, 'Order processing has started — please contact support');
  return orders.buyerView(await orders.cancelOrder(o.id, user.id));
});
r('POST', '/api/buyer/orders/:id/demo-pay', BUYER, async ({ user, params }) => {
  if (!stripe.demoMode()) throw httpError(403, 'Demo payment is disabled');
  const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found');
  return orders.buyerView(await orders.markPaid(o.id, { provider: 'demo', intent_id: o.payment?.intent_id }));
});

// Seller
const sellerSelf = (s) => ({ id: s.id, shop_name: s.shop_name, status: s.status, commission_pct: s.commission_pct, default_markup_pct: s.default_markup_pct ?? 30, auto_pay: s.auto_pay, taobao: sellerAuth.status(s) });
r('GET', '/api/seller/me', SELLER, async ({ seller }) => sellerSelf(seller));
r('PATCH', '/api/seller/me', SELLER, async ({ req, seller }) => {
  const b = await readJson(req); const patch = {};
  if (b.shop_name) patch.shop_name = String(b.shop_name).slice(0, 80);
  if (b.default_markup_pct !== undefined) { const m = Number(b.default_markup_pct); if (!(m >= 0 && m <= 500)) throw httpError(400, 'Invalid markup'); patch.default_markup_pct = m; }
  if (b.auto_pay !== undefined) patch.auto_pay = Boolean(b.auto_pay);
  return sellerSelf(db.sellers.update(seller.id, patch));
});
r('GET', '/api/seller/taobao/connect', SELLER, async ({ seller, url }) => ({ url: sellerAuth.buildAuthorizeUrl(seller.id, url.searchParams.get('return_to')) }));
r('POST', '/api/seller/products/preview', SELLER, async ({ req, seller }) => catalog.preview(seller, (await readJson(req)).link));
r('POST', '/api/seller/products', SELLER, async ({ req, seller }) => catalog.publish(seller, await readJson(req)));
r('GET', '/api/seller/products', SELLER, async ({ seller }) => db.listings.all((l) => l.seller_id === seller.id));
r('PATCH', '/api/seller/products/:id', SELLER, async ({ req, seller, params }) => {
  const l = db.listings.get(params.id); if (!l || l.seller_id !== seller.id) throw httpError(404, 'Not found');
  const b = await readJson(req); const patch = {};
  if (b.status) patch.status = catalog.sellerSetStatus(l, b.status);
  if (b.prices) patch.skus = l.skus.map((s) => (b.prices[s.mp_sku_id] > 0 ? { ...s, price: Math.round(b.prices[s.mp_sku_id] * 100) / 100 } : s));
  return db.listings.update(l.id, patch);
});
r('POST', '/api/seller/products/:id/resync', SELLER, async ({ seller, params }) => {
  const l = db.listings.get(params.id); if (!l || l.seller_id !== seller.id) throw httpError(404, 'Not found'); return catalog.resync(l.id);
});
r('GET', '/api/seller/orders', SELLER, async ({ seller }) => db.orders.all((o) => o.lines.some((l) => l.seller_id === seller.id) && o.status !== 'pending_payment').sort((a, b) => b.created_at - a.created_at).map((o) => orders.sellerView(o, seller.id)));
const sellerSub = (seller, id) => { const o = db.orders.get(id); const s = o?.sub_orders.find((x) => x.seller_id === seller.id); if (!s) throw httpError(404, 'Not found'); return { o, s }; };
r('POST', '/api/seller/orders/:id/pay', SELLER, async ({ seller, params }) => { const { o, s } = sellerSub(seller, params.id); return orders.paySub(o.id, s.outer_purchase_id); });
r('POST', '/api/seller/orders/:id/sync', SELLER, async ({ seller, params }) => { const { o, s } = sellerSub(seller, params.id); await orders.syncSub(o.id, s.outer_purchase_id); return orders.sellerView(db.orders.get(o.id), seller.id); });
r('GET', '/api/seller/earnings', SELLER, async ({ seller }) => {
  const led = db.ledger.all((l) => l.seller_id === seller.id && l.status !== 'void');
  const sum = (f) => Math.round(led.filter(f).reduce((a, l) => a + l.net, 0) * 100) / 100;
  return { currency: config.currency, pending: sum((l) => l.status === 'pending_payout'), payable: sum((l) => l.status === 'payable'), paid: sum((l) => l.status === 'paid'), entries: led.slice(-100).reverse() };
});

// Admin
r('GET', '/api/admin/overview', ADMIN, async () => admin.overview());
r('GET', '/api/admin/sellers', ADMIN, async () => admin.sellers());
r('PATCH', '/api/admin/sellers/:id', ADMIN, async ({ req, params }) => admin.updateSeller(params.id, await readJson(req)));
r('GET', '/api/admin/orders', ADMIN, async ({ url }) => admin.listOrders({ status: url.searchParams.get('status') || undefined }));
r('GET', '/api/admin/orders/:id', ADMIN, async ({ params }) => orders.decorate(db.orders.get(params.id)) || Promise.reject(httpError(404, 'Not found')));
r('POST', '/api/admin/orders/:id/procure', ADMIN, async ({ params }) => orders.decorate(await orders.procure(params.id)));
r('POST', '/api/admin/orders/:id/sync', ADMIN, async ({ params }) => {
  const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Not found');
  for (const s of o.sub_orders) { try { await orders.syncSub(o.id, s.outer_purchase_id); } catch { /* shown */ } }
  return orders.decorate(db.orders.get(o.id));
});
r('POST', '/api/admin/orders/:id/pay-taobao', ADMIN, async ({ params }) => {
  const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Not found');
  const out = [];
  for (const s of o.sub_orders.filter((x) => /WAIT_BUYER_P/.test(x.status))) out.push(await orders.paySub(o.id, s.outer_purchase_id));
  return out;
});
r('POST', '/api/admin/orders/:id/cancel', ADMIN, async ({ params, user }) => orders.decorate(await orders.cancelOrder(params.id, user.id)));
r('GET', '/api/admin/users', ADMIN, async () => admin.users());
r('POST', '/api/admin/staff', ADMIN, async ({ req }) => auth.createStaff(await readJson(req)));
r('GET', '/api/admin/listings', ADMIN, async ({ url }) => admin.listings({ status: url.searchParams.get('status') || undefined }));
r('POST', '/api/admin/listings/:id/approve', ADMIN, async ({ params, user }) => catalog.approve(params.id, user));
r('POST', '/api/admin/listings/:id/reject', ADMIN, async ({ req, params, user }) => catalog.reject(params.id, (await readJson(req)).reason, user));

// Warehouse
r('GET', '/api/warehouse/overview', WH, async () => ({ ...warehouse.inventory(), ...warehouse.lists() }));
r('POST', '/api/warehouse/receive', WH, async ({ req, user }) => warehouse.receive(await readJson(req), user));
r('POST', '/api/warehouse/parcels/:id/assign', WH, async ({ req, params }) => warehouse.assign(params.id, (await readJson(req)).order_id));
r('POST', '/api/warehouse/orders/:id/ship', WH, async ({ req, params, user }) => warehouse.ship(params.id, await readJson(req), user));
r('POST', '/api/warehouse/orders/:id/delivered', WH, async ({ params }) => warehouse.markDelivered(params.id));

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, 'ok');
    if (p === '/' ) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    if (p === '/admin' && req.method === 'GET') return page(res, 'admin.html');
    if (p === '/warehouse' && req.method === 'GET') return page(res, 'warehouse.html');

    if (p === '/webhooks/taobao') {
      if (req.method !== 'POST') return send(res, 200, 'ok');
      const raw = await readRaw(req);
      if (!raw || !req.headers.authorization) return send(res, 200, 'ok'); // console "Verify" ping
      const out = webhooks.taobao(raw, req.headers);
      send(res, out.status, out.body);
      if (out.status === 200) setImmediate(() => webhooks.processInbox().catch(() => {}));
      return;
    }
    if (p === '/webhooks/stripe' && req.method === 'POST') {
      const out = await webhooks.stripeHook(await readRaw(req), req.headers);
      return send(res, out.status, out.body);
    }
    if (p === '/oauth/callback') {
      try {
        const { return_to } = await sellerAuth.handleCallback(url.searchParams.get('code'), url.searchParams.get('state'));
        // Native seller app: deep link back (e.g. myapp://taobao-connected)
        const back = return_to && /^[a-z][a-z0-9+.-]*:\/\//i.test(return_to) && !/^(javascript|data):/i.test(return_to) ? return_to : null;
        if (back) { res.writeHead(302, { Location: back }); return res.end(); }
        return send(res, 200, 'Distribution Platform account connected. You can return to the app.');
      } catch (e) { return send(res, e.status || 400, `Connection failed: ${e.message}`); }
    }

    for (const rt of routes) {
      if (rt.method !== req.method) continue;
      const m = p.match(rt.re);
      if (!m) continue;
      const ctx = { req, res, url, params: m.groups || {} };
      if (rt.roles) {
        const user = auth.authenticate(req);
        Object.assign(ctx, auth.requireRole(user, ...rt.roles));
      }
      const out = await rt.handler(ctx);
      return send(res, req.method === 'POST' && /register|checkout|products$|staff/.test(p) ? 201 : 200, out ?? { ok: true });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || (e.name === 'TaobaoApiError' ? 502 : 500);
    if (status >= 500) console.error('[error]', req.method, p, e.code || '', e.message);
    send(res, status, { error: e.message || 'Error', code: e.code, request_id: e.requestId });
  }
});

function startJobs() {
  const every = (ms, fn) => setInterval(() => fn().catch(() => {}), ms).unref();
  every(30e3, webhooks.processInbox);
  every(config.orderSyncMinutes * 60e3, orders.syncOpen);
  every(3600e3, catalog.resyncStale);
  every(6 * 3600e3, sellerAuth.refreshAllDue);
}

if (require.main === module) {
  auth.bootstrapAdmin();
  const problems = configProblems();
  if (problems.length) console.warn('[config]', problems.join(' | '));
  server.listen(config.port, () => {
    console.log(`Platform on :${config.port}  admin: /admin  warehouse: /warehouse`);
    console.log(`OAuth callback: ${config.redirectUri}`);
  });
  startJobs();
}

module.exports = { server };

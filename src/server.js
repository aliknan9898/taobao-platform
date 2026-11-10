// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
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
const shopSvc = require('./services/shop');
const google = require('./googleAuth');
const aliexpress = require('./services/aliexpress');
const { COUNTRIES } = require('./countries');
const stripe = require('./payments/stripe');
const webhooks = require('./webhooks');
const legal = require('./legal');

const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_BODY = 4 * 1024 * 1024; // manual listings carry up to 6 resized photos
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
function page(res, file, { stripe: withStripe = false } = {}) {
  const stripeSrc = withStripe ? ' https://js.stripe.com' : '';
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; ` +
      `script-src 'self' 'unsafe-inline'${stripeSrc}; connect-src 'self'${withStripe ? ' https://api.stripe.com' : ''}; ` +
      `frame-src ${withStripe ? 'https://js.stripe.com https://hooks.stripe.com' : "'none'"}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'`
  });
  res.end(versionAssets(fs.readFileSync(path.join(PUBLIC, file), 'utf8')));
}

// Cache busting: every /assets/*.css|js link in a page gets ?v=<content hash>, so phones pick up
// a new deploy immediately instead of keeping yesterday's styles from their cache.
const assetVersions = new Map();
function assetVersion(name) {
  if (!assetVersions.has(name)) {
    let v = '0';
    try { v = require('crypto').createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, 'assets', name))).digest('hex').slice(0, 10); } catch { /* missing file */ }
    assetVersions.set(name, v);
  }
  return assetVersions.get(name);
}
const versionAssets = (html) => html.replace(/(["'])\/assets\/([\w.-]+\.(?:css|js))\1/g, (m, q, name) => `${q}/assets/${name}?v=${assetVersion(name)}${q}`);

// Static assets (CSS, JS, icons, manifests) — flat folder, no traversal
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' };
function asset(res, rel, cache = 'public, max-age=3600') {
  const name = path.basename(rel);
  const type = MIME[path.extname(name)];
  const file = path.join(PUBLIC, 'assets', name);
  if (name !== rel || !type || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

/** Where to send a seller after Taobao authorization: our own site, or a native app's custom scheme. */
function safeReturnTo(v) {
  if (!v) return null;
  let u; try { u = new URL(v); } catch { return null; }
  if (/^(javascript|data|vbscript|file):$/i.test(u.protocol)) return null;
  if (/^https?:$/.test(u.protocol)) return u.origin === new URL(config.publicBaseUrl).origin ? u.toString() : null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : null;
}

// Login throttling per IP: only FAILED sign-ins count, so people who share a network can still sign in.
const attempts = new Map();
function throttle(ip) {
  const now = Date.now(); const a = attempts.get(ip);
  if (a && now - a.t > 15 * 60e3) attempts.delete(ip);
  if ((attempts.get(ip)?.n || 0) >= 20) throw httpError(429, 'Too many attempts, try again later');
}
function recordFailure(ip) {
  const now = Date.now(); const a = attempts.get(ip) || { n: 0, t: now };
  a.n += 1; attempts.set(ip, a);
}

// ---------- routes ----------
// [method, pattern, roles (null = public), handler({req,res,params,url,user,seller,body})]
const routes = [];
const r = (method, pattern, roles, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]{1,80})')}$`), roles, handler });
const ADMIN = ['admin']; const SELLER = ['seller']; const BUYER = ['buyer']; const WH = ['warehouse', 'admin'];

// Auth
r('POST', '/api/auth/register', null, async ({ req }) => auth.register(await readJson(req)));
// SameSite=Lax so the cookie is kept after the redirect back from Google; still not sent on cross-site POSTs.
const setSession = (res, token) => {
  const secure = config.publicBaseUrl.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
};
r('POST', '/api/auth/login', null, async ({ req, res }) => {
  throttle(req.socket.remoteAddress);
  const { email, password } = await readJson(req);
  let out;
  try { out = auth.login(email, password); } catch (e) { if (e.status === 401) recordFailure(req.socket.remoteAddress); throw e; }
  setSession(res, out.token);
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
r('GET', '/api/shops', null, async () => shopSvc.listShops());
r('GET', '/api/shops/:id', null, async ({ params }) => shopSvc.getShop(params.id));
r('GET', '/api/config/public', null, async () => ({ currency: config.currency, shipping_flat: config.shippingFlat, payments: stripe.demoMode() ? 'demo' : 'stripe', stripe_publishable_key: config.stripePublishableKey || null, cny_rate: config.cnyRate, google_signin: google.enabled(), aliexpress: { import: aliexpress.apiReady(), delivery_days: config.aliexpress.deliveryDays }, countries: COUNTRIES, brand: 'Kinan', operator: { name: config.operator.name, email: config.operator.email || null } }));

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

r('POST', '/api/buyer/orders/:id/pay-wallet', BUYER, async ({ user, params }) => orders.buyerView(await orders.payWithWallet(params.id, user)));
r('GET', '/api/buyer/wallet', BUYER, async ({ user }) => shopSvc.walletOf(user.id));
r('GET', '/api/buyer/requests', BUYER, async ({ user }) => db.requests.all((x) => x.buyer_id === user.id).sort((a, b) => b.created_at - a.created_at).map(shopSvc.buyerRequestView));
r('POST', '/api/buyer/requests', BUYER, async ({ req, user }) => shopSvc.buyerRequestView(shopSvc.createRequest(user, await readJson(req))));

// Seller
const sellerSelf = (s) => ({ id: s.id, shop_name: s.shop_name, logo: s.logo || null, description: s.description || '', return_policy: s.return_policy || '', status: s.status, commission_pct: s.commission_pct, default_markup_pct: s.default_markup_pct ?? 30, auto_pay: s.auto_pay, taobao: sellerAuth.status(s) });
r('GET', '/api/seller/me', SELLER, async ({ seller }) => sellerSelf(seller));
r('PATCH', '/api/seller/me', SELLER, async ({ req, seller }) => {
  const b = await readJson(req); const patch = shopSvc.profilePatch(b);
  if (b.shop_name) patch.shop_name = String(b.shop_name).slice(0, 80);
  if (b.default_markup_pct !== undefined) { const m = Number(b.default_markup_pct); if (!(m >= 0 && m <= 500)) throw httpError(400, 'Invalid markup'); patch.default_markup_pct = m; }
  if (b.auto_pay !== undefined) patch.auto_pay = Boolean(b.auto_pay);
  return sellerSelf(db.sellers.update(seller.id, patch));
});
r('GET', '/api/seller/taobao/connect', SELLER, async ({ seller, url }) => {
  const rt = url.searchParams.get('return_to');
  if (!config.appKey) throw httpError(503, 'Taobao connection is not set up on Kinan yet. Please try again later.');
  if (rt && !safeReturnTo(rt)) throw httpError(400, 'return_to must be this site or an app URL scheme');
  return { url: sellerAuth.buildAuthorizeUrl(seller.id, rt) };
});
r('POST', '/api/seller/products/preview', SELLER, async ({ req, seller }) => catalog.preview(seller, (await readJson(req)).link));
r('POST', '/api/seller/products', SELLER, async ({ req, seller }) => catalog.publish(seller, await readJson(req)));
r('POST', '/api/seller/products/aliexpress/preview', SELLER, async ({ req, seller }) => aliexpress.preview(seller, (await readJson(req)).link));
r('POST', '/api/seller/products/aliexpress', SELLER, async ({ req, seller }) => aliexpress.publish(seller, await readJson(req)));
r('POST', '/api/seller/products/manual', SELLER, async ({ req, seller }) => catalog.publishManual(seller, await readJson(req)));
r('PUT', '/api/seller/products/:id/manual', SELLER, async ({ req, seller, params }) => catalog.publishManual(seller, await readJson(req), params.id));
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
const sellerSub = (seller, id) => { const o = db.orders.get(id); const s = o?.sub_orders.find((x) => x.seller_id === seller.id && !x.direct && !x.manual); if (!s) throw httpError(404, 'Not found'); return { o, s }; };
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
r('POST', '/api/admin/orders/:id/manual-bought', ADMIN, async ({ req, params, user }) => orders.decorate(orders.markManualBought(params.id, await readJson(req), user.id)));
r('POST', '/api/admin/orders/:id/aliexpress', ADMIN, async ({ req, params, user }) => orders.decorate(await orders.updateDirect(params.id, await readJson(req), user.id)));
r('GET', '/api/admin/aliexpress', ADMIN, async () => ({ ...aliexpress.status(), redirect_uri: config.aliexpress.redirectUri }));
r('POST', '/api/admin/aliexpress/connect', ADMIN, async () => ({ url: aliexpress.authorizeUrl() }));
r('POST', '/api/admin/aliexpress/disconnect', ADMIN, async () => aliexpress.disconnect());
r('POST', '/api/admin/orders/:id/cancel', ADMIN, async ({ params, user }) => orders.decorate(await orders.cancelOrder(params.id, user.id)));
r('GET', '/api/admin/users', ADMIN, async () => admin.users().map((u) => (u.role === 'buyer' ? { ...u, wallet: shopSvc.walletOf(u.id).balance } : u)));
r('GET', '/api/admin/wallet/:id', ADMIN, async ({ params }) => shopSvc.walletOf(params.id));
r('POST', '/api/admin/wallet/:id', ADMIN, async ({ req, params, user }) => shopSvc.adminAdjust(params.id, await readJson(req), user));
r('GET', '/api/admin/requests', ADMIN, async () => shopSvc.adminRequests());
r('PATCH', '/api/admin/requests/:id', ADMIN, async ({ req, params }) => shopSvc.answerRequest(params.id, await readJson(req)));
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
    if (req.method === 'GET') {
      if (p === '/' || p === '/shop') return page(res, 'shop.html', { stripe: true });
      if (p === '/seller') return page(res, 'seller.html');
      if (p === '/admin') return page(res, 'admin.html');
      if (p === '/warehouse') return page(res, 'warehouse.html');
      if (p === '/download' || p === '/apps') return page(res, 'download.html');
      if (legal.PAGES[p]) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'none'; base-uri 'none'; form-action 'none'" });
        return res.end(legal.render(p));
      }
      if (p === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); return fs.createReadStream(path.join(PUBLIC, 'sw.js')).pipe(res); }
      if (p === '/favicon.ico' || p === '/apple-touch-icon.png') return asset(res, p === '/favicon.ico' ? 'icon-192.png' : 'apple-touch-icon.png');
      if (p.startsWith('/assets/')) return asset(res, p.slice(8), url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache');
    }

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
    if (p === '/auth/google' && req.method === 'GET') {
      const app = ['seller', 'admin'].includes(url.searchParams.get('app')) ? url.searchParams.get('app') : 'shop';
      try { res.writeHead(302, { Location: google.authorizeUrl(app, url.searchParams.get('next')), 'Cache-Control': 'no-store' }); }
      catch (e) { res.writeHead(302, { Location: `${app === 'shop' ? '/' : `/${app}`}?login_error=${encodeURIComponent(e.message)}` }); }
      return res.end();
    }
    if (p === '/auth/google/callback' && req.method === 'GET') {
      throttle(req.socket.remoteAddress);
      try {
        const out = await google.callback({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') });
        if (out.token) setSession(res, out.token);
        res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store' });
      } catch (e) {
        recordFailure(req.socket.remoteAddress);
        if ((e.status || 500) >= 500) console.error('[google]', e.message);
        res.writeHead(302, { Location: `${e.home || '/'}?login_error=${encodeURIComponent(e.message)}` });
      }
      return res.end();
    }
    if (p === '/oauth/aliexpress/callback' && req.method === 'GET') {
      try { await aliexpress.handleCallback(url.searchParams.get('code'), url.searchParams.get('state')); res.writeHead(302, { Location: '/admin?aliexpress=connected' }); }
      catch (e) { res.writeHead(302, { Location: `/admin?login_error=${encodeURIComponent(e.message)}` }); }
      return res.end();
    }
    if (p === '/oauth/callback') {
      try {
        const { return_to } = await sellerAuth.handleCallback(url.searchParams.get('code'), url.searchParams.get('state'));
        // Native seller app: deep link back (e.g. myapp://taobao-connected)
        const back = safeReturnTo(return_to);
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
      return send(res, req.method === 'POST' && /register|checkout|products$|manual$|products\/aliexpress$|staff|requests$/.test(p) ? 201 : 200, out ?? { ok: true });
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
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Kinan on :${config.port}  store: /  seller: /seller  admin: /admin  warehouse: /warehouse`);
    console.log(`OAuth callback: ${config.redirectUri}`);
  });
  startJobs();
}

module.exports = { server, safeReturnTo };

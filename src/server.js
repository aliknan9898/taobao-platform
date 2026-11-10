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
const moneySvc = require('./services/money');
const shipping = require('./services/shipping');
const reports = require('./services/reports');
const couriers = require('./services/couriers');
const google = require('./googleAuth');
const aliexpress = require('./services/aliexpress');
const { COUNTRIES } = require('./countries');
const stripe = require('./payments/stripe');
const mailer = require('./mailer');
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
function page(res, file, { stripe: withStripe = false, head = '' } = {}) {
  // Stripe.js loads from js.stripe.com and its *.js.stripe.com subdomains (see Stripe's CSP guide)
  const stripeSrc = withStripe ? ' https://js.stripe.com https://*.js.stripe.com' : '';
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; ` +
      `script-src 'self' 'unsafe-inline'${stripeSrc}; connect-src 'self'${withStripe ? ' https://api.stripe.com' : ''}; ` +
      `frame-src ${withStripe ? 'https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com' : "'none'"}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'`
  });
  let html = versionAssets(fs.readFileSync(path.join(PUBLIC, file), 'utf8'));
  if (head) html = html.replace('</head>', `${head}\n</head>`);
  res.end(html);
}

/**
 * Share links: /p/<product> and /s/<shop> carry Open Graph tags so WhatsApp, Instagram, Facebook and X
 * show the photo, name and price. People who open them land on the same page in Kinan Shop.
 */
const attr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function shareHead({ title, description, image, url, type = 'website', price, currency, hash }) {
  const abs = (u) => (u && u.startsWith('/') ? config.publicBaseUrl + u : u);
  return [
    `<meta property="og:site_name" content="Kinan Shop">`, `<meta property="og:type" content="${attr(type)}">`,
    `<meta property="og:title" content="${attr(title)}">`, `<meta property="og:description" content="${attr(description)}">`,
    `<meta property="og:url" content="${attr(abs(url))}">`, image ? `<meta property="og:image" content="${attr(abs(image))}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`, `<meta name="description" content="${attr(description)}">`,
    price ? `<meta property="product:price:amount" content="${attr(price)}"><meta property="product:price:currency" content="${attr(String(currency).toUpperCase())}">` : '',
    `<link rel="canonical" href="${attr(abs(url))}">`,
    `<script>if(!location.hash)history.replaceState(null,'','/${hash}')</script>`
  ].filter(Boolean).join('\n');
}
function sharePage(res, kind, id) {
  try {
    if (kind === 'p') {
      const p = catalog.buyerListing(id);
      const price = `${p.min_price.toFixed(2)} ${String(p.currency).toUpperCase()}`;
      return page(res, 'shop.html', { stripe: true, head: shareHead({ title: `${p.title} — ${price}`, description: `${p.shop ? `Sold by ${p.shop.name} on Kinan Shop. ` : ''}${(p.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Delivered to your door with tracking.'}`, image: p.images[0], url: `/p/${p.id}`, type: 'product', price: p.min_price.toFixed(2), currency: p.currency, hash: `#/p/${p.id}` }) });
    }
    const s = shopSvc.getShop(id);
    return page(res, 'shop.html', { stripe: true, head: shareHead({ title: `${s.name} on Kinan Shop`, description: s.description || `${s.products} products, delivered to your door with tracking.`, image: s.logo, url: `/s/${s.id}`, hash: `#/s/${s.id}` }) });
  } catch { return page(res, 'shop.html', { stripe: true }); }
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

/** The visitor's IP. Render puts its proxy in front, so the socket address is the proxy for everyone. */
function clientIp(req) {
  const h = req.headers;
  const cf = h['cf-connecting-ip'] || h['true-client-ip'];
  if (cf) return String(cf).trim();
  const xff = String(h['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
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
// Staff roles: who may use which part of the admin dashboard
const STAFF = ['admin', 'procurement', 'finance', 'support'];       // overview + read orders
const PROC = ['admin', 'procurement'];                             // buying on Taobao / AliExpress
const FIN = ['admin', 'finance'];                                  // money: withdrawals, refunds, wallets, reports
const CARE = ['admin', 'support', 'procurement'];                  // item requests
const PEOPLE = ['admin', 'finance', 'support'];                    // users list

// Auth
// Sign-ups: at most 30 accounts per IP per hour (slows down spam without blocking families or offices)
const signups = new Map();
r('POST', '/api/auth/register', null, async ({ req }) => {
  const ip = clientIp(req); const now = Date.now();
  const list = (signups.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= 30) throw httpError(429, 'Too many new accounts from this network — try again later');
  const out = auth.register(await readJson(req));
  list.push(now); signups.set(ip, list);
  return out;
});
// SameSite=Lax so the cookie is kept after the redirect back from Google; still not sent on cross-site POSTs.
const setSession = (res, token) => {
  const secure = config.publicBaseUrl.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
};
r('POST', '/api/auth/login', null, async ({ req, res }) => {
  throttle(clientIp(req));
  const { email, password } = await readJson(req);
  let out;
  try { out = auth.login(email, password); } catch (e) { if (e.status === 401) recordFailure(clientIp(req)); throw e; }
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
// Forgot / reset password. Always answers OK so nobody can probe which emails have accounts.
const resetUrl = (token) => `${config.publicBaseUrl}/reset#t=${token}`;
r('POST', '/api/auth/forgot', null, async ({ req }) => {
  throttle(clientIp(req)); recordFailure(clientIp(req)); // every request counts towards the limit
  const { email } = await readJson(req);
  const u = db.users.find((x) => x.email === String(email || '').trim().toLowerCase() && x.status === 'active');
  if (u) await require('./notify').passwordReset(u, resetUrl(auth.createResetToken(u)));
  return { ok: true, email_enabled: require('./mailer').enabled() };
});
r('POST', '/api/auth/reset', null, async ({ req, res }) => {
  throttle(clientIp(req));
  const { token, password } = await readJson(req);
  let out;
  try { out = auth.resetPassword(token, password); } catch (e) { recordFailure(clientIp(req)); throw e; }
  setSession(res, out.token);
  return out;
});
r('GET', '/api/me', auth.ROLES, async ({ user }) => user);

// Catalog (public for browsing)
r('GET', '/api/catalog', null, async ({ url }) => catalog.browse(Object.fromEntries(url.searchParams)));
r('GET', '/api/catalog/:id', null, async ({ params }) => catalog.buyerListing(params.id));
r('GET', '/api/shops', null, async () => shopSvc.listShops());
r('GET', '/api/shops/:id', null, async ({ params }) => shopSvc.getShop(params.id));
r('GET', '/api/categories', null, async () => {
  const counts = {}; for (const p of catalog.browse({ limit: 100000 }).items) counts[p.category] = (counts[p.category] || 0) + 1;
  return shipping.CATEGORIES.map(([id, en, ar]) => ({ id, en, ar, count: counts[id] || 0 }));
});
r('POST', '/api/shipping/quote', null, async ({ req }) => { const b = await readJson(req); return shipping.quote(Array.isArray(b.items) ? b.items.slice(0, 100) : [], b.country_code || b.country); });
r('GET', '/api/config/public', null, async () => ({ currency: config.currency, shipping_flat: config.shippingFlat, payments: stripe.demoMode() ? 'demo' : 'stripe', stripe_publishable_key: config.stripePublishableKey || null, cny_rate: config.cnyRate, google_signin: google.enabled(), aliexpress: { import: aliexpress.apiReady(), delivery_days: config.aliexpress.deliveryDays }, countries: COUNTRIES, categories: shipping.CATEGORIES.map(([id, en, ar]) => ({ id, en, ar })), app_links: Object.fromEntries(Object.entries({ shop_android: process.env.SHOP_ANDROID_URL, shop_ios: process.env.SHOP_IOS_URL, seller_android: process.env.SELLER_ANDROID_URL, seller_ios: process.env.SELLER_IOS_URL }).filter(([, v]) => /^https:\/\//.test(v || ''))), brand: 'Kinan', operator: { name: config.operator.name, email: config.operator.email || null } }));

// Buyer
r('POST', '/api/buyer/checkout', BUYER, async ({ req, user }) => orders.buyerView(await orders.checkout(user, await readJson(req))));
r('GET', '/api/buyer/orders', BUYER, async ({ user }) => db.orders.all((o) => o.buyer_id === user.id).sort((a, b) => b.created_at - a.created_at).map(orders.buyerView));
r('GET', '/api/buyer/orders/:id', BUYER, async ({ user, params }) => {
  const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found');
  return { ...orders.buyerView(o), returns: db.returns.all((r) => r.order_id === o.id).map(moneySvc.buyerReturnView), return_days: moneySvc.RETURN_DAYS };
});
r('POST', '/api/buyer/orders/:id/cancel', BUYER, async ({ user, params }) => {
  const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found');
  if (!['pending_payment', 'paid'].includes(o.status)) throw httpError(409, 'Order processing has started — please contact support');
  return orders.buyerView(await orders.cancelOrder(o.id, user.id));
});
r('POST', '/api/buyer/orders/:id/returns', BUYER, async ({ req, user, params }) => moneySvc.buyerReturnView(moneySvc.requestReturn(user, params.id, await readJson(req))));
r('POST', '/api/buyer/orders/:id/demo-pay', BUYER, async ({ user, params }) => {
  if (!stripe.demoMode()) throw httpError(403, 'Demo payment is disabled');
  const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found');
  return orders.buyerView(await orders.markPaid(o.id, { provider: 'demo', intent_id: o.payment?.intent_id }));
});

r('POST', '/api/buyer/orders/:id/card-payment', BUYER, async ({ user, params }) => {
  const out = await orders.cardPayment(params.id, user);
  return out.paid ? { paid: true } : { client_secret: out.client_secret };
});
r('POST', '/api/buyer/orders/:id/confirm-card', BUYER, async ({ user, params }) => orders.buyerView(await orders.confirmCard(params.id, user)));
r('POST', '/api/buyer/orders/:id/pay-wallet', BUYER, async ({ user, params }) => orders.buyerView(await orders.payWithWallet(params.id, user)));
r('POST', '/api/buyer/orders/:id/pay-shipping-due', BUYER, async ({ user, params }) => {
  const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found');
  return orders.buyerView(shipping.payShippingDue(o, user));
});
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
  return b.prices ? catalog.checkMargins(db.listings.update(l.id, patch)) : db.listings.update(l.id, patch);
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
  const b = moneySvc.sellerBalance(seller.id);
  return { ...b, payable: b.available, paid: b.withdrawn, entries: led.slice(-100).reverse(), payouts: moneySvc.listPayouts({ sellerId: seller.id }).slice(0, 50), payout_details: seller.payout_details || null };
});
r('POST', '/api/seller/payouts', SELLER, async ({ req, seller }) => moneySvc.requestWithdrawal(seller, await readJson(req)));

// Admin
r('GET', '/api/admin/overview', STAFF, async () => admin.overview());
r('GET', '/api/admin/sellers', ADMIN, async () => admin.sellers());
r('PATCH', '/api/admin/sellers/:id', ADMIN, async ({ req, params }) => admin.updateSeller(params.id, await readJson(req)));
r('GET', '/api/admin/orders', STAFF, async ({ url }) => admin.listOrders({ status: url.searchParams.get('status') || undefined }));
r('GET', '/api/admin/orders/:id', STAFF, async ({ params }) => orders.decorate(db.orders.get(params.id)) || Promise.reject(httpError(404, 'Not found')));
r('POST', '/api/admin/orders/:id/procure', PROC, async ({ params }) => orders.decorate(await orders.procure(params.id)));
r('POST', '/api/admin/orders/:id/sync', STAFF, async ({ params }) => {
  const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Not found');
  for (const s of o.sub_orders) { try { await orders.syncSub(o.id, s.outer_purchase_id); } catch { /* shown */ } }
  return orders.decorate(db.orders.get(o.id));
});
r('POST', '/api/admin/orders/:id/pay-taobao', PROC, async ({ params }) => {
  const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Not found');
  const out = [];
  for (const s of o.sub_orders.filter((x) => /WAIT_BUYER_P/.test(x.status))) out.push(await orders.paySub(o.id, s.outer_purchase_id));
  return out;
});
r('POST', '/api/admin/orders/:id/manual-bought', PROC, async ({ req, params, user }) => orders.decorate(orders.markManualBought(params.id, await readJson(req), user.id)));
r('POST', '/api/admin/orders/:id/aliexpress', PROC, async ({ req, params, user }) => orders.decorate(await orders.updateDirect(params.id, await readJson(req), user.id)));
r('GET', '/api/admin/aliexpress', STAFF, async () => ({ ...aliexpress.status(), redirect_uri: config.aliexpress.redirectUri }));
r('POST', '/api/admin/aliexpress/connect', ADMIN, async () => ({ url: aliexpress.authorizeUrl() }));
r('POST', '/api/admin/aliexpress/disconnect', ADMIN, async () => aliexpress.disconnect());
r('POST', '/api/admin/orders/:id/cancel', FIN, async ({ params, user }) => orders.decorate(await orders.cancelOrder(params.id, user.id)));
r('GET', '/api/admin/staff-roles', ADMIN, async () => auth.STAFF_ROLES);
r('GET', '/api/admin/users', PEOPLE, async () => admin.users().map((u) => (u.role === 'buyer' ? { ...u, wallet: shopSvc.walletOf(u.id).balance } : u)));
r('POST', '/api/admin/users/:id/reset-link', ['admin', 'support'], async ({ params, user }) => {
  const u = db.users.get(params.id); if (!u) throw httpError(404, 'User not found');
  if (user.role !== 'admin' && !['buyer', 'seller'].includes(u.role)) throw httpError(403, 'Only an admin can reset a staff password');
  return { url: resetUrl(auth.createResetToken(u)), expires_in_minutes: 60 };
});
r('GET', '/api/admin/mail', ADMIN, async () => ({ enabled: mailer.enabled(), sender: mailer.sender().email, reply_to: config.mail.replyTo || null, domain: mailer.domainStatus(), recent: db.mail.all().slice(-50).reverse() }));
// Send a test email (to the admin, or to one of the site's own addresses) to check sending and forwarding
r('POST', '/api/admin/mail/test', ADMIN, async ({ req, user }) => {
  const { to } = await readJson(req);
  const target = String(to || user.email).trim().toLowerCase();
  const own = target === user.email || (mailer.domainStatus()?.domain && target.endsWith(`@${mailer.domainStatus().domain}`));
  if (!own) throw httpError(400, 'Test emails go to your own address or one of the site addresses');
  const rec = await mailer.send({ to: target, subject: 'Kinan test email', title: 'Email is working', lines: [`This test was sent from ${mailer.sender().email} to ${target}.`, 'If you can read this, sending works.'], kind: 'test' });
  return { status: rec.status, error: rec.error || null, from: mailer.sender().email };
});
r('GET', '/api/admin/wallet/:id', FIN, async ({ params }) => shopSvc.walletOf(params.id));
r('POST', '/api/admin/wallet/:id', FIN, async ({ req, params, user }) => shopSvc.adminAdjust(params.id, await readJson(req), user));
r('GET', '/api/admin/settings/shipping', STAFF, async () => ({ ...shipping.settings(), zones: shipping.ZONES.map(([id, name, countries]) => ({ id, name, countries })) }));
r('PUT', '/api/admin/settings/shipping', ADMIN, async ({ req }) => shipping.saveSettings(await readJson(req)));
r('GET', '/api/admin/reports', FIN, async ({ url }) => reports.report(Object.fromEntries(url.searchParams)));
r('GET', '/api/admin/reports/orders.csv', FIN, async ({ url, res }) => {
  const csv = reports.ordersCsv(Object.fromEntries(url.searchParams));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="kinan-orders-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
  res.end(csv);
});
r('GET', '/api/admin/payouts', FIN, async ({ url }) => moneySvc.listPayouts({ status: url.searchParams.get('status') || undefined }));
r('POST', '/api/admin/payouts/:id', FIN, async ({ req, params, user }) => moneySvc.decidePayout(params.id, await readJson(req), user));
r('GET', '/api/admin/returns', PEOPLE, async () => moneySvc.adminReturns());
r('POST', '/api/admin/returns/:id', PEOPLE, async ({ req, params, user }) => {
  const b = await readJson(req);
  if (b.action === 'refund' && !FIN.includes(user.role)) throw httpError(403, 'Only admin or finance can issue refunds');
  return moneySvc.decideReturn(params.id, b, user);
});
r('GET', '/api/admin/requests', CARE, async () => shopSvc.adminRequests());
r('PATCH', '/api/admin/requests/:id', CARE, async ({ req, params }) => shopSvc.answerRequest(params.id, await readJson(req)));
r('POST', '/api/admin/staff', ADMIN, async ({ req }) => auth.createStaff(await readJson(req)));
r('GET', '/api/admin/listings', ADMIN, async ({ url }) => admin.listings({ status: url.searchParams.get('status') || undefined }));
r('POST', '/api/admin/listings/:id/approve', ADMIN, async ({ params, user }) => catalog.approve(params.id, user));
r('POST', '/api/admin/listings/:id/reject', ADMIN, async ({ req, params, user }) => catalog.reject(params.id, (await readJson(req)).reason, user));

// Warehouse
r('GET', '/api/warehouse/overview', WH, async () => ({ ...warehouse.inventory(), ...warehouse.lists() }));
r('POST', '/api/warehouse/receive', WH, async ({ req, user }) => warehouse.receive(await readJson(req), user));
r('POST', '/api/warehouse/parcels/:id/assign', WH, async ({ req, params }) => warehouse.assign(params.id, (await readJson(req)).order_id));
r('POST', '/api/warehouse/orders/:id/ship', WH, async ({ req, params, user }) => warehouse.ship(params.id, await readJson(req), user));
r('GET', '/api/warehouse/couriers', WH, async () => couriers.status());
r('POST', '/api/warehouse/orders/:id/rates', WH, async ({ req, params }) => {
  const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Order not found');
  return couriers.rates(o, await readJson(req));
});
r('POST', '/api/warehouse/orders/:id/label', WH, async ({ req, params, user }) => {
  const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Order not found');
  if (o.status !== 'ready_to_ship') throw httpError(409, 'Order is not ready to ship');
  const b = await readJson(req);
  const out = await couriers.label(o, b, b);
  const s = warehouse.ship(o.id, { carrier: out.carrier, tracking: out.tracking, weight_g: b.weight_g, cost: out.cost, label: out.label }, user);
  return { ...s, label: s.label ? { type: s.label.type } : null };
});
r('GET', '/api/warehouse/shipments/:id/label', WH, async ({ params, res }) => {
  const s = db.shipments.get(params.id); if (!s?.label) throw httpError(404, 'No label for this shipment');
  if (s.label.type === 'url') { res.writeHead(302, { Location: s.label.url }); return res.end(); }
  const pdf = Buffer.from(s.label.data, 'base64');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="label-${s.tracking}.pdf"`, 'Content-Length': pdf.length, 'Cache-Control': 'no-store' });
  res.end(pdf);
});
r('POST', '/api/warehouse/orders/:id/delivered', WH, async ({ params }) => warehouse.markDelivered(params.id));

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, 'ok');
    // Send visitors of the old *.onrender.com address to the main domain (pages only; API calls and webhooks keep working)
    const host = String(req.headers.host || '').toLowerCase();
    const mainHost = new URL(config.publicBaseUrl).host;
    if ((req.method === 'GET' || req.method === 'HEAD') && host.endsWith('.onrender.com') && !mainHost.endsWith('.onrender.com') && host !== mainHost && !p.startsWith('/api/') && !p.startsWith('/webhooks/')) {
      res.writeHead(301, { Location: config.publicBaseUrl + req.url });
      return res.end();
    }
    if (req.method === 'GET') {
      if (p === '/' || p === '/shop') return page(res, 'shop.html', { stripe: true });
      const sh = p.match(/^\/(p|s)\/([\w-]{1,80})$/);
      if (sh) return sharePage(res, sh[1], sh[2]);
      if (p === '/seller') return page(res, 'seller.html');
      if (p === '/admin') return page(res, 'admin.html');
      if (p === '/warehouse') return page(res, 'warehouse.html');
      if (p === '/download' || p === '/apps') return page(res, 'download.html');
      if (p === '/reset') return page(res, 'reset.html');
      if (legal.PAGES[p]) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'none'; base-uri 'none'; form-action 'none'" });
        return res.end(legal.render(p));
      }
      const im = p.match(/^\/img\/(l|s)\/([\w-]{1,80})(?:\/(\d{1,2}))?$/);
      if (im) {
        const img = catalog.imageData(im[1], im[2], im[3]);
        if (!img) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.body.length, 'Cache-Control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
        return res.end(img.body);
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
      throttle(clientIp(req));
      try {
        const out = await google.callback({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') });
        if (out.token) setSession(res, out.token);
        res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store' });
      } catch (e) {
        recordFailure(clientIp(req));
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
      if (res.writableEnded) return; // handler wrote its own response (e.g. a CSV download)
      return send(res, req.method === 'POST' && /register|checkout|products$|manual$|products\/aliexpress$|staff|requests$/.test(p) ? 201 : 200, out ?? { ok: true });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || (e.name === 'TaobaoApiError' ? 502 : 500);
    if (status >= 500) console.error('[error]', req.method, p, e.code || '', e.message);
    send(res, status, { error: e.message || 'Error', code: e.code, request_id: e.requestId });
  }
});

/** Remove expired sessions, sign-in states and reset links so the database doesn't grow forever. */
function cleanup(now = Date.now()) {
  let n = 0;
  for (const x of db.sessions.all((s) => s.expires_at < now)) { db.sessions.remove(x.id); n++; }
  for (const x of db.oauthStates.all((s) => (s.expires_at || 0) < now)) { db.oauthStates.remove(x.id); n++; }
  for (const x of db.tokens.all((t) => t.expires_at < now)) { db.tokens.remove(x.id); n++; }
  return n;
}

function startJobs() {
  const every = (ms, fn) => setInterval(() => fn().catch(() => {}), ms).unref();
  every(30e3, webhooks.processInbox);
  every(config.orderSyncMinutes * 60e3, orders.syncOpen);
  every(3600e3, catalog.resyncStale);
  every(6 * 3600e3, sellerAuth.refreshAllDue);
  every(3600e3, async () => cleanup());
}

if (require.main === module) (async () => {
  try { await db.init(); } catch (e) { console.error('[db] could not connect to PostgreSQL:', e.message); process.exit(1); }
  auth.bootstrapAdmin();
  const problems = configProblems();
  if (problems.length) console.warn('[config]', problems.join(' | '));
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Kinan on :${config.port}  store: /  seller: /seller  admin: /admin  warehouse: /warehouse`);
    console.log(`OAuth callback: ${config.redirectUri}`);
  });
  startJobs();
  // Brevo: add/check the site's domain now, then every 30 minutes until it is authenticated
  const mailDomain = () => mailer.setupDomain().catch((e) => console.error('[mail] domain setup:', e.message));
  // MAIL_SELFTEST=a@x,b@y sends one test email to each address at start-up (to check sending and forwarding), then remove it
  if (process.env.MAIL_SELFTEST) mailDomain().then(async () => {
    for (const to of process.env.MAIL_SELFTEST.split(',').map((x) => x.trim()).filter(Boolean)) {
      const rec = await mailer.send({ to, subject: `Kinan test email to ${to}`, title: 'Email is working', lines: [`Sent from ${mailer.sender().email} to ${to}.`, 'If this reached your inbox, sending and forwarding work.'], kind: 'test' });
      console.log(`[mail] self-test to ${to}: ${rec ? rec.status : 'skipped'}${rec?.error ? ` — ${rec.error}` : ''}`);
    }
  });
  else mailDomain(); setInterval(() => { const d = mailer.domainStatus(); if (!d || !d.authenticated || !d.sender_ready) mailDomain(); }, 30 * 60e3).unref();
  stripe.setup().then((r) => { if (r.ok) console.log(`[stripe] ready (${r.mode} mode)`); }).catch((e) => console.error('[stripe] setup failed:', e.message));
  // Render stops the instance with SIGTERM: write pending changes first
  const stop = async () => { try { await db.close(); } catch { /* exiting */ } process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})();

module.exports = { server, safeReturnTo, cleanup, clientIp };

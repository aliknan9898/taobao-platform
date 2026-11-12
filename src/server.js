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
const cjs = require('./services/cj');
const { COUNTRIES } = require('./countries');
const stripe = require('./payments/stripe');
const mailer = require('./mailer');
const fx = require('./services/fx');
const growth = require('./services/growth');
const messages = require('./services/messages');
const ops = require('./services/ops');
const seo = require('./seo');
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
function page(res, file, { stripe: withStripe = false, head = '', title = '', body = '' } = {}) {
  // Customer pages may load analytics tools (only after the visitor accepts cookies)
  const an = ['shop.html', 'download.html'].includes(file) ? seo.analyticsCsp() : { script: '', connect: '' };
  // Stripe.js loads from js.stripe.com and its *.js.stripe.com subdomains (see Stripe's CSP guide)
  const stripeSrc = withStripe ? ' https://js.stripe.com https://*.js.stripe.com' : '';
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; ` +
      `script-src 'self' 'unsafe-inline'${stripeSrc}${an.script}; connect-src 'self'${withStripe ? ' https://api.stripe.com' : ''}${an.connect}; ` +
      `frame-src ${withStripe ? 'https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com' : "'none'"}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'`
  });
  let html = versionAssets(fs.readFileSync(path.join(PUBLIC, file), 'utf8'));
  const meta = ['shop.html', 'download.html'].includes(file) ? seo.verificationMeta() : '';
  if (title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${attr(title)}</title>`);
  if (/name="description"/.test(head)) html = html.replace(/<meta name="description"[^>]*>\n?/, '');
  if (head || meta) html = html.replace('</head>', `${meta}${head}\n</head>`);
  // Readable content for search engines and AI crawlers; the app replaces it as soon as it starts
  if (body) html = html.replace('<main id="view" class="wrap"></main>', `<main id="view" class="wrap">${body}</main>`);
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
      const raw = db.listings.get(id);
      const price = `${p.min_price.toFixed(2)} ${String(p.currency).toUpperCase()}`;
      return page(res, 'shop.html', { stripe: true, title: `${p.title} — ${price} | Kinan Shop`, body: raw && raw.status === 'active' ? seo.ssrProduct(raw, db.sellers.get(raw.seller_id)) : '', head: shareHead({ title: `${p.title} — ${price}`, description: `${p.shop ? `Sold by ${p.shop.name} on Kinan Shop. ` : ''}${(p.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Delivered to your door with tracking.'}`, image: p.images[0], url: `/p/${p.id}`, type: 'product', price: p.min_price.toFixed(2), currency: p.currency, hash: `#/p/${p.id}` }) + (raw && raw.status === 'active' ? seo.productJsonLd(raw, db.sellers.get(raw.seller_id)) : '<meta name="robots" content="noindex">') });
    }
    const s = shopSvc.getShop(id);
    return page(res, 'shop.html', { stripe: true, title: `${s.name} — Kinan Shop`, body: seo.ssrList({ title: s.name, intro: s.description, seller_id: s.id }), head: shareHead({ title: `${s.name} on Kinan Shop`, description: s.description || `${s.products} products, delivered to your door with tracking.`, image: s.logo, url: `/s/${s.id}`, hash: `#/s/${s.id}` }) });
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

/** Light per-IP limit for public helpers (link reading, estimates): 120 calls per 10 minutes. */
const light = new Map();
function throttleLight(req) {
  const ip = clientIp(req); const now = Date.now(); let a = light.get(ip);
  if (!a || now - a.t > 10 * 60e3) { a = { n: 0, t: now }; light.set(ip, a); }
  if (++a.n > 120) throw httpError(429, 'Too many requests, try again in a few minutes');
  if (light.size > 5000) for (const [k, v] of light) if (now - v.t > 10 * 60e3) light.delete(k);
}

/** Server errors reach the owner on Telegram, at most one every 10 minutes. */
let lastErrAlert = 0;
function errorAlert(text) { if (Date.now() - lastErrAlert < 10 * 60e3) return; lastErrAlert = Date.now(); require('./push').telegram(`🔴 Kinan server error\n${String(text).slice(0, 400)}`); }
process.on('unhandledRejection', (e) => { console.error('[unhandled]', e?.message || e); errorAlert(`Unhandled: ${e?.message || e}`); });

/** Send a stored photo ({ type, body }) as an image response. */
/** The app's language (sent by the apps) or, failing that, the browser/phone language. */
function reqLang(req) {
  const h = String(req.headers['x-kinan-lang'] || '').toLowerCase();
  if (h === 'ar' || h === 'en') return h;
  const al = String(req.headers['accept-language'] || '').toLowerCase();
  return al.startsWith('ar') ? 'ar' : /^[a-z]{2}/.test(al) ? 'en' : null;
}
function sendImage(res, img) {
  if (!img) throw httpError(404, 'Photo not found');
  res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.body.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(img.body);
}

// ---------- routes ----------
// [method, pattern, roles (null = public), handler({req,res,params,url,user,seller,body})]
const routes = [];
const r = (method, pattern, roles, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]{1,80})')}$`), roles, handler });
const ADMIN = ['admin']; const SELLER = ['seller']; const BUYER = ['buyer']; const WH = ['warehouse', 'admin'];
// Staff roles: who may use which part of the admin dashboard
const STAFF = ['admin', 'procurement', 'finance', 'support'];       // overview + read orders
const PROC = ['admin', 'procurement'];                             // buying on Taobao / AliExpress
const SELLER_OR_STAFF = ['seller', ...STAFF];                       // CJ catalog search
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
  const out = auth.register({ ...(await readJson(req)), lang: reqLang(req) });
  list.push(now); signups.set(ip, list);
  if (out?.role === 'seller' || out?.user?.role === 'seller') require('./push').telegram(`🏪 New seller signed up — approve them in the admin dashboard\n${config.publicBaseUrl}/admin`);
  return out;
});
// SameSite=Lax so the cookie is kept after the redirect back from Google; still not sent on cross-site POSTs.
// Seller Center sessions use their own cookie (ssid), so one email can be signed in as customer and seller at once.
const setSession = (res, token, role) => {
  const secure = config.publicBaseUrl.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${auth.cookieName(role)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
};
r('POST', '/api/auth/login', null, async ({ req, res }) => {
  throttle(clientIp(req));
  const { email, password, app } = await readJson(req);
  const which = app || (auth.sellerContext(req) ? 'seller' : undefined);
  let out;
  try { out = auth.login(email, password, which); } catch (e) { if (e.status === 401) recordFailure(clientIp(req)); throw e; }
  setSession(res, out.token, which === 'seller' || (!which && out.user.role === 'seller') ? 'seller' : 'buyer');
  return out;
});
r('POST', '/api/auth/logout', null, async ({ req, res }) => {
  const t = auth.tokenFromRequest(req);
  if (t) auth.logout(t);
  res.setHeader('Set-Cookie', `${auth.sellerContext(req) ? 'ssid' : 'sid'}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  return { ok: true };
});
// Forgot / reset password. Always answers OK so nobody can probe which emails have accounts.
const resetUrl = (token) => `${config.publicBaseUrl}/reset#t=${token}`;
r('POST', '/api/auth/forgot', null, async ({ req }) => {
  throttle(clientIp(req)); recordFailure(clientIp(req)); // every request counts towards the limit
  const { email, app } = await readJson(req);
  // The email may have a customer and a seller account: reset the one for the app it was asked from (else each)
  const all = auth.usersByEmail(email).filter((x) => x.status === 'active');
  const role = auth.APP_ROLE[app]; const mine = role ? all.filter((x) => x.role === role) : [];
  for (const u of mine.length ? mine : all) await require('./notify').passwordReset(u, resetUrl(auth.createResetToken(u)));
  return { ok: true, email_enabled: require('./mailer').enabled() };
});
r('POST', '/api/auth/reset', null, async ({ req, res }) => {
  throttle(clientIp(req));
  const { token, password } = await readJson(req);
  let out;
  try { out = auth.resetPassword(token, password); } catch (e) { recordFailure(clientIp(req)); throw e; }
  setSession(res, out.token, out.user.role);
  return out;
});
r('GET', '/api/me', auth.ROLES, async ({ req, user }) => {
  // Invited by a friend (?ref= link, kept in a cookie): link the new customer to them once
  const full = user.role === 'buyer' ? db.users.get(user.id) : null;
  if (full && !full.referred_by && !full.ref_checked && Date.now() - (full.created_at || 0) < 3600e3) {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)kinan_ref=([A-Za-z0-9_-]{3,24})/);
    if (m) { growth.attachReferrer(full, m[1]); db.users.update(full.id, { ref_checked: true }); }
  }
  return user;
});

// Catalog (public for browsing)
r('GET', '/api/catalog', null, async ({ url }) => catalog.browse(Object.fromEntries(url.searchParams)));
r('GET', '/api/catalog/:id', null, async ({ req, params }) => { const out = catalog.buyerListing(params.id); try { ops.countView(db.listings.get(params.id), clientIp(req)); } catch { /* stats are best effort */ } return out; });
r('GET', '/api/catalog/:id/reviews', null, async ({ params }) => growth.reviewsFor(params.id));
r('GET', '/api/shops', null, async () => shopSvc.listShops());
r('GET', '/api/shops/:id', null, async ({ params }) => shopSvc.getShop(params.id));
r('GET', '/api/categories', null, async () => {
  const counts = {}; for (const p of catalog.browse({ limit: 100000 }).items) counts[p.category] = (counts[p.category] || 0) + 1;
  return shipping.CATEGORIES.map(([id, en, ar]) => ({ id, en, ar, count: counts[id] || 0 }));
});
r('POST', '/api/shipping/prepare', null, async ({ req }) => { throttleLight(req); const b = await readJson(req); return cjs.prepareCountry(String(b.country_code || '').toUpperCase()); });
r('POST', '/api/shipping/quote', null, async ({ req }) => {
  const b = await readJson(req); const items = Array.isArray(b.items) ? b.items.slice(0, 100) : [];
  const q = shipping.quote(items, b.country_code || b.country);
  const cc = q.country_code || require('./countries').countryCode(b.country_code || b.country);
  const c = await cjs.quote(items, cc);
  const g = await require('./services/banggood').quote(items, cc);
  if (!c && !g) return q;
  const extra = (c?.fee || 0) + (g?.fee || 0);
  return { ...q, fee: Math.round((q.fee + extra) * 100) / 100, ...(c ? { cj: c } : {}), ...(g ? { banggood: g } : {}), days: q.fee ? q.days : c?.days || g?.days || q.days, note: extra ? undefined : q.note };
});
r('GET', '/api/config/public', null, async () => ({ currency: config.currency, shipping_flat: config.shippingFlat, payments: stripe.demoMode() ? 'demo' : 'stripe', stripe_publishable_key: config.stripePublishableKey || null, cny_rate: config.cnyRate, google_signin: google.enabled(), aliexpress: { import: aliexpress.apiReady(), delivery_days: config.aliexpress.deliveryDays }, cj: require('./cj/client').enabled(), banggood: require('./banggood/client').enabled(), taobao_kinan: sellerAuth.platformConnected(), ai: require('./services/ai').enabled(), collections: require('./services/seasonal').publicInfo(), countries: [...COUNTRIES].sort((a, b) => a[1].localeCompare(b[1], 'en')), categories: shipping.CATEGORIES.map(([id, en, ar]) => ({ id, en, ar })), packaging: orders.PACKAGING, storage_days: orders.STORAGE_DAYS, fx: fx.publicRates(), currency_by_country: Object.fromEntries(COUNTRIES.map(([c]) => [c, fx.currencyFor(c)]).filter(([, v]) => v !== 'USD')), analytics: seo.analytics(), whatsapp: String(process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '') || null, app_links: Object.fromEntries(Object.entries({ shop_android: process.env.SHOP_ANDROID_URL, shop_ios: process.env.SHOP_IOS_URL, seller_android: process.env.SELLER_ANDROID_URL, seller_ios: process.env.SELLER_IOS_URL }).filter(([, v]) => /^https:\/\//.test(v || ''))), brand: 'Kinan', operator: { name: config.operator.name, email: config.operator.email || null } }));

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

r('GET', '/api/buyer/cards', BUYER, async ({ user }) => stripe.listCards(user));
r('POST', '/api/buyer/cards/setup', BUYER, async ({ req, user }) => { throttleLight(req); return stripe.cardSetup(user); });
r('DELETE', '/api/buyer/cards/:id', BUYER, async ({ user, params }) => stripe.removeCard(user, params.id));
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
r('GET', '/api/buyer/orders/:id/qc/:n', BUYER, async ({ user, params, res }) => { const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found'); return sendImage(res, warehouse.qcPhoto(o, params.n)); });
r('POST', '/api/buyer/orders/:id/qc', BUYER, async ({ req, user, params }) => { const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Not found'); return orders.buyerView(warehouse.qcDecision(o, user, await readJson(req))); });
r('POST', '/api/buyer/ship-stored', BUYER, async ({ user }) => warehouse.releaseStored(user));
r('POST', '/api/buyer/coupon', BUYER, async ({ req, user }) => { throttleLight(req); const b = await readJson(req); return growth.couponFor(b.code, user, Number(b.subtotal) || 0); });
r('GET', '/api/buyer/referral', BUYER, async ({ user }) => growth.referralInfo(db.users.get(user.id)));
r('GET', '/api/buyer/wishlist', BUYER, async ({ user }) => growth.wishlist(user));
r('POST', '/api/buyer/wishlist/:id', BUYER, async ({ user, params }) => growth.save(user, params.id));
r('DELETE', '/api/buyer/wishlist/:id', BUYER, async ({ user, params }) => growth.unsave(user, params.id));
r('GET', '/api/buyer/wishlist/:id', BUYER, async ({ user, params }) => ({ saved: growth.isSaved(user, params.id) }));
r('POST', '/api/buyer/orders/:id/reviews', BUYER, async ({ req, user, params }) => growth.publicReview(growth.addReview(db.users.get(user.id), params.id, await readJson(req))));
r('GET', '/api/buyer/reviews', BUYER, async ({ user }) => db.reviews.all((x) => x.user_id === user.id).map((x) => ({ order_id: x.order_id, listing_id: x.listing_id, rating: x.rating })));
r('PUT', '/api/buyer/cart', BUYER, async ({ req, user }) => growth.saveCart(user, (await readJson(req)).items));
r('GET', '/api/push/key', null, async () => ({ key: require('./push').vapid().publicKey }));
r('POST', '/api/push/subscribe', auth.ROLES, async ({ req, user }) => require('./push').subscribe(user, await readJson(req)));
r('POST', '/api/push/unsubscribe', auth.ROLES, async ({ req, user }) => require('./push').unsubscribe(user, (await readJson(req)).endpoint));
r('GET', '/api/buyer/orders/:id/messages', BUYER, async ({ user, params }) => { const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found'); return { shops: [...new Set(o.lines.map((l) => l.seller_id))].map((id) => db.sellers.get(id)).filter((s) => s && !s.system).map((s) => ({ id: s.id, name: s.shop_name })), messages: messages.threadsFor(o, { role: 'buyer' }) }; });
r('POST', '/api/buyer/orders/:id/messages', BUYER, async ({ req, user, params }) => { const o = db.orders.get(params.id); if (!o || o.buyer_id !== user.id) throw httpError(404, 'Not found'); return messages.post(o, { role: 'buyer', user: db.users.get(user.id) }, await readJson(req)); });
// Address book: several delivery addresses, one chosen for shipping
const cleanAddr = (a = {}) => {
  const t = (v, n) => String(v ?? '').trim().slice(0, n);
  const o = { id: /^adr_[a-z0-9]{6,20}$/.test(a.id) ? a.id : `adr_${require('crypto').randomBytes(6).toString('hex')}`, label: t(a.label, 40), name: t(a.name, 100), phone: t(a.phone, 30), country_code: t(a.country_code, 2).toUpperCase(), city: t(a.city, 80), line1: t(a.line1, 200), line2: t(a.line2, 200), postal_code: t(a.postal_code, 20), state: t(a.state, 80) };
  if (!o.name || !o.phone || !o.city || !o.line1 || !/^[A-Z]{2}$/.test(o.country_code)) throw httpError(400, 'Each address needs a name, phone, country, city and street');
  return o;
};
r('GET', '/api/buyer/addresses', BUYER, async ({ user }) => { const u = db.users.get(user.id); return { addresses: u.addresses || [], selected: u.address_selected || null }; });
r('PUT', '/api/buyer/addresses', BUYER, async ({ req, user }) => {
  const b = await readJson(req); const list = (Array.isArray(b.addresses) ? b.addresses : []).slice(0, 10).map(cleanAddr);
  const selected = list.some((a) => a.id === b.selected) ? b.selected : list[0]?.id || null;
  db.users.update(user.id, { addresses: list, address_selected: selected });
  return { addresses: list, selected };
});
r('GET', '/api/buyer/wallet', BUYER, async ({ user }) => shopSvc.walletOf(user.id));
r('POST', '/api/buyforme/parse', null, async ({ req }) => { throttleLight(req); const b = await readJson(req); return require('./services/buyforme').parse(b.text || b.link); });
r('POST', '/api/buyforme/estimate', null, async ({ req }) => { throttleLight(req); return require('./services/buyforme').estimate(await readJson(req)); });
r('POST', '/api/buyer/requests/:id/accept', BUYER, async ({ user, params }) => require('./services/buyforme').accept(user, params.id));
r('GET', '/api/buyer/requests', BUYER, async ({ user }) => db.requests.all((x) => x.buyer_id === user.id).sort((a, b) => b.created_at - a.created_at).map(shopSvc.buyerRequestView));
r('POST', '/api/buyer/requests', BUYER, async ({ req, user }) => shopSvc.buyerRequestView(shopSvc.createRequest(user, await readJson(req))));

// Seller
const sellerSelf = (s) => ({ verification: (({ state, reason, submitted_at }) => ({ state, reason, submitted_at }))(require('./services/kyc').view(s)), id: s.id, shop_name: s.shop_name, logo: s.logo || null, description: s.description || '', return_policy: s.return_policy || '', status: s.status, commission_pct: s.commission_pct, default_markup_pct: s.default_markup_pct ?? 30, auto_pay: s.auto_pay, taobao: sellerAuth.status(s) });
r('GET', '/api/seller/me', SELLER, async ({ seller }) => sellerSelf(seller));
// Identity verification: details + document + live selfie, then the admin approves the shop
r('GET', '/api/seller/verification', SELLER, async ({ seller }) => require('./services/kyc').view(seller));
r('POST', '/api/seller/verification', SELLER, async ({ req, seller, user }) => require('./services/kyc').submit(seller, user, await readJson(req)));
r('PATCH', '/api/seller/me', SELLER, async ({ req, seller }) => {
  const b = await readJson(req); const patch = shopSvc.profilePatch(b);
  if (b.shop_name) patch.shop_name = String(b.shop_name).slice(0, 80);
  if (b.default_markup_pct !== undefined) { const m = Number(b.default_markup_pct); if (!(m >= 0 && m <= 500)) throw httpError(400, 'Invalid markup'); patch.default_markup_pct = m; }
  if (b.auto_pay !== undefined) patch.auto_pay = Boolean(b.auto_pay);
  return sellerSelf(db.sellers.update(seller.id, patch));
});
// Kinan's own Taobao account (sellers never sign in to Taobao)
r('GET', '/api/admin/taobao', ADMIN, async () => sellerAuth.platformStatus());
r('POST', '/api/admin/taobao/connect', ADMIN, async () => {
  if (!config.appKey) throw httpError(503, 'Add TAOBAO_APP_KEY and TAOBAO_APP_SECRET on the server first');
  return { url: sellerAuth.buildAuthorizeUrl(null, `${config.publicBaseUrl}/admin?taobao=connected`) };
});
r('PUT', '/api/admin/taobao/settings', ADMIN, async ({ req }) => sellerAuth.savePrefs(await readJson(req)));
r('POST', '/api/admin/taobao/disconnect', ADMIN, async () => { sellerAuth.disconnectPlatform(); return sellerAuth.platformStatus(); });
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
r('GET', '/api/admin/ai', ADMIN, async () => require('./services/ai').status());
r('PUT', '/api/admin/ai', ADMIN, async ({ req }) => require('./services/ai').savePrefs(await readJson(req)));
r('POST', '/api/admin/ai/improve', ADMIN, async () => require('./services/ai').improveKinan(40));
r('POST', '/api/admin/ai/undo/:id', ADMIN, async ({ params }) => { require('./services/ai').undo(params.id); return { ok: true }; });
r('POST', '/api/seller/ai/listing', SELLER, async ({ req, seller }) => { throttleLight(req); const b = await readJson(req); return require('./services/ai').assist(seller, { ...b, lang: b.lang || reqLang(req) }); });
r('GET', '/api/seller/products', SELLER, async ({ seller }) => db.listings.all((l) => l.seller_id === seller.id).map((l) => (l.ai_review ? { ...l, ai_review: { ...l.ai_review, before: undefined } } : l)));
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
r('GET', '/api/seller/stats', SELLER, async ({ seller, url }) => ops.sellerStats(seller, Math.min(90, Math.max(7, Number(url.searchParams.get('days')) || 30))));
r('POST', '/api/seller/products/bulk', SELLER, async ({ req, seller }) => ops.bulkUpload(seller, (await readJson(req)).rows));
const sellerOrder = (seller, id) => { const o = db.orders.get(id); if (!o || !o.lines.some((l) => l.seller_id === seller.id) || o.status === 'pending_payment') throw httpError(404, 'Not found'); return o; };
r('GET', '/api/seller/orders/:id/messages', SELLER, async ({ seller, params }) => messages.threadsFor(sellerOrder(seller, params.id), { role: 'seller', seller_id: seller.id }));
r('POST', '/api/seller/orders/:id/messages', SELLER, async ({ req, seller, user, params }) => messages.post(sellerOrder(seller, params.id), { role: 'seller', seller_id: seller.id, user }, await readJson(req)));
r('GET', '/api/seller/orders', SELLER, async ({ seller }) => db.orders.all((o) => o.lines.some((l) => l.seller_id === seller.id) && o.status !== 'pending_payment').sort((a, b) => b.created_at - a.created_at).map((o) => orders.sellerView(o, seller.id)));
const sellerSub = (seller, id) => { const o = db.orders.get(id); const s = o?.sub_orders.find((x) => x.seller_id === seller.id && !x.direct && !x.manual); if (!s) throw httpError(404, 'Not found'); return { o, s }; };
r('POST', '/api/seller/orders/:id/pay', SELLER, async ({ seller, params }) => { if (sellerAuth.platformConnected()) throw httpError(403, 'Kinan pays Taobao for this order'); const { o, s } = sellerSub(seller, params.id); return orders.paySub(o.id, s.outer_purchase_id); });
r('POST', '/api/seller/orders/:id/sync', SELLER, async ({ seller, params }) => { const { o, s } = sellerSub(seller, params.id); await orders.syncSub(o.id, s.outer_purchase_id); return orders.sellerView(db.orders.get(o.id), seller.id); });
r('GET', '/api/seller/earnings', SELLER, async ({ seller }) => {
  const led = db.ledger.all((l) => l.seller_id === seller.id && l.status !== 'void');
  const b = moneySvc.sellerBalance(seller.id);
  return { ...b, payable: b.available, paid: b.withdrawn, entries: led.slice(-100).reverse(), payouts: moneySvc.listPayouts({ sellerId: seller.id }).slice(0, 50), payout_details: seller.payout_details || null };
});
r('GET', '/api/seller/statement.pdf', SELLER, async ({ seller, url, res }) => {
  const f = ops.sellerStatementPdf(seller, { from: url.searchParams.get('from'), to: url.searchParams.get('to') });
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Content-Length': f.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(f.body);
});
r('POST', '/api/seller/payouts', SELLER, async ({ req, seller }) => moneySvc.requestWithdrawal(seller, await readJson(req)));

// Admin
r('GET', '/api/admin/overview', STAFF, async () => admin.overview());
r('GET', '/api/admin/sellers', ADMIN, async () => admin.sellers());
r('GET', '/api/admin/sellers/:id/verification', ADMIN, async ({ params }) => { const sl = db.sellers.get(params.id); if (!sl) throw httpError(404, 'Seller not found'); return require('./services/kyc').adminView(sl); });
r('GET', '/api/admin/sellers/:id/verification/:kind', ADMIN, async ({ params, res }) => {
  const sl = db.sellers.get(params.id); if (!sl || !['id_front', 'id_back', 'selfie'].includes(params.kind)) throw httpError(404, 'Not found');
  const img = require('./services/kyc').photo(sl, params.kind); if (!img) throw httpError(404, 'Photo not found');
  res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(img.body);
});
r('POST', '/api/admin/sellers/:id/verification', ADMIN, async ({ req, params, user }) => require('./services/kyc').decide(params.id, await readJson(req), user.id));
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
// CJdropshipping: catalog, import, settings, wallet
// NextSmartShip (China warehouse + international shipping)
r('GET', '/api/admin/nss', STAFF, async () => require('./services/nss').status());
r('PUT', '/api/admin/nss/settings', ADMIN, async ({ req }) => require('./services/nss').savePrefs(await readJson(req)));
r('POST', '/api/admin/orders/:id/nss', PROC, async ({ req, params, user }) => {
  const n = require('./services/nss'); const b = await readJson(req);
  if (b.action === 'create') await n.createOrder(params.id, { force: Boolean(b.force) });
  else if (b.action === 'options') return n.options(params.id);
  else if (b.action === 'ship') await n.ship(params.id, b, user.id);
  else if (b.action === 'sync') await n.sync(params.id);
  else throw httpError(400, 'Unknown action');
  return orders.decorate(db.orders.get(params.id));
});
// Banggood (direct supplier)
const bgs = require('./services/banggood');
r('GET', '/api/admin/banggood', STAFF, async () => bgs.status());
r('PUT', '/api/admin/banggood/settings', ADMIN, async ({ req }) => bgs.savePrefs(await readJson(req)));
r('POST', '/api/admin/banggood/resync', ADMIN, async () => ({ checked: await bgs.resyncStale(300) }));
r('GET', '/api/banggood/categories', SELLER_OR_STAFF, async () => bgs.categories());
r('GET', '/api/banggood/products', SELLER_OR_STAFF, async ({ url }) => bgs.listProducts({ cat_id: url.searchParams.get('cat_id'), page: url.searchParams.get('page') }));
r('POST', '/api/seller/products/banggood/preview', SELLER, async ({ req, seller }) => bgs.preview(seller, (await readJson(req)).ref));
const pickPublish = (b) => ({ ref: b.ref, prices: b.prices, title: b.title, description: b.description, category: b.category, keywords: b.keywords }); // sellers cannot set other fields
r('POST', '/api/seller/products/banggood', SELLER, async ({ req, seller }) => bgs.publish(seller, pickPublish(await readJson(req))));
r('POST', '/api/admin/banggood/preview', ADMIN, async ({ req }) => bgs.preview(require('./services/buyforme').systemSeller(), (await readJson(req)).ref));
r('POST', '/api/admin/banggood/import', ADMIN, async ({ req }) => bgs.publish(require('./services/buyforme').systemSeller(), await readJson(req)));
r('GET', '/api/admin/banggood/orders', STAFF, async () => db.orders.all((o) => (o.sub_orders || []).some((s) => s.source === 'banggood')).sort((a, b) => b.created_at - a.created_at).slice(0, 200)
  .map((o) => ({ id: o.id, status: o.status, created_at: o.created_at, country: o.shipping_address?.country_code, parts: o.sub_orders.filter((s) => s.source === 'banggood').map((s) => ({ outer_purchase_id: s.outer_purchase_id, sale_record_id: s.sale_record_id || null, purchase_ids: s.purchase_ids, status: s.status, label: bgs.LABEL[s.status] || s.status, bg_status: s.bg_status || null, amount: s.bg_amount || null, error: s.error || null, logistics: s.logistics || [] })) })));
r('GET', '/api/admin/ai-review', STAFF, async () => require('./services/autoreview').status());
r('POST', '/api/admin/ai-review/run', ADMIN, async () => ({ reviewed: await require('./services/autoreview').tick({ max: 10 }) }));
r('POST', '/api/admin/listings/:id/ai-review', ADMIN, async ({ params }) => require('./services/autoreview').reviewListing(params.id, { force: true }).then((l) => ({ id: l.id, ai_review: { ...l.ai_review, before: undefined } })));
r('POST', '/api/admin/listings/:id/ai-undo', ADMIN, async ({ params }) => { const l = require('./services/autoreview').revert(params.id); return { id: l.id, title: l.title }; });
r('GET', '/api/admin/cj', STAFF, async () => cjs.status());
r('PUT', '/api/admin/cj/settings', ADMIN, async ({ req }) => cjs.savePrefs(await readJson(req)));
r('POST', '/api/admin/cj/webhooks', ADMIN, async () => { db.settings.remove('set_cj_webhooks'); return cjs.registerWebhooks(); });
r('POST', '/api/admin/cj/resync', ADMIN, async () => ({ checked: await cjs.resyncStale(300) }));
r('GET', '/api/cj/search', SELLER_OR_STAFF, async ({ url }) => cjs.search({ q: url.searchParams.get('q'), page: url.searchParams.get('page'), category: url.searchParams.get('category'), country: url.searchParams.get('country') }));
r('GET', '/api/cj/categories', SELLER_OR_STAFF, async () => cjs.categories());
r('POST', '/api/seller/products/cj/preview', SELLER, async ({ req, seller }) => cjs.preview(seller, (await readJson(req)).ref));
r('POST', '/api/seller/products/cj', SELLER, async ({ req, seller }) => cjs.publish(seller, pickPublish(await readJson(req))));
r('POST', '/api/admin/cj/preview', ADMIN, async ({ req }) => cjs.preview(require('./services/buyforme').systemSeller(), (await readJson(req)).ref));
r('POST', '/api/admin/cj/import', ADMIN, async ({ req }) => cjs.publish(require('./services/buyforme').systemSeller(), await readJson(req)));
r('GET', '/api/admin/cj/bestsellers', ADMIN, async () => ({ prefs: cjs.autoPrefs(), state: cjs.autoState(), count: db.listings.all((l) => l.cj_auto).length }));
r('PUT', '/api/admin/cj/bestsellers', ADMIN, async ({ req }) => cjs.saveAutoPrefs(await readJson(req)));
r('POST', '/api/admin/cj/bestsellers/run', ADMIN, async ({ req }) => { if (!require('./cj/client').enabled()) throw httpError(503, 'CJdropshipping is not connected'); const b = await readJson(req).catch(() => ({})); cjs.importBestSellers(b.count ? { count: b.count } : {}, 'admin').catch((e) => console.error('[cj] best sellers', e.message)); return { started: true }; });
r('GET', '/api/admin/cj/orders', STAFF, async () => db.orders.all((o) => (o.sub_orders || []).some((s) => s.source === 'cj')).sort((a, b) => b.created_at - a.created_at).slice(0, 200)
  .map((o) => ({ id: o.id, status: o.status, created_at: o.created_at, country: o.shipping_address?.country_code, cj_shipping: o.cj_shipping || null, parts: o.sub_orders.filter((s) => s.source === 'cj').map((s) => ({ outer_purchase_id: s.outer_purchase_id, status: s.status, label: cjs.LABEL[s.status] || s.status, cj_order: s.purchase_ids?.[0] || null, amount: s.cj_amount ?? null, method: s.cj_method || null, sandbox: Boolean(s.sandbox), error: s.error || null, tracking: (s.logistics || [])[0] || null })) })));
r('GET', '/api/admin/aliexpress', STAFF, async () => ({ ...aliexpress.status(), redirect_uri: config.aliexpress.redirectUri }));
r('POST', '/api/admin/aliexpress/connect', ADMIN, async () => ({ url: aliexpress.authorizeUrl() }));
r('POST', '/api/admin/aliexpress/disconnect', ADMIN, async () => aliexpress.disconnect());
r('POST', '/api/admin/orders/:id/qc-resolved', CARE, async ({ req, params }) => {
  const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Not found');
  const b = await readJson(req);
  return orders.decorate(db.orders.update(o.id, (x) => ({ ...x, qc_review: 'resolved', qc_resolution: String(b.note || '').slice(0, 500), timeline: [...x.timeline, { at: Date.now(), event: 'qc_resolved' }] })));
});
r('GET', '/api/admin/orders/:id/qc/:n', STAFF, async ({ params, res }) => sendImage(res, warehouse.qcPhoto(db.orders.get(params.id) || {}, params.n)));
r('GET', '/api/admin/orders/:id/messages', CARE, async ({ params }) => { const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Not found'); return messages.threadsFor(o, { role: 'staff' }); });
r('POST', '/api/admin/orders/:id/messages', CARE, async ({ req, user, params }) => { const o = db.orders.get(params.id); if (!o) throw httpError(404, 'Not found'); const b = await readJson(req); return messages.post(o, { role: 'staff', user }, { thread: 'kinan', text: b.text }); });
r('GET', '/api/admin/backup', ADMIN, async ({ res }) => { const f = ops.backupFile(); res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Content-Length': f.body.length, 'Cache-Control': 'no-store' }); res.end(f.body); });
r('POST', '/api/admin/backup/email', ADMIN, async () => { const k = `backup:${new Date().toISOString().slice(0, 10)}`; for (const m of db.mail.all((x) => x.key === k)) db.mail.remove(m.id); return { ...(await ops.dailyBackup()), to: ops.backupRecipient() }; });
// Seasonal collections (Christmas Shop from CJ's European warehouses)
r('GET', '/api/admin/collections/:id', ADMIN, async ({ params }) => { const sz = require('./services/seasonal'); return { state: sz.state(params.id), rows: sz.rows(params.id) }; });
r('GET', '/api/admin/ebay', ADMIN, async () => require('./services/ebay').status());
r('GET', '/api/admin/ebay/connect', ADMIN, async () => ({ url: require('./ebay/client').authUrl() }));
r('POST', '/api/admin/ebay/code', ADMIN, async ({ req }) => { await require('./ebay/client').pasteCode((await readJson(req)).url); return require('./services/ebay').status(); });
r('POST', '/api/admin/ebay/disconnect', ADMIN, async () => { require('./ebay/client').disconnect(); return require('./services/ebay').status(); });
r('PUT', '/api/admin/ebay', ADMIN, async ({ req }) => { require('./services/ebay').savePrefs(await readJson(req)); return require('./services/ebay').status(); });
r('POST', '/api/admin/ebay/setup', ADMIN, async () => require('./services/ebay').policies().catch((e) => { console.warn('[ebay] setup', e.message); throw e; }));
r('POST', '/api/admin/ebay/list', ADMIN, async ({ req }) => { const e = require('./services/ebay'); const b = await readJson(req); if (b.listing_id) return e.listOne(String(b.listing_id)); if (e._running()) throw httpError(409, 'eBay listing is already running'); require('./cj/client').background(() => e.listMany({ collection: b.collection ? String(b.collection) : undefined, ids: Array.isArray(b.ids) ? b.ids.map(String) : undefined, limit: b.limit }, 'admin')).catch((x) => console.warn('[ebay]', x.message)); return { started: true }; });
r('POST', '/api/admin/ebay/end/:id', ADMIN, async ({ params }) => require('./services/ebay').endOne(params.id));
r('POST', '/api/admin/ebay/sync', ADMIN, async () => { const e = require('./services/ebay'); const orders = await e.importOrders(); const tracking = await e.pushTracking(); const stock = await e.sync(); return { orders, tracking, stock }; });
r('POST', '/api/admin/collections/:id/import', ADMIN, async ({ req, params }) => { const sz = require('./services/seasonal'); const b = await readJson(req); if (!sz.COLLECTIONS[params.id]) throw httpError(404, 'Unknown collection'); require('./cj/client').background(() => sz.importCollection(params.id, b, 'admin')).catch((e) => console.warn('[xmas]', e.message)); return { started: true, state: sz.state(params.id) }; });
r('POST', '/api/admin/collections/:id/polish', ADMIN, async ({ params }) => ({ rewritten: await require('./services/seasonal').polish(params.id) }));
r('GET', '/api/admin/collections/:id/export.csv', ADMIN, async ({ params, res }) => {
  const body = require('./services/seasonal').csv(params.id);
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="kinan-${params.id}-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
  res.end(body);
});
r('GET', '/api/admin/coupons', ADMIN, async () => db.coupons.all().sort((a, b) => b.created_at - a.created_at).map(({ used_by, ...c }) => c));
r('POST', '/api/admin/coupons', ADMIN, async ({ req }) => growth.saveCoupon(await readJson(req)));
r('PATCH', '/api/admin/coupons/:id', ADMIN, async ({ req, params }) => { const c = db.coupons.get(params.id); if (!c) throw httpError(404, 'Not found'); const b = await readJson(req); return Object.keys(b).length === 1 && 'active' in b ? db.coupons.update(c.id, { active: Boolean(b.active) }) : growth.saveCoupon({ ...c, ...b }, c.id); });
r('GET', '/api/admin/reviews', CARE, async () => db.reviews.all().sort((a, b) => b.created_at - a.created_at).slice(0, 200).map((x) => ({ ...growth.publicReview(x), status: x.status, listing_id: x.listing_id, title: db.listings.get(x.listing_id)?.title || '' })));
r('PATCH', '/api/admin/reviews/:id', CARE, async ({ req, params }) => { const x = db.reviews.get(params.id); if (!x) throw httpError(404, 'Not found'); const b = await readJson(req); growth.resetRatings(); return db.reviews.update(x.id, { status: b.status === 'hidden' ? 'hidden' : 'published' }); });
r('POST', '/api/admin/orders/:id/cancel', FIN, async ({ params, user }) => orders.decorate(await orders.cancelOrder(params.id, user.id)));
r('GET', '/api/admin/staff-roles', ADMIN, async () => auth.STAFF_ROLES);
r('GET', '/api/admin/users', PEOPLE, async () => admin.users().map((u) => (u.role === 'buyer' ? { ...u, wallet: shopSvc.walletOf(u.id).balance } : u)));
r('POST', '/api/admin/users/:id/reset-link', ['admin', 'support'], async ({ params, user }) => {
  const u = db.users.get(params.id); if (!u) throw httpError(404, 'User not found');
  if (user.role !== 'admin' && !['buyer', 'seller'].includes(u.role)) throw httpError(403, 'Only an admin can reset a staff password');
  return { url: resetUrl(auth.createResetToken(u)), expires_in_minutes: 60 };
});
r('GET', '/api/admin/mail', ADMIN, async () => ({ enabled: mailer.enabled(), sender: mailer.sender().email, reply_to: config.mail.replyTo || null, domain: mailer.domainStatus(), recent: db.mail.all().slice(-50).reverse() }));
// Email the admin a sample of the PDF invoice customers get after paying (the latest paid order, or example items)
r('POST', '/api/admin/invoice/sample', ADMIN, async ({ user }) => {
  const last = db.orders.all((o) => o.paid_at).sort((a, b) => b.paid_at - a.paid_at)[0];
  const sample = last || { id: `ord_${require('crypto').randomBytes(8).toString('hex')}`, buyer_id: user.id, created_at: Date.now(), paid_at: Date.now(), currency: config.currency, charge: { currency: 'eur', rate: fx.chargeRate('EUR') || 0.92, total: 0 },
    shipping_address: { name: user.name || 'Kinan customer', line1: 'Triq il-Kbira 10', city: 'Valletta', postal_code: 'VLT 1000', country: 'Malta', phone: '+356 7900 0000' },
    lines: [{ title: 'Waterproof Fleece-Lined Hiking Jacket', props: 'Color: Black · Size: XL', qty: 1, price: 45.5 }, { title: 'Insulated Water Bottle 750 ml', props: 'Color: Sage green', qty: 2, price: 12 }],
    subtotal: 69.5, shipping_fee: 8.5, discount: 6.95, coupon_code: 'WELCOME10', total: 71.05, payment: { provider: 'demo' } };
  const f = ops.invoicePdf(sample);
  const rec = await mailer.send({ to: user.email, kind: 'test', subject: `Sample invoice ${ops.invoiceNo(sample)}`, title: 'This is the invoice your customers receive',
    lines: [last ? `Attached: the invoice of your latest paid order (${last.id.slice(-8).toUpperCase()}), exactly as the customer received it.` : 'Attached: a sample invoice with example items (no real order yet).', 'Customers get it automatically with their order confirmation after paying, and can download it from their order.'],
    ar: { subject: `نموذج فاتورة ${ops.invoiceNo(sample)}`, title: 'هذه الفاتورة التي يستلمها زبائنك', lines: [last ? `مرفقة: فاتورة آخر طلب مدفوع (${last.id.slice(-8).toUpperCase()}) كما وصلت للزبون.` : 'مرفقة: فاتورة تجريبية بمنتجات مثال (لا يوجد طلب حقيقي بعد).', 'يستلمها الزبون تلقائياً مع تأكيد الطلب بعد الدفع، ويمكنه تحميلها من صفحة طلبه.'] },
    attachments: [{ name: f.name, content: f.body.toString('base64') }] });
  return { status: rec?.status, to: user.email, error: rec?.error || null, from_order: Boolean(last) };
});
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
r('GET', '/api/admin/settings/shipping', STAFF, async () => ({ ...shipping.settings(), fx: fx.status(), zones: shipping.ZONES.map(([id, name, countries]) => ({ id, name, countries })) }));
r('POST', '/api/admin/fx/refresh', ADMIN, async () => { await fx.refresh({ force: true }); return fx.status(); });
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
  const s = warehouse.ship(o.id, { carrier: out.carrier, tracking: out.tracking, weight_g: b.weight_g, cost: out.cost, label: out.label, with: b.with }, user);
  return { ...s, label: s.label ? { type: s.label.type } : null };
});
r('GET', '/api/warehouse/shipments/:id/label', WH, async ({ params, res }) => {
  const s = db.shipments.get(params.id); if (!s?.label) throw httpError(404, 'No label for this shipment');
  if (s.label.type === 'url') { res.writeHead(302, { Location: s.label.url }); return res.end(); }
  const pdf = Buffer.from(s.label.data, 'base64');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="label-${s.tracking}.pdf"`, 'Content-Length': pdf.length, 'Cache-Control': 'no-store' });
  res.end(pdf);
});
r('POST', '/api/warehouse/orders/:id/qc-photos', WH, async ({ req, params, user }) => warehouse.addQcPhotos(params.id, (await readJson(req)).images, user));
r('GET', '/api/warehouse/orders/:id/qc/:n', WH, async ({ params, res }) => sendImage(res, warehouse.qcPhoto(db.orders.get(params.id) || {}, params.n)));
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
      if (p === '/' || p === '/shop') return page(res, 'shop.html', { stripe: true, head: seo.siteJsonLd() + `<link rel="canonical" href="${attr(config.publicBaseUrl)}/">`, body: seo.ssrList({ title: 'Kinan Shop — delivered to your door', intro: 'Shop home and kitchen, fashion, electronics, beauty, toys and gifts from independent sellers and Kinan. Delivered to Europe, the UK and worldwide with tracking.', limit: 60 }) });
      const catPage = p.match(/^\/c\/([a-z_]{2,20})$/);
      if (catPage) {
        const cat = shipping.CATEGORIES.find(([id]) => id === catPage[1]);
        if (cat) return page(res, 'shop.html', { stripe: true, title: `${cat[1]} — Kinan Shop`, body: seo.ssrList({ title: cat[1], intro: `${cat[1]} delivered to your door with tracking — ${cat[2]}.`, category: cat[0] }), head: seo.listJsonLd(cat[1], seo.liveProducts().filter(({ l }) => (l.category || 'other') === cat[0]), `/c/${cat[0]}`) + shareHead({ title: `${cat[1]} — Kinan Shop`, description: `Shop ${cat[1].toLowerCase()} on Kinan, delivered with tracking.`, url: `/c/${cat[0]}`, hash: `#/c/${cat[0]}` }) });
      }
      if (p === '/llms.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }); return res.end(seo.llmsTxt()); }
      if (p === '/feeds/openai.jsonl') { res.writeHead(200, { 'Content-Type': 'application/jsonl; charset=utf-8', 'Cache-Control': 'public, max-age=1800' }); return res.end(seo.openaiFeed()); }
      if (p === `/${seo.indexNowKey()}.txt`) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(seo.indexNowKey()); }
      const inv = p.match(/^\/invoice\/(ord_[a-f0-9]{8,40})(\.pdf)?$/);
      if (inv) {
        let user = null; try { user = auth.authenticate(req); } catch { user = null; }
        const o = db.orders.get(inv[1]);
        if (!user) { res.writeHead(302, { Location: `/#/orders/${inv[1]}` }); return res.end(); }
        if (!o || !(o.buyer_id === user.id || (auth.STAFF_ROLES || {})[user.role] || user.role === 'admin') || o.status === 'pending_payment') return send(res, 404, 'Invoice not found');
        if (inv[2]) { const f = ops.invoicePdf(o); res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${f.name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(f.body); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
        return res.end(ops.invoiceHtml(o));
      }
      const sh = p.match(/^\/(p|s)\/([\w-]{1,80})$/);
      if (sh) return sharePage(res, sh[1], sh[2]);
      if (p === '/christmas' || p === '/xmas') return page(res, 'shop.html', { stripe: true, title: 'Christmas Shop — decorations, lights & gifts | Kinan', body: seo.ssrList({ title: 'Kinan Christmas Shop', intro: 'Christmas decorations, fairy lights, Christmas jumpers, gifts and baking tools — shipped from European warehouses so they arrive before Christmas. Code XMAS10 gives 10% off.', collection: 'christmas' }), head: seo.listJsonLd('Kinan Christmas Shop', seo.liveProducts().filter(({ l }) => (l.collections || []).includes('christmas')), '/christmas') + shareHead({ title: 'Kinan Christmas Shop 🎄 — decorations, lights & gifts', description: 'Christmas decorations, lights, jumpers and gifts — shipped from European warehouses so they arrive before Christmas. Use code XMAS10 for 10% off.', image: '/assets/xmas-og.png', url: '/christmas', hash: '#/x/christmas' }) });
      if (p === '/seller') return page(res, 'seller.html');
      if (p === '/admin') return page(res, 'admin.html');
      if (p === '/warehouse') return page(res, 'warehouse.html');
      if (p === '/download' || p === '/apps') return page(res, 'download.html');
      if (p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }); return res.end(seo.robots()); }
      if (p === '/sitemap.xml') { res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=1800' }); return res.end(seo.sitemap()); }
      if (p === '/feeds/google.xml') { res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=1800' }); return res.end(seo.merchantFeed()); }
      if (p === '/reset') return page(res, 'reset.html');
      if (legal.PAGES[p]) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'none'; base-uri 'none'; form-action 'none'" });
        return res.end(legal.render(p));
      }
      const im = p.match(/^\/img\/(l|s|r)\/([\w-]{1,80})(?:\/(\d{1,2}))?$/);
      if (im) {
        const img = im[1] === 'r' ? growth.reviewPhoto(im[2], im[3]) : catalog.imageData(im[1], im[2], im[3]);
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
    if (p === '/webhooks/cj') {
      if (req.method !== 'POST') return send(res, 200, { ok: true });
      const raw = await readRaw(req);
      // CJ checks the address with an unsigned test call when webhooks are registered: answer 200 but only act on signed messages
      if (!cjs.verify(raw, req.headers.sign)) { if (req.headers.sign) console.warn('[cj] webhook with a bad signature — ignored'); return send(res, 200, { ok: true }); }
      send(res, 200, { ok: true }); // CJ wants an answer within 3 seconds: work after replying
      setImmediate(() => { try { const m = JSON.parse(raw.toString('utf8')); const out = cjs.handleWebhook(m); if (!out.ignored) console.log('[cj] webhook', m.type, JSON.stringify(out)); } catch (e) { console.error('[cj] webhook', e.message); } });
      return;
    }
    if (p === '/webhooks/ebay/deletion') {
      // eBay's marketplace account deletion notices: Kinan keeps no eBay member data beyond order addresses
      const code = url.searchParams.get('challenge_code');
      if (req.method === 'GET' && code) return send(res, 200, { challengeResponse: require('./ebay/client').challenge(code, `${config.publicBaseUrl}/webhooks/ebay/deletion`) });
      if (req.method === 'POST') await readRaw(req).catch(() => null);
      return send(res, 200, { ok: true });
    }
    if (p === '/webhooks/nss') {
      if (req.method !== 'POST') return send(res, 200, { ok: true });
      const raw = await readRaw(req); const n = require('./services/nss');
      if (!n.verify(raw, req.headers['x-nss-signature'])) { if (req.headers['x-nss-signature']) console.warn('[nss] webhook with a bad signature — ignored'); return send(res, 200, { ok: true }); }
      send(res, 200, { ok: true });
      setImmediate(() => { try { n.onWebhook(JSON.parse(raw)).catch((e) => console.error('[nss] webhook', e.message)); } catch (e) { console.error('[nss] webhook', e.message); } });
      return;
    }
    if (p === '/webhooks/stripe' && req.method === 'POST') {
      const out = await webhooks.stripeHook(await readRaw(req), req.headers);
      return send(res, out.status, out.body);
    }
    if (p === '/auth/google' && req.method === 'GET') {
      const app = ['seller', 'admin'].includes(url.searchParams.get('app')) ? url.searchParams.get('app') : 'shop';
      try { res.writeHead(302, { Location: google.authorizeUrl(app, url.searchParams.get('next'), url.searchParams.get('lang') || reqLang(req)), 'Cache-Control': 'no-store' }); }
      catch (e) { res.writeHead(302, { Location: `${app === 'shop' ? '/' : `/${app}`}?login_error=${encodeURIComponent(e.message)}` }); }
      return res.end();
    }
    if (p === '/auth/google/callback' && req.method === 'GET') {
      throttle(clientIp(req));
      try {
        const out = await google.callback({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') });
        if (out.token) setSession(res, out.token, out.role);
        res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store' });
      } catch (e) {
        recordFailure(clientIp(req));
        if ((e.status || 500) >= 500) console.error('[google]', e.message);
        res.writeHead(302, { Location: `${e.home || '/'}?login_error=${encodeURIComponent(e.message)}` });
      }
      return res.end();
    }
    if (p === '/oauth/ebay/callback' && req.method === 'GET') {
      const q = url.searchParams;
      console.log(`[ebay] sign-in returned (${req.method}, keys: ${[...q.keys()].join(',') || 'none'}, ref: ${String(req.headers.referer || '').split('?')[0]}): code ${q.get('code') ? 'yes' : 'no'}, state ${q.get('state') ? 'yes' : 'no'}${q.get('error') ? `, error ${q.get('error')}: ${q.get('error_description') || ''}` : ''}`);
      try { await require('./ebay/client').handleCallback(q.get('code'), q.get('state')); console.log('[ebay] connected'); res.writeHead(302, { Location: '/admin?ebay=connected#ebay' }); }
      catch (e) { console.warn('[ebay] connect failed:', e.message); require('./services/ebay').noteError?.(e.message); res.writeHead(302, { Location: `/admin?login_error=${encodeURIComponent(q.get('error_description') || e.message)}#ebay` }); }
      return res.end();
    }
    if (p === '/oauth/aliexpress/callback' && req.method === 'GET') {
      try { await aliexpress.handleCallback(url.searchParams.get('code'), url.searchParams.get('state')); res.writeHead(302, { Location: '/admin?aliexpress=connected' }); }
      catch (e) { res.writeHead(302, { Location: `/admin?login_error=${encodeURIComponent(e.message)}` }); }
      return res.end();
    }
    if (p === '/oauth/callback') {
      try {
        const { return_to, platform } = await sellerAuth.handleCallback(url.searchParams.get('code'), url.searchParams.get('state'));
        if (platform) { res.writeHead(302, { Location: safeReturnTo(return_to) || '/admin?taobao=connected' }); return res.end(); }
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
      // Remember each person's app language so emails and notifications reach them in it
      const hl = req.headers['x-kinan-lang'];
      if (hl === 'ar' || hl === 'en') { const lu = auth.authenticate(req); const rec = lu && db.users.get(lu.id); if (rec && rec.lang !== hl) db.users.update(rec.id, { lang: hl }); }
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
    if (status >= 500) { console.error('[error]', req.method, p, e.code || '', e.message); errorAlert(`${req.method} ${p}: ${e.message}`); }
    const TB_MSG = { SETTLE_NOT_FINISH: 'Your Taobao (TaoWorld) distributor account has not finished onboarding yet. Complete the registration at distributor.taobao.global, then try again.' };
    send(res, status, { error: TB_MSG[e.code] || e.message || 'Error', code: e.code, request_id: e.requestId });
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
  // Scheduled jobs are background work: their CJ calls wait behind anything a person is doing
  const every = (ms, fn) => setInterval(() => Promise.resolve(require('./cj/client').background(fn)).catch(() => {}), ms).unref();
  every(30e3, webhooks.processInbox);
  every(config.orderSyncMinutes * 60e3, orders.syncOpen);
  every(3600e3, catalog.resyncStale);
  every(6 * 3600e3, sellerAuth.refreshAllDue);
  every(3600e3, async () => cleanup());
  every(3600e3, async () => warehouse.releaseExpired());
  every(3600e3, async () => { growth.payReferrals(); growth.wishlistAlerts(); growth.cartReminders(); });
  every(3600e3, async () => { if (new Date().getUTCHours() === 2) await ops.dailyBackup(); });
  every(10 * 60e3, () => require('./services/translate').translatePending());
  every(60e3, () => require('./services/autoreview').tick());
  every(15 * 60e3, () => require('./services/ebay').tick()); // eBay: orders in, tracking out, hourly price/stock // AI review of new and changed products
  every(3600e3, async () => { if (new Date().getUTCHours() === 3) await cjs.resyncStale(300); });
  every(3600e3, async () => { const b = require('./services/banggood'); await b.updateTick(); const h = new Date().getUTCHours(); if (h === 4) await b.resyncStale(300); if (h === 5) await b.refreshLimits(); });
  every(3600e3, () => require('./cj/client').background(() => cjs.autoTick()));
  every(30 * 60e3, () => require('./services/nss').tick());
  every(3600e3, async () => { const sz = require('./services/seasonal'); sz.autoStart(); await sz.polish('christmas', 40); }); // also resumes an import CJ's limits paused
  every(3600e3, () => require('./services/ai').tick());
  every(3 * 3600e3, () => seo.indexNowTick().catch((e) => console.warn('[seo] IndexNow:', e.message)));
  setTimeout(() => seo.indexNowTick().catch((e) => console.warn('[seo] IndexNow:', e.message)), 5 * 60e3).unref();
  setTimeout(() => require('./cj/client').background(() => cjs.autoTick()).catch((e) => console.warn('[cj] best sellers:', e.message)), 90e3).unref();
  setTimeout(() => require('./services/translate').translatePending().catch(() => {}), 30e3).unref();
}

if (require.main === module) (async () => {
  try { await db.init(); } catch (e) { console.error('[db] could not connect to PostgreSQL:', e.message); process.exit(1); }
  auth.bootstrapAdmin();
  try { auth.secureOwnerAccounts(); } catch (e) { console.error('[auth] securing owner accounts:', e.message); }
  fx.apply();
  growth.ensureWelcome();
  const problems = configProblems();
  if (problems.length) console.warn('[config]', problems.join(' | '));
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Kinan on :${config.port}  store: /  seller: /seller  admin: /admin  warehouse: /warehouse`);
    console.log(`OAuth callback: ${config.redirectUri}`);
  });
  startJobs();
  try { require('./services/kyc').enforce(); } catch (e) { console.error('[kyc]', e.message); }
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
  // Exchange rates: now, then every 6 hours (refreshes when older than 20 hours)
  fx.refresh().catch((e) => console.warn('[fx]', e.message));
  setInterval(() => fx.refresh().catch((e) => console.warn('[fx]', e.message)), 6 * 3600e3).unref();
  require('./services/uptime').setup().then((r) => { if (r.ok) console.log(`[uptime] monitoring on (${r.created ? 'new monitor' : 'monitor already there'})`); }).catch((e) => console.warn('[uptime]', e.message));
  try { sellerAuth.adoptOwnerToken(); } catch (e) { console.warn('[taobao] adopt:', e.message); }
  // Christmas Shop: the XMAS10 coupon, and the CJ import once after deploy (after the CJ webhooks/options work)
  // eBay: say which keys are set (names only, never values) and whether eBay accepts them
  { const near = Object.keys(process.env).filter((k) => /ebay/i.test(k));
    if (near.length) {
      console.log(`[ebay] keys found: ${near.map((k) => JSON.stringify(k)).join(', ')} · missing: ${['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME'].filter((k) => !String(process.env[k] || '').trim()).join(', ') || 'none'}`);
      if (require('./ebay/client').configured()) require('./ebay/client').checkKeys().then((r) => console.log(`[ebay] ${r}`)).catch((e) => console.warn(`[ebay] key check: ${e.message}`));
    } }
  try { require('./services/seasonal').ensureCoupon(); } catch (e) { console.warn('[xmas] coupon:', e.message); }
  setTimeout(() => { try { if (require('./services/seasonal').autoStart()) console.log('[xmas] Christmas Shop import queued'); } catch (e) { console.warn('[xmas]', e.message); } }, 20e3).unref();
  // Banggood: sign in once at start so the logs show whether the keys and the server IP are accepted
  if (require('./banggood/client').enabled()) require('./banggood/client').token({ force: true }).then(() => console.log('[banggood] connected — keys and server IP accepted')).catch((e) => console.warn('[banggood] not connected:', e.message));
  if (require('./cj/client').enabled()) require('./cj/client').background(async () => { await cjs.registerWebhooks().catch((e) => console.warn('[cj] webhooks:', e.message)); await cjs.upgradeOptions().catch((e) => console.warn('[cj] options:', e.message)); });
  if (config.appKey) require('./taobao/check').check().then((r) => console.log(`[taobao] app ${config.appKey}: ${r.ok ? 'connected' : 'NOT accepted'} — ${r.message}`)).catch((e) => console.warn('[taobao] check failed:', e.message));
  if (require('./nss/client').enabled()) require('./nss/client').check().then((r) => { console.log(`[nss] NextSmartShip ${process.env.NSS_CUSTOMER_CODE || ''}: ${r.ok ? 'connected' : 'NOT connected'} — ${r.message}`); if (r.ok) require('./services/nss').registerWebhook().catch((e) => console.warn('[nss] webhook:', e.message)); });
  stripe.setup().then((r) => { if (r.ok) console.log(`[stripe] ready (${r.mode} mode)`); }).catch((e) => console.error('[stripe] setup failed:', e.message));
  // Render stops the instance with SIGTERM: write pending changes first
  const stop = async () => { try { await db.close(); } catch { /* exiting */ } process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})();

module.exports = { server, safeReturnTo, cleanup, clientIp };

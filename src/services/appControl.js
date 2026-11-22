// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Control centre switches the owner flips from the admin dashboard:
   - shop / seller: 'open' or 'maintenance' (the app shows a maintenance page; its API answers 503)
   - checkout: false pauses new orders and payments while the shop stays browsable
   - signups: false pauses new accounts
   Never paused: the admin dashboard, the warehouse, sign-in, webhooks (Stripe, Taobao, CJ, eBay, NSS),
   OAuth callbacks, health checks, assets and legal pages. Signed-in staff see the apps as normal so they
   can check them before reopening. */
'use strict';
const db = require('../db');
const { httpError } = require('../auth');

const ID = 'app_control';
const DEFAULTS = { shop: 'open', seller: 'open', checkout: true, signups: true, message_en: '', message_ar: '', until: null };
const STAFF = ['admin', 'procurement', 'finance', 'support', 'warehouse'];
let cache = null; let cacheAt = 0;

function get() {
  if (!cache || Date.now() - cacheAt > 2000) { cache = { ...DEFAULTS, ...(db.settings.get(ID) || {}) }; cacheAt = Date.now(); }
  return cache;
}

function set(patch = {}, by) {
  const cur = get(); const next = {};
  for (const k of ['shop', 'seller']) if (patch[k] !== undefined) { if (!['open', 'maintenance'].includes(patch[k])) throw httpError(400, `${k} must be open or maintenance`); next[k] = patch[k]; }
  for (const k of ['checkout', 'signups']) if (patch[k] !== undefined) next[k] = patch[k] === true || patch[k] === 'true';
  for (const k of ['message_en', 'message_ar']) if (patch[k] !== undefined) next[k] = String(patch[k] || '').slice(0, 400);
  if (patch.until !== undefined) {
    const t = patch.until ? new Date(patch.until).getTime() : null;
    if (patch.until && !(t > 0)) throw httpError(400, 'Choose a valid date and time');
    next.until = t;
  }
  const doc = { ...cur, ...next, updated_by: by?.email || by?.id || null, updated_at: Date.now() };
  delete doc.id;
  if (db.settings.get(ID)) db.settings.update(ID, doc); else db.settings.insert({ id: ID, ...doc });
  cache = null;
  if (typeof db.flush === 'function') db.flush().catch(() => {}); // a restart right after must not lose the switch
  if (next.shop || next.seller || next.checkout !== undefined) console.log('[control]', JSON.stringify({ shop: doc.shop, seller: doc.seller, checkout: doc.checkout, signups: doc.signups, by: doc.updated_by }));
  return status();
}

/** Public view (no names): what the apps need to show a banner or a maintenance screen. */
function status() {
  const c = get();
  return { shop: c.shop, seller: c.seller, checkout: c.checkout, signups: c.signups, message_en: c.message_en, message_ar: c.message_ar, until: c.until, updated_at: c.updated_at || null };
}

// Paths that always work, whatever the switches say.
const ALWAYS = [/^\/healthz$/, /^\/admin(\/|$)/, /^\/warehouse(\/|$)/, /^\/api\/admin\//, /^\/api\/warehouse\//, /^\/api\/auth\//, /^\/api\/staff\//,
  /^\/webhooks\//, /^\/oauth\//, /^\/api\/oauth\//, /^\/auth\//, /^\/assets\//, /^\/sw\.js$/, /^\/favicon\.ico$/, /^\/apple-touch-icon\.png$/, /^\/robots\.txt$/,
  /^\/api\/partner\//, /^\/api\/app-status$/, /^\/api\/config\/public$/, /^\/api\/me$/, /^\/api\/push\//, /^\/api\/presence$/, /^\/brand\//, /^\/img\//, /^\/feeds\//, /^\/sitemap\.xml$/, /^\/llms\.txt$/, /^\/reset$/, /^\/(terms|privacy|legal|imprint|seller-terms|cookies|returns-policy|shipping-policy)(\/|$)/, /^\/legal\//];
const isSeller = (p) => /^\/seller(\/|$)/.test(p) || /^\/api\/(seller|cj|banggood)(\/|$)/.test(p);
const PAY = [/^\/api\/buyer\/checkout$/, /^\/api\/buyer\/orders\/[^/]+\/(demo-pay|card-payment|pay-wallet|pay-shipping-due)$/];

/**
 * Decide whether a request is held back. `who` is called lazily and returns the signed-in user or null.
 * Returns null (let it through) or { status, kind, api } describing the refusal.
 */
function gate(method, p, who) {
  const c = get();
  if (c.signups === false && method === 'POST' && p === '/api/auth/register') {
    const u = who(); if (u && STAFF.includes(u.role)) return null;
    return { status: 503, kind: 'signups', app: 'shop', api: true };
  }
  if (ALWAYS.some((re) => re.test(p))) return null;
  const app = isSeller(p) ? 'seller' : 'shop';
  const down = c[app] === 'maintenance';
  const payStop = !down && app === 'shop' && c.checkout === false && method === 'POST' && PAY.some((re) => re.test(p));
  if (!down && !payStop) return null;
  const u = who();
  if (u && STAFF.includes(u.role)) return null; // staff check the apps before reopening
  const api = p.startsWith('/api/');
  if (down) return { status: 503, kind: 'maintenance', app, api };
  return { status: 503, kind: 'checkout', app, api };
}

const MSG = {
  maintenance: 'Kinan is being updated. Please come back soon.',
  checkout: 'New orders are paused for a short while. Your bag is saved — please try again soon.',
  signups: 'New accounts are paused for a short while. Please try again soon.'
};
function refusal(g) {
  const c = get();
  return { error: (g.kind === 'maintenance' && c.message_en) || MSG[g.kind], error_ar: g.kind === 'maintenance' ? c.message_ar || null : null, maintenance: g.kind === 'maintenance', paused: g.kind, until: c.until || null };
}

/** The page people see while an app is in maintenance (no scripts, works without the app's code). */
function page(app) {
  const c = get();
  const esc = (s) => String(s).replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
  const until = c.until ? new Date(c.until) : null;
  const when = until ? until.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
  const seller = app === 'seller';
  const color = seller ? '#4b319b' : '#036747';
  const logo = seller ? '/assets/logo-seller.png' : '/assets/logo-main.png';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${seller ? 'KINAN Seller' : 'KINAN.shop'} — back soon</title><link rel="icon" href="/assets/favicon${seller ? '-seller' : ''}-48.png" type="image/png"><link rel="stylesheet" href="/assets/fonts.css">
<meta http-equiv="refresh" content="120">
<style>:root{--c:${color}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#f5f7f4;color:#172923;font:16px/1.55 "Instrument Sans","IBM Plex Sans Arabic",system-ui,sans-serif}
main{max-width:520px;width:100%;background:#fff;border-radius:20px;padding:32px 24px;text-align:center;box-shadow:0 2px 18px rgba(23,41,35,.08);border-top:6px solid var(--c)}
img{width:72px;height:72px}h1{font:800 26px/1.2 "Bricolage Grotesque","IBM Plex Sans Arabic",sans-serif;margin:14px 0 6px}p{margin:6px 0;color:#55655e}.ar{direction:rtl;font-family:"IBM Plex Sans Arabic",sans-serif}
.when{display:inline-block;margin-top:12px;padding:6px 14px;border-radius:99px;background:#fff4cc;color:#6b4d00;font-weight:600;font-size:14px}hr{border:0;border-top:1px solid #e3e9e4;margin:20px 0}
a{color:var(--c)}</style></head><body><main>
<img src="${logo}" alt="KINAN" width="72" height="72">
<h1>We’ll be right back</h1><p>${esc(c.message_en || MSG.maintenance)}</p>
<hr><div class="ar" lang="ar"><h1>سنعود قريباً</h1><p>${esc(c.message_ar || 'نقوم بتحديث كنان الآن. يُرجى العودة بعد قليل.')}</p></div>
${when ? `<span class="when">Expected back · الموعد المتوقع: <bdi dir="ltr">${esc(when)}</bdi></span>` : ''}
${seller ? '' : '<p style="margin-top:16px;font-size:14px">Your orders and payments are safe and keep moving. · طلباتك ومدفوعاتك بأمان وتستمر في المعالجة.</p>'}
</main></body></html>`;
}

module.exports = { get, set, status, gate, refusal, page, DEFAULTS, _reset: () => { cache = null; } };

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Public endpoints Shopify calls (no KINAN session):
 *   GET  /api/partner/connect/shopify/callback   OAuth redirect after the merchant approves the app
 *   POST /api/partner/connect/shopify/webhooks   orders/paid, orders/cancelled, app/uninstalled and the mandatory
 *                                                compliance topics (customers/data_request, customers/redact, shop/redact)
 * Webhooks are verified with X-Shopify-Hmac-Sha256 (Base64 HMAC-SHA256 of the raw body with the app secret) before
 * anything is parsed; an invalid signature answers 401. */
'use strict';
const BASE = '/api/partner/connect/shopify';
const MAX = 1024 * 1024;

function page(res, status, title, text) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f4f7f5;color:#172923;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{background:#fff;border-radius:16px;padding:28px;max-width:440px;box-shadow:0 2px 12px #0001}h1{font-size:20px;margin:0 0 8px;color:#036747}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`);
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function raw(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const c = [];
    req.on('data', (d) => { n += d.length; if (n > MAX) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else c.push(d); });
    req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject);
  });
}

async function handle(req, res, p, url) {
  if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
  const S = require('./shopify'); const pgm = require('../pg');
  const on = pgm.enabled() && S.enabled();
  try {
    if (p === `${BASE}/callback` && req.method === 'GET') {
      if (!on) { page(res, 503, 'Not available yet', 'The KINAN Shopify connection is not switched on yet.'); return true; }
      try {
        const c = await S.callback(Object.fromEntries(url.searchParams));
        page(res, 200, 'KINAN is connected', `${c.shop_domain} is now linked to KINAN. Products arrive as drafts in your Shopify admin; review and publish them when you are ready. You can close this window.`);
      } catch (e) { page(res, e.status && e.status < 500 ? e.status : 502, 'Connection failed', e.message || 'Please start the installation again.'); }
      return true;
    }
    if (p === `${BASE}/webhooks` && req.method === 'POST') {
      const body = await raw(req);
      if (!S.validWebhook(body, req.headers['x-shopify-hmac-sha256'])) { json(res, 401, { error: 'invalid signature' }); return true; }
      if (!on) { json(res, 200, { ok: true, result: 'connector_off' }); return true; }
      const shop = String(req.headers['x-shopify-shop-domain'] || '').toLowerCase();
      if (!require('./shopify-client').validShop(shop)) { json(res, 400, { error: 'invalid shop' }); return true; }
      let parsed; try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { json(res, 400, { error: 'invalid json' }); return true; }
      const result = await S.onWebhook({ topic: String(req.headers['x-shopify-topic'] || ''), shop, webhookId: req.headers['x-shopify-webhook-id'] || req.headers['x-shopify-event-id'] || null, body: parsed });
      json(res, 200, { ok: true, result }); return true;
    }
    json(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, { error: 'not found' });
  } catch (e) {
    console.error('[shopify]', p, e.message);
    json(res, e.status === 413 ? 413 : 500, { error: 'internal' }); // Shopify retries 5xx
  }
  return true;
}

module.exports = { handle, BASE };

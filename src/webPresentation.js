// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const fs = require('fs');
const path = require('path');
const seo = require('./seo');
const PUBLIC = path.join(__dirname, '..', 'public');

const zlib = require('zlib');
/** Send text compressed (brotli or gzip, whichever the browser accepts) when it is worth it — pages and lists shrink ~8×. */
function endCompressed(res, status, headers, text) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  const ae = String(res.req?.headers?.['accept-encoding'] || '');
  const h = { ...headers, Vary: 'Accept-Encoding' };
  if (buf.length < 1024 || res.req?.method === 'HEAD') { res.writeHead(status, h); return res.end(buf); }
  if (/\bbr\b/.test(ae)) { res.writeHead(status, { ...h, 'Content-Encoding': 'br' }); return res.end(zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })); }
  if (/\bgzip\b/.test(ae)) { res.writeHead(status, { ...h, 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(buf, { level: 6 })); }
  res.writeHead(status, h); return res.end(buf);
}
function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  endCompressed(res, status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers }, json ? JSON.stringify(body) : body);
}
const attr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf' };
function asset(res, rel, cache = 'public, max-age=3600') {
  const name = path.basename(rel);
  const type = MIME[path.extname(name)];
  const file = path.join(PUBLIC, 'assets', name);
  if (name !== rel || !type || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
  // versioned files (…?v=hash) never change: browsers keep them a year
  if (/[?&]v=/.test(res.req?.url || '')) cache = 'public, max-age=31536000, immutable';
  if (/^(text\/|image\/svg|application\/manifest)/.test(type)) return endCompressed(res, 200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' }, cachedFile(file));
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}
const fileCache = new Map();
function cachedFile(file) { const st = fs.statSync(file); const c = fileCache.get(file); if (c && c.mtime === st.mtimeMs) return c.buf; const buf = fs.readFileSync(file); fileCache.set(file, { mtime: st.mtimeMs, buf }); return buf; }

// Keep templates in memory; refresh when the underlying file changes during development.
const pageTemplates = new Map();
function pageTemplate(name) {
  const file = path.join(PUBLIC, name);
  const mtime = fs.statSync(file).mtimeMs;
  const hit = pageTemplates.get(name);
  if (hit && hit.mtime === mtime) return hit.html;
  const html = versionAssets(fs.readFileSync(file, 'utf8'));
  pageTemplates.set(name, { mtime, html });
  return html;
}
function page(res, file, { stripe: withStripe = false, head = '', title = '', body = '' } = {}) {
  // Customer pages may load analytics tools (only after the visitor accepts cookies)
  const an = ['shop.html', 'download.html'].includes(file) ? seo.analyticsCsp() : { script: '', connect: '' };
  // Stripe.js loads from js.stripe.com and its *.js.stripe.com subdomains (see Stripe's CSP guide)
  const stripeSrc = withStripe ? ' https://js.stripe.com https://*.js.stripe.com' : '';
  const headers = ({
    'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; ` +
      `script-src 'self' 'unsafe-inline'${stripeSrc}${an.script}; connect-src 'self'${withStripe ? ' https://api.stripe.com' : ''}${an.connect}; ` +
      `frame-src ${withStripe ? 'https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com' : "'none'"}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'`
  });
  // Reuse unchanged HTML templates instead of blocking the event loop with disk I/O on every page request.
  let html = pageTemplate(file);
  const meta = ['shop.html', 'download.html'].includes(file) ? seo.verificationMeta() : '';
  if (title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${attr(title)}</title>`);
  if (/name="description"/.test(head)) html = html.replace(/<meta name="description"[^>]*>\n?/, '');
  if (head || meta) html = html.replace('</head>', `${meta}${head}\n</head>`);
  // Readable content for search engines and AI crawlers; the app replaces it as soon as it starts
  if (body) html = html.replace('<main id="view" class="wrap"></main>', `<main id="view" class="wrap">${body}</main>`);
  endCompressed(res, 200, headers, html);
}

module.exports = { PUBLIC, send, page, asset, attr };

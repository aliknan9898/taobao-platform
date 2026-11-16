// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Product photos on Kinan's own storage (Cloudflare R2, S3-compatible), so customers never load images from a
 * supplier's servers (which would show where a product comes from). A background job copies each supplier photo of the
 * live catalogue once; buyer-facing views then show the Kinan copy. Until a photo is copied, or while R2 is not set up,
 * the original link is shown, exactly as before.
 *
 * Off until configured: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
 * (the bucket's public address, e.g. https://img.kinan.shop — a custom domain on the bucket).
 */
const crypto = require('crypto');
const db = require('../db');

const env = () => ({
  account: String(process.env.R2_ACCOUNT_ID || '').trim(), keyId: String(process.env.R2_ACCESS_KEY_ID || '').trim(),
  secret: String(process.env.R2_SECRET_ACCESS_KEY || '').trim(), bucket: String(process.env.R2_BUCKET || '').trim(),
  publicUrl: String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')
});
const enabled = () => { const e = env(); return Boolean(e.account && e.keyId && e.secret && e.bucket && /^https:\/\//.test(e.publicUrl)); };
const MAX_BYTES = 8 * 1024 * 1024;
const PER_RUN = 40;
const TRIES = 3;
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

// ---------- AWS Signature Version 4 (R2 speaks the S3 API) ----------
/** Authorization header for one request. `headers` must include host; names are lower-cased and signed. */
function signV4({ method, host, path, query = '', headers, payloadHash, region, service, keyId, secret, amzDate }) {
  const date = amzDate.slice(0, 8);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host };
  const names = Object.keys(h).sort();
  const canonical = [method, path, query, names.map((k) => `${k}:${h[k]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

async function putObject(key, body, contentType, now = new Date()) {
  const e = env();
  const host = `${e.account}.r2.cloudflarestorage.com`;
  const path = `/${encodeURIComponent(e.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256hex(body);
  const headers = { 'content-type': contentType, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, 'cache-control': 'public, max-age=31536000, immutable' };
  const authorization = signV4({ method: 'PUT', host, path, headers, payloadHash, region: 'auto', service: 's3', keyId: e.keyId, secret: e.secret, amzDate });
  const r = await fetch(`https://${host}${path}`, { method: 'PUT', headers: { ...headers, Authorization: authorization }, body, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`R2 upload HTTP ${r.status}`);
  return `${e.publicUrl}/${key}`;
}

// ---------- which links to replace ----------
const ownHost = () => { try { return new URL(require('../config').config.publicBaseUrl).host; } catch { return ''; } };
function external(u) {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false;
  let host; try { host = new URL(u).host; } catch { return false; }
  if (host === ownHost()) return false;
  const pub = env().publicUrl; return !(pub && u.startsWith(pub));
}

let index = null; let indexVer = -1;
function hostedIndex() {
  const v = db.version('media');
  if (!index || v !== indexVer) { index = new Map(db.media.all((d) => d.hosted).map((d) => [d.url, d.hosted])); indexVer = v; }
  return index;
}
/** The link customers should see for an image: Kinan's copy when there is one, else the original. */
function hosted(u) {
  if (!external(u)) return u;
  return hostedIndex().get(u) || u;
}

/** Supplier photos of the live catalogue that have no Kinan copy yet (main gallery first, then option photos). */
function pending(limit = PER_RUN) {
  const done = new Map(db.media.all().map((d) => [d.url, d]));
  const out = [];
  for (const l of db.listings.all((x) => x.status === 'active')) {
    for (const u of [...(l.images || []), ...(l.skus || []).map((s) => s.image)]) {
      if (!external(u) || out.includes(u)) continue;
      const d = done.get(u);
      if (d && (d.hosted || (d.tries || 0) >= TRIES)) continue;
      out.push(u);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
async function copyOne(url) {
  const id = `med_${sha1(url).slice(0, 24)}`;
  const prev = db.media.get(id);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!EXT[type]) throw new Error(`not an image (${type || 'no type'})`);
    const body = Buffer.from(await r.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) throw new Error('image empty or too large');
    const key = `p/${sha1(url)}.${EXT[type]}`;
    const link = await putObject(key, body, type);
    const doc = { url, key, hosted: link, bytes: body.length, tries: (prev?.tries || 0) + 1, error: null };
    if (prev) db.media.update(id, doc); else db.media.insert({ id, ...doc });
    return true;
  } catch (e) {
    const doc = { url, hosted: null, tries: (prev?.tries || 0) + 1, error: String(e.message).slice(0, 200) };
    if (prev) db.media.update(id, doc); else db.media.insert({ id, ...doc });
    return false;
  }
}

let running = false;
/** Background job: copy the next batch of supplier photos. */
async function tick() {
  if (!enabled() || running) return { skipped: true };
  running = true;
  let ok = 0; let failed = 0;
  try {
    for (const u of pending()) { if (await copyOne(u)) ok++; else failed++; }
  } finally { running = false; }
  if (ok || failed) console.log(`[media] photos copied to Kinan storage: ${ok}${failed ? `, failed ${failed}` : ''}`);
  return { ok, failed };
}

function status() {
  const all = db.media.all();
  return { enabled: enabled(), copied: all.filter((d) => d.hosted).length, failed: all.filter((d) => !d.hosted && (d.tries || 0) >= TRIES).length, waiting: enabled() ? pending(100000).length : null };
}

module.exports = { enabled, hosted, tick, status, signV4, putObject, _pending: pending };

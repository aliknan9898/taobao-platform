// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Partner webhooks (Batch 3): endpoints, signed delivery from the outbox, retries, dead letters and replay.
 *
 * Endpoints: HTTPS only, no credentials in the URL, at most 5 active per store. Host names that resolve to private,
 *   loopback, link-local, CGNAT, multicast or documentation ranges are refused — checked when the endpoint is created,
 *   verified and on every delivery, and the connection is pinned to the checked address (no DNS rebinding).
 *   A new endpoint receives nothing until it answers a signed challenge (POST /webhook-endpoints/{id}/verify).
 * Delivery: the outbox is fanned out to subscribed active endpoints (one delivery row per endpoint and event, unique),
 *   then due deliveries are claimed with a lease (SKIP LOCKED) and POSTed OUTSIDE any SQL transaction.
 *   Signature header: KINAN-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${raw body}`)>.
 *   Any 2xx is success; redirects, other statuses, timeouts (10 s) are failures, retried with exponential backoff and
 *   jitter (30 s doubling, at most 1 h apart) for 24 hours, then the delivery is dead. Dead deliveries can be replayed
 *   with the same event id. 50 failures in a row disable the endpoint.
 * Order between events is not guaranteed: apply an event only if its data.version is newer than what you hold, and
 * treat GET /orders/{id} as the source of truth. Payloads never contain recipient address or contact data. */
'use strict';
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const https = require('https');
const pg = require('./pg');
const orders = require('./orders');
const { PartnerError } = require('./catalog');
const { rid, J, seal, open, bad } = orders.internal;

const EVENTS = ['order.updated', 'shipment.updated', 'cancellation.updated', 'return.updated'];
const MAX_ENDPOINTS = 5;
const DEAD_AFTER_MS = 24 * 3600e3;
const DISABLE_AFTER = () => Math.max(5, Number(process.env.PARTNER_WEBHOOK_DISABLE_AFTER) || 50);
const TIMEOUT_MS = 10e3;

// ---------- address guard ----------
const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 23], ['2002::', 16]]) blocked.addSubnet(a, p, 'ipv6');
/** True when an address is publicly routable (IPv4-mapped and NAT64 IPv6 addresses are checked as IPv4). */
function isPublicAddress(ip) {
  const fam = net.isIP(ip); if (!fam) return false;
  if (fam === 6) {
    const low = ip.toLowerCase();
    const m = low.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/); if (m) return isPublicAddress(m[1]);
    const hex = low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const n = (parseInt(hex[1], 16) << 16 >>> 0) + parseInt(hex[2], 16); return isPublicAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}
/** Parse and check an endpoint URL (syntax only; DNS is checked separately). */
function checkUrl(raw) {
  let u; try { u = new URL(String(raw || '')); } catch { throw bad('url', 'invalid', 'An absolute https:// URL'); }
  if (u.protocol !== 'https:') throw bad('url', 'https_required', 'Webhook URLs must use https://');
  if (u.username || u.password) throw bad('url', 'credentials_not_allowed', 'Do not put credentials in the URL; verify our signature instead.');
  if (String(raw).length > 500) throw bad('url', 'too_long');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicAddress(host)) throw bad('url', 'private_address', 'The URL must point to a public address.');
  if (!net.isIP(host) && (!/\./.test(host) || /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i.test(host))) throw bad('url', 'private_address', 'Use a public host name.');
  if (u.hash) throw bad('url', 'invalid', 'No #fragment');
  return u;
}
let lookup = (host) => new Promise((res, rej) => dns.lookup(host, { all: true, verbatim: true }, (e, a) => (e ? rej(e) : res(a.map((x) => x.address)))));
/** Resolve a host and insist that EVERY address is public; returns the address to connect to. */
async function resolvePublic(host) {
  const h = host.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [h] : await lookup(h);
  if (!addrs.length) throw new Error('host does not resolve');
  const bad2 = addrs.filter((a) => !isPublicAddress(a));
  if (bad2.length) { const e = new Error('host resolves to a private address'); e.private = true; throw e; }
  return addrs[0];
}

// ---------- transport ----------
/** Default HTTPS POST: pinned to the checked address, TLS verified against the host name, no redirects, 10 s timeout. */
async function httpsPost(url, headers, body) {
  const u = new URL(url); const address = await resolvePublic(u.hostname);
  return new Promise((resolve) => {
    const req = https.request({
      method: 'POST', host: u.hostname, servername: net.isIP(u.hostname) ? undefined : u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: TIMEOUT_MS,
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family: net.isIP(address) }]) : cb(null, address, net.isIP(address)))
    }, (res) => {
      let size = 0; const chunks = [];
      res.on('data', (c) => { size += c.length; if (size <= 65536) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout after 10 s')));
    req.on('error', (e) => resolve({ error: e.message }));
    req.end(body);
  });
}
let transport = httpsPost;
/** Tests replace the transport (and DNS lookup); production always uses httpsPost. */
function setTransport(fn) { transport = fn || httpsPost; }
function setLookup(fn) { lookup = fn; }

function sign(secret, body, t = Math.floor(Date.now() / 1000)) { return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`; }
/** Helper for partners and tests: constant-time check with a tolerance window (default 5 minutes). */
function verifySignature(secret, body, header, toleranceSec = 300, now = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header || '').split(',').map((x) => x.split('=').map((y) => y.trim())));
  const t = Number(parts.t); if (!t || !parts.v1 || Math.abs(now - t) > toleranceSec) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return want.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts.v1));
}
function headersFor(secret, body, eventId, type, attempt) {
  return { 'Content-Type': 'application/json', 'User-Agent': 'KINAN-Webhooks/1', 'KINAN-Event-Id': eventId, 'KINAN-Event-Type': type, 'KINAN-Delivery-Attempt': String(attempt), 'KINAN-Signature': sign(secret, body) };
}

// ---------- endpoints ----------
function endpointView(e) {
  return { endpoint_id: e.id, url: e.url, events: e.events, state: e.state, consecutive_failures: e.consecutive_failures, disabled_reason: e.disabled_reason || null, verified_at: e.verified_at ? new Date(e.verified_at).toISOString() : null, created_at: new Date(e.created_at).toISOString() };
}
async function own(ctx, id) {
  const e = (await pg.q('SELECT * FROM partner_webhook_endpoint WHERE id = $1 AND env = $2 AND store_id = $3', [id, ctx.env, ctx.store.id])).rows[0];
  if (!e) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Webhook endpoint not found'); return e;
}

async function createEndpoint(ctx, body = {}) {
  const u = checkUrl(body.url);
  const events = body.events === undefined ? EVENTS : body.events;
  if (!Array.isArray(events) || !events.length || events.some((x) => !EVENTS.includes(x))) throw bad('events', 'invalid', EVENTS.join(', '));
  try { await resolvePublic(u.hostname); } catch (e) { throw bad('url', e.private ? 'private_address' : 'unresolvable', e.private ? 'The host resolves to a private address.' : 'The host name does not resolve.'); }
  const active = (await pg.q(`SELECT count(*)::int AS n FROM partner_webhook_endpoint WHERE env = $1 AND store_id = $2 AND state <> 'disabled'`, [ctx.env, ctx.store.id])).rows[0].n;
  if (active >= MAX_ENDPOINTS) throw new PartnerError(409, 'LIMIT_REACHED', 'Too many webhook endpoints', `At most ${MAX_ENDPOINTS} endpoints per store. Delete one first.`);
  const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const secret = `whsec_${Array.from(crypto.randomBytes(32), (b) => B62[b % 62]).join('')}`;
  const e = (await pg.q(`INSERT INTO partner_webhook_endpoint (id, env, store_id, url, events, secret, state) VALUES ($1,$2,$3,$4,$5,$6,'pending_verification') RETURNING *`,
    [rid('pwe'), ctx.env, ctx.store.id, u.toString(), J([...new Set(events)]), J(seal(ctx.env, { s: secret }))])).rows[0];
  return { ...endpointView(e), secret, note: 'Copy the signing secret now — it is not shown again. Then call POST /webhook-endpoints/{endpoint_id}/verify.' };
}
async function listEndpoints(ctx) {
  return { data: (await pg.q('SELECT * FROM partner_webhook_endpoint WHERE env = $1 AND store_id = $2 ORDER BY created_at', [ctx.env, ctx.store.id])).rows.map(endpointView) };
}
async function deleteEndpoint(ctx, id) {
  await own(ctx, id);
  const e = (await pg.q(`UPDATE partner_webhook_endpoint SET state = 'disabled', disabled_reason = 'deleted', updated_at = now() WHERE id = $1 RETURNING *`, [id])).rows[0];
  await pg.q(`UPDATE partner_webhook_delivery SET state = 'dead', last_error = 'endpoint deleted' WHERE endpoint_id = $1 AND state = 'pending'`, [id]);
  return endpointView(e);
}
/** Send a signed challenge; the endpoint must answer 2xx with {"challenge": "<same value>"}. */
async function verifyEndpoint(ctx, id) {
  const e = await own(ctx, id);
  if (e.state === 'disabled') throw new PartnerError(409, 'INVALID_STATE', 'Endpoint is disabled', 'Create a new endpoint.');
  const challenge = crypto.randomBytes(18).toString('base64url');
  const body = JSON.stringify({ id: rid('evt'), type: 'endpoint.verification', api_version: 'v1', environment: ctx.env, created_at: new Date().toISOString(), data: { endpoint_id: e.id, challenge } });
  const r = await transport(e.url, headersFor(open(ctx.env, e.secret).s, body, 'verification', 'endpoint.verification', 1), body).catch((x) => ({ error: x.message }));
  let echoed = null; try { echoed = JSON.parse(r.body || '{}').challenge; } catch { /* not JSON */ }
  if (r.error || !(r.status >= 200 && r.status < 300) || echoed !== challenge) {
    throw new PartnerError(422, 'ENDPOINT_VERIFICATION_FAILED', 'Endpoint did not answer the challenge', r.error ? `Request failed: ${r.error}` : `Expected 2xx with {"challenge": "…"}; got ${r.status}${echoed ? ' with another challenge' : ''}.`);
  }
  const u = (await pg.q(`UPDATE partner_webhook_endpoint SET state = 'active', verified_at = now(), consecutive_failures = 0, updated_at = now() WHERE id = $1 RETURNING *`, [id])).rows[0];
  return endpointView(u);
}

function deliveryView(d) {
  return { delivery_id: String(d.id), event_id: d.event_id, type: d.type, state: d.state, attempts: d.attempts, last_status: d.last_status ?? null, last_error: d.last_error || null, next_attempt_at: d.state === 'pending' ? new Date(d.next_attempt_at).toISOString() : null, delivered_at: d.delivered_at ? new Date(d.delivered_at).toISOString() : null, created_at: new Date(d.created_at).toISOString() };
}
async function listDeliveries(ctx, id, { state, limit } = {}) {
  await own(ctx, id);
  if (state && !['pending', 'delivered', 'dead'].includes(state)) throw bad('state', 'invalid', 'pending, delivered or dead');
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50));
  const rows = (await pg.q(`SELECT d.*, o.type FROM partner_webhook_delivery d JOIN partner_outbox o ON o.id = d.outbox_id WHERE d.endpoint_id = $1 ${state ? 'AND d.state = $3' : ''} ORDER BY d.id DESC LIMIT $2`, state ? [id, n, state] : [id, n])).rows;
  return { data: rows.map(deliveryView) };
}
/** Put an event back in the queue for this endpoint (same event id). Works for dead and delivered events. */
async function replay(ctx, id, body = {}) {
  const e = await own(ctx, id);
  if (e.state !== 'active') throw new PartnerError(409, 'INVALID_STATE', `Endpoint is ${e.state}`, 'Only active endpoints can receive replays.');
  if (typeof body.event_id !== 'string' || !/^evt_[A-Za-z0-9]{6,64}$/.test(body.event_id)) throw bad('event_id', 'invalid');
  const r = (await pg.q(`UPDATE partner_webhook_delivery SET state = 'pending', next_attempt_at = now(), window_started_at = now(), lease_until = NULL, last_error = NULL WHERE endpoint_id = $1 AND event_id = $2 AND state <> 'pending' RETURNING *`, [id, body.event_id])).rows[0];
  if (!r) {
    const ev = (await pg.q('SELECT id FROM partner_outbox WHERE event_id = $1 AND env = $2 AND store_id = $3', [body.event_id, ctx.env, ctx.store.id])).rows[0];
    if (!ev) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Event not found');
    const ins = (await pg.q(`INSERT INTO partner_webhook_delivery (env, store_id, endpoint_id, outbox_id, event_id, state) VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (endpoint_id, outbox_id) DO NOTHING RETURNING *`, [ctx.env, ctx.store.id, id, ev.id, body.event_id])).rows[0];
    if (!ins) throw new PartnerError(409, 'INVALID_STATE', 'This event is already queued for delivery');
    return { replayed: true, delivery_id: String(ins.id), event_id: body.event_id };
  }
  return { replayed: true, delivery_id: String(r.id), event_id: body.event_id };
}

// ---------- dispatcher ----------
/** Turn new outbox events into delivery rows for each subscribed active endpoint. Safe in several processes. */
async function fanOut(env, limit = 200) {
  return pg.tx(async (c) => {
    const evs = (await c.query('SELECT id, store_id, event_id, type FROM partner_outbox WHERE env = $1 AND dispatched_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2', [env, limit])).rows;
    let made = 0;
    for (const ev of evs) {
      const r = await c.query(`INSERT INTO partner_webhook_delivery (env, store_id, endpoint_id, outbox_id, event_id, state)
                               SELECT $1, $2, e.id, $3, $4, 'pending' FROM partner_webhook_endpoint e
                                WHERE e.env = $1 AND e.store_id = $2 AND e.state = 'active' AND e.events ? $5
                               ON CONFLICT (endpoint_id, outbox_id) DO NOTHING`, [env, ev.store_id, ev.id, ev.event_id, ev.type]);
      made += r.rowCount;
    }
    if (evs.length) await c.query('UPDATE partner_outbox SET dispatched_at = now() WHERE id = ANY($1)', [evs.map((x) => x.id)]);
    return made;
  });
}
const backoffMs = (attempt) => { const base = Math.min(3600e3, 30e3 * 2 ** Math.max(0, attempt - 1)); return Math.round(base * (0.8 + Math.random() * 0.4)); };

/** Deliver due events: claim with a 60 s lease, POST outside transactions, record the outcome. */
async function deliverDue(env, limit = 50) {
  const claimed = (await pg.q(`UPDATE partner_webhook_delivery SET lease_until = now() + interval '60 seconds', attempts = attempts + 1
                                WHERE id IN (SELECT id FROM partner_webhook_delivery WHERE env = $1 AND state = 'pending' AND next_attempt_at <= now()
                                               AND (lease_until IS NULL OR lease_until < now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2)
                                RETURNING *`, [env, limit])).rows;
  const out = { delivered: 0, failed: 0, dead: 0 };
  for (const d of claimed) {
    const ev = (await pg.q('SELECT * FROM partner_outbox WHERE id = $1', [d.outbox_id])).rows[0];
    const ep = (await pg.q('SELECT * FROM partner_webhook_endpoint WHERE id = $1', [d.endpoint_id])).rows[0];
    if (ep.state !== 'active') { await pg.q(`UPDATE partner_webhook_delivery SET state = 'dead', last_error = 'endpoint not active', lease_until = NULL WHERE id = $1`, [d.id]); out.dead += 1; continue; }
    const body = JSON.stringify({ id: ev.event_id, type: ev.type, api_version: 'v1', environment: env, created_at: new Date(ev.created_at).toISOString(), store_id: ev.store_id, data: ev.payload });
    let r; try { r = await transport(ep.url, headersFor(open(env, ep.secret).s, body, ev.event_id, ev.type, d.attempts), body); } catch (e) { r = { error: e.message }; }
    if (!r.error && r.status >= 200 && r.status < 300) {
      await pg.q(`UPDATE partner_webhook_delivery SET state = 'delivered', delivered_at = now(), last_status = $2, last_error = NULL, lease_until = NULL WHERE id = $1`, [d.id, r.status]);
      await pg.q('UPDATE partner_webhook_endpoint SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0', [ep.id]);
      out.delivered += 1; continue;
    }
    const why = r.error ? String(r.error).slice(0, 200) : `HTTP ${r.status}`;
    const dead = Date.now() - new Date(d.window_started_at).getTime() >= DEAD_AFTER_MS;
    await pg.q(`UPDATE partner_webhook_delivery SET state = $2, last_status = $3, last_error = $4, next_attempt_at = now() + ($5 || ' milliseconds')::interval, lease_until = NULL WHERE id = $1`,
      [d.id, dead ? 'dead' : 'pending', r.status || null, why, String(backoffMs(d.attempts))]);
    const f = (await pg.q('UPDATE partner_webhook_endpoint SET consecutive_failures = consecutive_failures + 1, updated_at = now() WHERE id = $1 RETURNING consecutive_failures', [ep.id])).rows[0];
    if (f.consecutive_failures >= DISABLE_AFTER()) {
      await pg.q(`UPDATE partner_webhook_endpoint SET state = 'disabled', disabled_reason = 'too_many_failures' WHERE id = $1`, [ep.id]);
      await pg.q(`UPDATE partner_webhook_delivery SET state = 'dead', last_error = 'endpoint disabled after repeated failures' WHERE endpoint_id = $1 AND state = 'pending'`, [ep.id]);
    }
    if (dead) out.dead += 1; else out.failed += 1;
  }
  return out;
}
async function dispatch(env) { const fanned = await fanOut(env); const r = await deliverDue(env); return { fanned, ...r }; }

/** Admin: delivery health and dead letters (no payload bodies). */
async function adminSummary(env = 'sandbox') {
  const counts = (await pg.q(`SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending, count(*) FILTER (WHERE state = 'dead')::int AS dead, count(*) FILTER (WHERE state = 'delivered' AND delivered_at > now() - interval '24 hours')::int AS delivered_24h FROM partner_webhook_delivery WHERE env = $1`, [env])).rows[0];
  const endpoints = (await pg.q(`SELECT id, store_id, url, state, consecutive_failures, disabled_reason FROM partner_webhook_endpoint WHERE env = $1 AND state <> 'disabled' OR (env = $1 AND disabled_reason = 'too_many_failures') ORDER BY created_at DESC LIMIT 50`, [env])).rows;
  const dead = (await pg.q(`SELECT d.id, d.event_id, d.store_id, d.endpoint_id, d.attempts, d.last_status, d.last_error, o.type, d.created_at FROM partner_webhook_delivery d JOIN partner_outbox o ON o.id = d.outbox_id WHERE d.env = $1 AND d.state = 'dead' ORDER BY d.id DESC LIMIT 30`, [env])).rows;
  return { ...counts, endpoints, dead_list: dead.map((x) => ({ ...x, id: String(x.id), created_at: new Date(x.created_at).getTime() })) };
}
/** Admin replay of one dead delivery. */
async function adminReplay(deliveryId) {
  const r = (await pg.q(`UPDATE partner_webhook_delivery d SET state = 'pending', next_attempt_at = now(), window_started_at = now(), lease_until = NULL, last_error = NULL
                          FROM partner_webhook_endpoint e WHERE d.id = $1 AND e.id = d.endpoint_id AND e.state = 'active' AND d.state = 'dead' RETURNING d.id`, [deliveryId])).rows[0];
  if (!r) throw new PartnerError(409, 'INVALID_STATE', 'Only dead deliveries to active endpoints can be replayed');
  return { replayed: true, delivery_id: String(r.id) };
}

module.exports = {
  EVENTS, createEndpoint, listEndpoints, deleteEndpoint, verifyEndpoint, listDeliveries, replay,
  fanOut, deliverDue, dispatch, adminSummary, adminReplay,
  isPublicAddress, checkUrl, resolvePublic, sign, verifySignature, setTransport, setLookup, _backoffMs: backoffMs, _httpsPost: httpsPost
};

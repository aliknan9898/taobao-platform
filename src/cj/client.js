// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * CJdropshipping API 2.0 client (https://developers.cjdropshipping.com/api2.0/v1/).
 * - Sign-in with the account's API key (CJ_API_KEY) → access token (180 days) + refresh token, kept in the database.
 * - CJ allows 1 request per second: every call goes through one queue.
 * - Responses are { code, result, message, data }; anything but result=true / code=200 is an error.
 */
const db = require('../db');

const BASE = process.env.CJ_API_URL || 'https://developers.cjdropshipping.com/api2.0/v1';
const SID = 'set_cj_token';
const enabled = () => Boolean(process.env.CJ_API_KEY);

class CjError extends Error {
  constructor(message, code, status = 502) { super(message); this.code = code; this.status = status; }
}

// ---------------- one call per second, people first ----------------
// Background work (shipping prices for the shop, re-syncs, best sellers) waits behind anything a seller or
// admin is doing right now, so a product lookup never sits behind a long queue of freight checks.
const { AsyncLocalStorage } = require('async_hooks');
const ctx = new AsyncLocalStorage();
// CJ points (developers.cjdropshipping.com → API Points): 50,000 a day plus 100 per $1 of the best month of CJ orders in the
// last 3 months. They refill a little every minute (total ÷ 1440) and fully at 00:00 UTC. Product list = 50 points,
// product details and freight = 10. Every CJ answer says how many are left (pointsInfo), kept here.
// Background work (imports, price and shipping checks) leaves CJ_POINTS_RESERVE points for customers' checkouts and
// their CJ orders, and when the points run out it waits only until enough have refilled (minutes, not a day).
const BG_MAX = () => Math.max(0, Number(process.env.CJ_BACKGROUND_CALLS_PER_DAY ?? 2500));
const RESERVE = () => Math.max(0, Number(process.env.CJ_POINTS_RESERVE ?? 500));
const nextReset = (now = Date.now()) => now - (now % 86400e3) + 86400e3; // 00:00 UTC, CJ's new day
// Kept in the database so a restart or a new deploy does not hand out a fresh day's budget (many deploys a day used to)
const BGID = 'cj_bg_use';
const bgUse = { reset: 0, n: 0, out: 0, loaded: false, savedN: -1 };
function loadUse() {
  if (bgUse.loaded) return; bgUse.loaded = true;
  try {
    const d = db.settings.get(BGID);
    if (d) {
      const t = Date.now();
      // Saved by older versions: a pause "until CJ's new day" (hours away) and a day ending at China's midnight.
      // Points refill every minute, so a pause is never longer than an hour; CJ's day ends at 00:00 UTC.
      bgUse.out = d.out && d.out - t <= 3600e3 ? d.out : 0;
      bgUse.reset = d.reset && d.reset <= nextReset(t) ? d.reset : nextReset(t);
      bgUse.n = d.reset && d.reset <= nextReset(t) ? d.n || 0 : 0;
      if (d.points) points = d.points;
    }
  } catch { /* not ready */ }
}
function saveUse(force = false) {
  if (!force && bgUse.n - bgUse.savedN < 20) return; bgUse.savedN = bgUse.n;
  try { const doc = { reset: bgUse.reset, n: bgUse.n, out: bgUse.out, points }; if (db.settings.get(BGID)) db.settings.update(BGID, doc); else db.settings.insert({ id: BGID, ...doc }); } catch { /* best effort */ }
}
let pointsOutUntil = 0;
let points = null; // { used, remaining, total, at } from CJ's last answer
/** Minutes until `need` points have refilled (CJ adds total ÷ 1440 a minute). */
function refillMs(need) {
  const perMin = (points && points.total ? points.total : 50000) / 1440;
  return Math.min(60, Math.max(2, Math.ceil(need / perMin))) * 60e3;
}
function notePoints(info) {
  if (!info || typeof info !== 'object') return;
  const remaining = Number(info.remaining); const total = Number(info.total); const used = Number(info.usedToday);
  if (!Number.isFinite(remaining)) return;
  points = { remaining, total: Number.isFinite(total) ? total : points?.total || null, used: Number.isFinite(used) ? used : null, at: Date.now() };
}
function bgBudget() {
  const now = Date.now();
  loadUse();
  if (bgUse.out > pointsOutUntil) pointsOutUntil = bgUse.out;
  if (now >= bgUse.reset) { bgUse.reset = nextReset(now); bgUse.n = 0; saveUse(true); }
  if (now < pointsOutUntil) throw new CjError('CJ: no API points left for now — background work waits for them to refill', 'POINTS', 429);
  // Points known to be low (with what refilled since): leave the rest for customers and wait a little
  if (points && points.total) {
    const now2 = Date.now(); const est = Math.min(points.total, points.remaining + ((now2 - points.at) / 60e3) * (points.total / 1440));
    if (est < RESERVE() + 50) {
      pointsOutUntil = now2 + refillMs(RESERVE() + 100 - est); bgUse.out = pointsOutUntil; saveUse(true);
      throw new CjError('CJ: no API points left for now — background work waits for them to refill', 'POINTS', 429);
    }
  }
  if (bgUse.n >= BG_MAX()) throw new CjError(`CJ: today's background limit (${BG_MAX()} calls) is used — the rest is kept for orders`, 'BUDGET', 429);
  bgUse.n++; saveUse();
}
const usage = () => (loadUse(), { background_calls: bgUse.n, background_limit: BG_MAX(), resets_at: bgUse.reset || nextReset(), points_out_until: pointsOutUntil > Date.now() ? pointsOutUntil : null,
  points: points ? { ...points, reserve: RESERVE(), refill_per_minute: points.total ? Math.round(points.total / 1440) : null } : null });
/** When stopped background work should try again: right after CJ's points have refilled (or in 20 minutes). */
const retryAt = () => { const u = pointsOutUntil > Date.now() ? pointsOutUntil : 0; return u ? u + 60e3 : Date.now() + 20 * 60e3; };
/** Run fn as background work: its CJ calls go after interactive ones. */
const background = (fn) => ctx.run({ bg: true }, fn);
const GAP = Number(process.env.CJ_MIN_GAP_MS ?? 1100);
const COOL_MS = Number(process.env.CJ_COOL_MS ?? 3000);
const queues = { hi: [], lo: [] }; let pumping = false; let last = 0; let coolUntil = 0;
function queued(fn) {
  return new Promise((resolve, reject) => {
    (ctx.getStore()?.bg ? queues.lo : queues.hi).push({ fn, resolve, reject });
    pump();
  });
}
async function pump() {
  if (pumping) return; pumping = true;
  try {
    while (queues.hi.length || queues.lo.length) {
      const wait = Math.max(last + GAP, coolUntil) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const job = queues.hi.shift() || queues.lo.shift(); // picked after the wait, so a newer interactive call goes first
      last = Date.now();
      try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
    }
  } finally { pumping = false; }
}
/** CJ said "too many requests": pause every call for a moment. */
const coolDown = (ms = COOL_MS) => { coolUntil = Math.max(coolUntil, Date.now() + ms); };

async function raw(method, path, { query, body, token } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(x));
  }
  const r = await fetch(url, {
    method, signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(token ? { 'CJ-Access-Token': token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let j; try { j = await r.json(); } catch { throw new CjError(`CJ answered ${r.status}`, r.status); }
  notePoints(j && (j.pointsInfo || j.data?.pointsInfo));
  if (r.status === 429 || j.code === 1600200) throw new CjError('CJ is busy (too many requests) — try again in a moment', j.code, 429);
  if (!(j.result === true || j.code === 200) || (j.success === false)) {
    if (/Insufficient API points/i.test(j.message || '')) {
      // Points refill every minute: wait until a few calls' worth are back (and the customers' reserve), not a whole day
      const m = String(j.message); const used = Number(m.match(/Used today:\s*(\d+)/i)?.[1]);
      if (Number.isFinite(used)) points = { remaining: 0, total: points?.total || used, used, at: Date.now() };
      const first = Date.now() >= pointsOutUntil;
      pointsOutUntil = Date.now() + refillMs(RESERVE() + 100); bgUse.out = pointsOutUntil; saveUse(true);
      if (first) console.warn(`[cj] API points used up (${m.match(/Used today: \d+/)?.[0] || 'daily limit'}) — background work pauses until ${new Date(pointsOutUntil).toISOString().slice(11, 16)} UTC while they refill`);
      throw new CjError(`CJ: ${j.message}`, j.code, 429);
    }
    throw new CjError(`CJ: ${j.message || 'request failed'}`, j.code);
  }
  return j.data;
}

// ---------------- tokens ----------------
function saved() { return db.settings.get(SID) || null; }
function save(d) {
  const doc = {
    access_token: d.accessToken, refresh_token: d.refreshToken, open_id: d.openId != null ? String(d.openId) : saved()?.open_id || null,
    access_expires_at: d.accessTokenExpiryDate ? new Date(d.accessTokenExpiryDate).getTime() || null : null,
    refresh_expires_at: d.refreshTokenExpiryDate ? new Date(d.refreshTokenExpiryDate).getTime() || null : null,
    key_hint: String(process.env.CJ_API_KEY || '').slice(-6), updated_at: Date.now()
  };
  return saved() ? db.settings.update(SID, doc) : db.settings.insert({ id: SID, ...doc });
}

let inflight = null;
async function token({ force = false } = {}) {
  if (!enabled()) throw new CjError('CJdropshipping is not connected — add CJ_API_KEY on the server', 'NO_KEY', 503);
  const s = saved();
  const sameKey = s && s.key_hint === String(process.env.CJ_API_KEY).slice(-6);
  const fresh = sameKey && s.access_token && (!s.access_expires_at || s.access_expires_at - Date.now() > 2 * 86400e3);
  if (fresh && !force) return s.access_token;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (sameKey && s.refresh_token && (!s.refresh_expires_at || s.refresh_expires_at > Date.now())) {
        try { return save(await queued(() => raw('POST', '/authentication/refreshAccessToken', { body: { refreshToken: s.refresh_token } }))).access_token; } catch { /* fall back to a new sign-in */ }
      }
      return save(await queued(() => raw('POST', '/authentication/getAccessToken', { body: { apiKey: process.env.CJ_API_KEY } }))).access_token;
    } finally { inflight = null; }
  })();
  return inflight;
}

/** Authenticated call; signs in again once if CJ says the token is no longer valid. */
async function call(method, path, opts = {}) {
  if (ctx.getStore()?.bg) bgBudget();
  let t = await token();
  // "Too many requests": wait and try again (twice for a person waiting, once for background work)
  const tries = ctx.getStore()?.bg ? 1 : 2;
  for (let i = 0; ; i++) {
    try { return await queued(() => raw(method, path, { ...opts, token: t })); }
    catch (e) {
      if ([1600001, 1600002, 1600003].includes(Number(e.code))) { t = await token({ force: true }); continue; }
      if (e.status === 429 && i < tries) { coolDown(COOL_MS * (i + 1)); continue; }
      if (e.status === 429) coolDown();
      throw e;
    }
  }
}

const openId = () => saved()?.open_id || null;

module.exports = { retryAt, usage, call, token, enabled, openId, background, CjError, BASE };

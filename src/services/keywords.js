// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Google Keyword Planner (Google Ads API, KeywordPlanIdeaService.generateKeywordIdeas):
 * for each Kinan product, the searches people really type on Google with their monthly volume; the busiest relevant
 * ones become the product's search keywords (shop search, Google Shopping feed, ChatGPT feed, eBay).
 *
 * Setup (env): GOOGLE_ADS_CUSTOMER_ID (10 digits, the Google Ads account), GOOGLE_ADS_LOGIN_CUSTOMER_ID (the manager
 * account, if the account sits under one), optional GOOGLE_ADS_DEVELOPER_TOKEN; the OAuth client is Kinan's Google
 * sign-in client (GOOGLE_CLIENT_ID/SECRET) or GOOGLE_ADS_CLIENT_ID/SECRET. The admin connects once (scope "adwords");
 * the refresh token is kept in settings. The Cloud project needs the Google Ads API with production access.
 *   GOOGLE_ADS_GEOS (2826 = United Kingdom), GOOGLE_ADS_LANGUAGE (1000 = English), GOOGLE_ADS_DAILY_CALLS (1500), GOOGLE_ADS_API_VERSION (v26)
 */
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../auth');
const { config } = require('../config');

const SID = 'gads_auth';
const ST = 'gads_state';
const env = process.env;
const clientId = () => env.GOOGLE_ADS_CLIENT_ID || config.googleClientId;
const clientSecret = () => env.GOOGLE_ADS_CLIENT_SECRET || config.googleClientSecret;
const customer = () => String(env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/\D/g, '');
const loginCustomer = () => String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, '');
const version = () => env.GOOGLE_ADS_API_VERSION || 'v26';
const redirect = () => `${config.publicBaseUrl}/oauth/google-ads/callback`;
const configured = () => Boolean(clientId() && clientSecret() && customer().length === 10);
const auth = () => db.settings.get(SID) || null;
const connected = () => Boolean(configured() && auth()?.refresh_token);
const DAILY = () => Math.max(0, Math.floor(Number(env.GOOGLE_ADS_DAILY_CALLS ?? 1500)));
const GEOS = () => String(env.GOOGLE_ADS_GEOS || '2826').split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).slice(0, 10);
const LANG = () => String(env.GOOGLE_ADS_LANGUAGE || '1000').replace(/\D/g, '') || '1000';

function state() { return db.settings.get(ST) || {}; }
function saveState(p) { return db.settings.get(ST) ? db.settings.update(ST, typeof p === 'function' ? p : { ...p }) : db.settings.insert({ id: ST, ...(typeof p === 'function' ? p({}) : p) }); }

// ---------------- connect (OAuth, once) ----------------

function authUrl() {
  if (!configured()) throw httpError(503, 'Set GOOGLE_ADS_CUSTOMER_ID (and the Google OAuth client) first');
  const s = crypto.randomBytes(16).toString('hex');
  db.oauthStates.insert({ state: s, kind: 'gads', created_at: Date.now() });
  const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirect(), response_type: 'code', scope: 'https://www.googleapis.com/auth/adwords', access_type: 'offline', prompt: 'consent', state: s });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}
async function handleCallback(code, s) {
  const st = s && db.oauthStates.all((x) => x.state === s && x.kind === 'gads')[0];
  if (!st || Date.now() - st.created_at > 30 * 60e3) throw httpError(400, 'The Google link expired — press Connect again');
  db.oauthStates.remove(st.id);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirect(), grant_type: 'authorization_code' }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) throw httpError(400, `Google did not connect: ${j.error_description || j.error || 'no refresh token — remove Kinan in your Google account’s third-party access and connect again'}`);
  const doc = { refresh_token: j.refresh_token, access_token: j.access_token, access_exp: Date.now() + (j.expires_in - 120) * 1000, connected_at: Date.now() };
  if (auth()) db.settings.update(SID, doc); else db.settings.insert({ id: SID, ...doc });
  saveState({ blocked_until: 0 });
  return true;
}
function disconnect() { if (auth()) db.settings.update(SID, { refresh_token: null, access_token: null }); }

async function accessToken() {
  const a = auth();
  if (!connected()) throw httpError(409, 'Google Keyword Planner is not connected');
  if (a.access_token && a.access_exp > Date.now()) return a.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: a.refresh_token, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === 'invalid_grant') disconnect();
    throw httpError(409, `Google sign-in expired — connect Keyword Planner again (${j.error || r.status})`);
  }
  db.settings.update(SID, { access_token: j.access_token, access_exp: Date.now() + (j.expires_in - 120) * 1000 });
  return j.access_token;
}

// ---------------- keyword ideas ----------------

const today = () => new Date().toISOString().slice(0, 10);
function spend() {
  const s = state(); const used = s.day === today() ? s.used || 0 : 0;
  if (used >= DAILY()) throw httpError(429, `Today's Keyword Planner limit (${DAILY()} calls) is used`);
  saveState({ day: today(), used: used + 1 });
}
const cache = new Map();

/** Ideas for up to 20 seed keywords: [{ text, volume, competition, index, bid_low, bid_high }] (cached 7 days). */
async function ideas(seeds, { geos = GEOS(), lang = LANG() } = {}) {
  const kw = [...new Set((seeds || []).map((x) => String(x).toLowerCase().replace(/[^\p{L}\p{N} '&-]+/gu, ' ').replace(/\s+/g, ' ').trim()).filter((x) => x.length > 1 && x.split(' ').length <= 10))].slice(0, 20);
  if (!kw.length) return [];
  const key = `${geos.join(',')}|${lang}|${kw.sort().join('|')}`;
  const c = cache.get(key); if (c && Date.now() - c.at < 7 * 86400e3) return c.v;
  // An account Google has not switched on yet (or no API access) answers the same for hours: wait instead of asking again
  const st = state();
  if (st.blocked_until > Date.now() && st.blocked_for === customer()) throw httpError(409, st.last_error || 'Google Ads is not ready yet');
  spend();
  const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
  if (loginCustomer()) headers['login-customer-id'] = loginCustomer();
  if (env.GOOGLE_ADS_DEVELOPER_TOKEN) headers['developer-token'] = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const r = await fetch(`https://googleads.googleapis.com/${version()}/customers/${customer()}:generateKeywordIdeas`, {
    method: 'POST', headers, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ keywordSeed: { keywords: kw }, language: `languageConstants/${lang}`, geoTargetConstants: geos.map((g) => `geoTargetConstants/${g}`), keywordPlanNetwork: 'GOOGLE_SEARCH', includeAdultKeywords: false, pageSize: 200 })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const det = j.error?.details?.[0]?.errors?.[0];
    const msg = det?.message || j.error?.message || `HTTP ${r.status}`;
    console.warn('[keywords] Google Ads:', r.status, msg);
    const e = httpError(r.status === 429 || /RESOURCE_EXHAUSTED/.test(JSON.stringify(j)) ? 429 : r.status === 401 || r.status === 403 ? 409 : 502, `Google Ads: ${msg}`.slice(0, 400));
    const blocked = r.status === 403 || /not yet enabled|deactivated|DEVELOPER_TOKEN|PERMISSION_DENIED|not.*approved/i.test(msg);
    saveState({ last_error: e.message, last_error_at: Date.now(), ...(blocked ? { blocked_until: Date.now() + 3 * 3600e3, blocked_for: customer() } : {}) });
    throw e;
  }
  const out = (j.results || []).map((x) => ({
    text: String(x.text || '').toLowerCase(), volume: Number(x.keywordIdeaMetrics?.avgMonthlySearches) || 0,
    competition: x.keywordIdeaMetrics?.competition || 'UNSPECIFIED', index: Number(x.keywordIdeaMetrics?.competitionIndex) || 0,
    bid_low: Number(x.keywordIdeaMetrics?.lowTopOfPageBidMicros || 0) / 1e6, bid_high: Number(x.keywordIdeaMetrics?.highTopOfPageBidMicros || 0) / 1e6
  })).filter((x) => x.text);
  cache.set(key, { at: Date.now(), v: out });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return out;
}

// ---------------- products ----------------

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'in', 'to', 'set', 'pcs', 'piece', 'new', 'hot', 'sale', '2024', '2025', '2026', 'style', 'creative', 'portable', 'mini']);
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const GENERIC = new Set(['best', 'cheap', 'buy', 'uk', 'large', 'small', 'big', 'women', 'womens', 'men', 'mens', 'kids', 'girls', 'boys', 'baby', 'gift', 'gifts', 'online', 'sale', 'black', 'white', 'red', 'blue', 'pink', 'green', 'grey', 'gray', 'gold', 'silver', 'home', 'outdoor', 'indoor', 'christmas', 'xmas', 'cute', 'funny', 'personalised', 'electric', 'wireless', 'waterproof', 'adjustable', 'heavy', 'duty', 'medium', 'xl', 'pack']);
const BRANDS = /\b(apple|iphone|samsung|nike|adidas|disney|lego|ikea|amazon|ebay|aliexpress|temu|shein|dyson|philips|bosch|xiaomi|huawei|sony|gucci|chanel|marvel|pokemon|barbie)\b/i;

/** Seeds for one product: its current keywords, then short phrases from the title. */
function seedsFor(l) {
  const t = words(l.title);
  const phrases = [t.slice(0, 2).join(' '), t.slice(0, 3).join(' '), t.slice(-2).join(' '), t.slice(1, 3).join(' ')];
  return [...new Set([...(l.keywords || []), ...(l.sourcing?.keyword ? [l.sourcing.keyword] : []), ...phrases].map((x) => String(x).toLowerCase().trim()).filter((x) => x && x.split(' ').length <= 6))].slice(0, 20);
}

/** Replace a product's keywords with the busiest relevant Google searches (keeps the AI's words that Google does not know). */
async function improve(listingId) {
  const l = db.listings.get(listingId);
  if (!l) throw httpError(404, 'Product not found');
  const seeds = seedsFor(l);
  const all = await ideas(seeds);
  // Every word of the search must describe this product (its title/keywords) or be a plain shopping word: that keeps out
  // other products and other brands (Google suggests competitors' names a lot)
  const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
  const mine = new Set(words(`${l.title} ${(l.keywords || []).join(' ')} ${l.collection_group || ''} ${l.sourcing?.keyword || ''}`).map(stem));
  const fits = (t) => { const w = words(t); return w.length > 0 && w.every((x) => mine.has(stem(x)) || GENERIC.has(x)) && w.some((x) => mine.has(stem(x))); };
  const relevant = all.filter((x) => x.volume >= 10 && !BRANDS.test(x.text) && fits(x.text) && x.text.length <= 60)
    .sort((a, b) => b.volume - a.volume);
  const picked = []; const seen = new Set();
  for (const x of relevant) { const k = words(x.text).map(stem).sort().join(' '); if (seen.has(k)) continue; seen.add(k); picked.push(x); if (picked.length >= 12) break; }
  const keep = (l.keywords || []).filter((k) => !picked.some((p) => p.text === k)).slice(0, Math.max(0, 15 - picked.length));
  const keywords = [...picked.map((x) => x.text), ...keep].slice(0, 15);
  db.listings.update(l.id, { keywords, kw_stats: { at: Date.now(), geos: GEOS(), top: picked.map((x) => ({ text: x.text, volume: x.volume, competition: x.competition })), seeds: seeds.length, ideas: all.length } });
  return { id: l.id, keywords, top: picked };
}

let running = false;
/** Hourly: Kinan's live products without Google keyword data (or older than 60 days), a batch at a time. */
async function tick({ max = 60 } = {}) {
  if (running || !connected()) return { skipped: true };
  running = true; let done = 0; let failed = 0;
  try {
    const todo = db.listings.all((l) => ['active', 'pending_review'].includes(l.status) && (!l.kw_stats || Date.now() - l.kw_stats.at > 60 * 86400e3))
      .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || (b.created_at || 0) - (a.created_at || 0)).slice(0, max);
    for (const l of todo) {
      try { await improve(l.id); done++; } catch (e) { failed++; if (e.status === 429 || e.status === 409) break; }
      await new Promise((r) => setTimeout(r, 1500)); // ~40 a minute at most
    }
  } finally { running = false; }
  if (done || failed) { console.log(`[keywords] Google keywords for ${done} product(s)${failed ? `, ${failed} failed` : ''}`); saveState({ last_run: { at: Date.now(), done, failed } }); }
  return { done, failed };
}

function status() {
  const s = state();
  const withData = db.listings.all((l) => l.kw_stats);
  const top = withData.flatMap((l) => (l.kw_stats.top || []).slice(0, 1).map((x) => ({ ...x, product: l.title.slice(0, 60), id: l.id }))).sort((a, b) => b.volume - a.volume).slice(0, 15);
  return {
    configured: configured(), connected: connected(), customer: customer() ? `${customer().slice(0, 3)}-${customer().slice(3, 6)}-${customer().slice(6)}` : null, redirect: redirect(),
    geos: GEOS(), language: LANG(), used_today: s.day === today() ? s.used || 0 : 0, daily: DAILY(), last_run: s.last_run || null, last_error: s.last_error || null,
    products_done: withData.length, products_live: db.listings.all((l) => l.status === 'active').length, top
  };
}

/** At start-up: when the Google Ads account number has changed, try it at once on a few products (no hour's wait). */
async function checkAccount() {
  if (!connected() || state().checked_customer === customer()) return null;
  saveState({ checked_customer: customer() });
  const r = await tick({ max: 3 });
  console.log(`[keywords] account ${customer()} check: ${r.done ? 'works' : `failed — ${state().last_error || 'no answer'}`}`);
  return r;
}

/** The admin pressed "Update now": ask Google again even during a pause (the owner may have just fixed the account). */
function unblock() { saveState({ blocked_until: 0 }); }

module.exports = { unblock, checkAccount, configured, connected, authUrl, handleCallback, disconnect, ideas, improve, tick, status, seedsFor, _cache: cache };

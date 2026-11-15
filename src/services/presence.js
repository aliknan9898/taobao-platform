// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Who is on Kinan right now: each open Kinan Shop / Seller Center tab sends a small heartbeat every 30 seconds with a
 * random id kept in that browser (no name, no cookie). A visitor counts as live for 75 seconds after the last one, and
 * leaves at once when they close the tab. Kept in memory only — the count restarts with the server.
 */
const APPS = ['shop', 'seller'];
const LIVE_MS = 75e3;
const MAX = 50000;
const seen = new Map(); // `${app}:${id}` → last time
const peak = { day: null, shop: 0, seller: 0 };

const day = (t) => new Date(t).toISOString().slice(0, 10);
function prune(now) { for (const [k, t] of seen) if (now - t > LIVE_MS) seen.delete(k); }

function ping({ app, id, leave } = {}, now = Date.now()) {
  if (!APPS.includes(app) || !/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) return false;
  const k = `${app}:${id}`;
  if (leave) { seen.delete(k); return true; }
  if (!seen.has(k) && seen.size >= MAX) { prune(now); if (seen.size >= MAX) return false; }
  seen.set(k, now);
  return true;
}
function counts(now = Date.now()) {
  prune(now);
  const out = { shop: 0, seller: 0 };
  for (const k of seen.keys()) out[k.slice(0, k.indexOf(':'))]++;
  const d = day(now);
  if (peak.day !== d) Object.assign(peak, { day: d, shop: 0, seller: 0 });
  for (const a of APPS) peak[a] = Math.max(peak[a], out[a]);
  return { ...out, peak_today: { shop: peak.shop, seller: peak.seller }, at: now };
}
function reset() { seen.clear(); Object.assign(peak, { day: null, shop: 0, seller: 0 }); }

module.exports = { ping, counts, reset, LIVE_MS };

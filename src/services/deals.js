// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Today's deals: every day (midnight, Malta time) the AI picks a dozen products shoppers will love, from different
 * departments, with room in the margin; each gets 10–20% off until midnight. The discount is applied where prices
 * are read (shop, cart, checkout), so the stored prices and the CJ price sync are never touched.
 *   DEALS_COUNT (12) · DEALS_MAX_PCT (20) · DEALS_MIN_MARGIN (1.2 = the deal price stays ≥ 120% of the CJ cost)
 */
const db = require('../db');

const SID = 'deals';
const TZ = 'Europe/Malta';
const COUNT = () => Math.min(40, Math.max(0, Math.floor(Number(process.env.DEALS_COUNT ?? 12))));
const MAX_PCT = () => Math.min(50, Math.max(5, Number(process.env.DEALS_MAX_PCT ?? 20)));
const MIN_MARGIN = () => Math.max(1.05, Number(process.env.DEALS_MIN_MARGIN ?? 1.2));
const money = (v) => Math.round(Number(v) * 100) / 100;

/** The day in Malta and the moment it ends. */
function dayInfo(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const secs = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return { day, ends: now + (86400 - secs) * 1000 - (now % 1000) };
}

function current() {
  const d = db.settings.get(SID);
  return d && Date.now() < d.ends ? d : null;
}

/** The deal on a product right now (null when none). */
function dealFor(l) {
  const d = current(); if (!d || !l) return null;
  const x = (d.items || []).find((i) => i.id === l.id);
  return x ? { pct: x.pct, ends: d.ends } : null;
}
/** The price a shopper pays for this option right now. */
function priceOf(l, s) {
  const d = dealFor(l);
  if (!d) return s.price;
  const cost = Number(s.cost_sale) || 0;
  const p = money(s.price * (1 - d.pct / 100));
  return cost ? Math.max(p, money(cost * MIN_MARGIN())) : p;
}

const sameDay = (d) => d && d.day === dayInfo().day;

/** Products that can be a deal: live, in stock, photos, enough margin for at least 10% off. */
function candidates() {
  const sellers = new Set(db.sellers.all((s) => s.status === 'active').map((s) => s.id));
  const recent = new Set((db.settings.get(SID)?.history || []).flat());
  const out = [];
  for (const l of db.listings.all((x) => x.status === 'active' && sellers.has(x.seller_id) && (x.images || []).length)) {
    const s = [...(l.skus || [])].filter((k) => k.stock >= 5).sort((a, b) => a.price - b.price)[0];
    if (!s || !(s.price > 0)) continue;
    const cost = Number(s.cost_sale) || 0;
    const room = cost ? Math.floor((1 - (cost * MIN_MARGIN()) / s.price) * 100) : MAX_PCT();
    const pct = Math.min(MAX_PCT(), room);
    if (pct < 10) continue;
    out.push({ l, pct: Math.floor(pct / 5) * 5, recent: recent.has(l.id), eu: Boolean(l.cj_from && l.cj_from !== 'CN'), dept: l.sourcing?.dept || (l.collections || [])[0] || l.category || 'other' });
  }
  // fresh products first, then European stock, then newest
  return out.sort((a, b) => (a.recent - b.recent) || (b.eu - a.eu) || ((b.l.created_at || 0) - (a.l.created_at || 0))).slice(0, 80);
}

/** Without the AI: take turns across departments so the deals are varied. */
function mix(cands, n) {
  const by = new Map();
  for (const c of cands) { if (!by.has(c.dept)) by.set(c.dept, []); by.get(c.dept).push(c); }
  const out = []; const lists = [...by.values()];
  for (let i = 0; out.length < n && lists.some((x) => x[i]); i++) for (const x of lists) if (x[i] && out.length < n) out.push(x[i]);
  return out;
}

async function pick() {
  const n = COUNT(); const cands = candidates();
  if (!n || !cands.length) return [];
  const ai = require('./ai');
  if (ai.enabled() && cands.length > n) {
    try {
      const r = await ai.structured({
        system: 'You are the merchandiser of Kinan, an online marketplace for the UK and Europe. Pick today\'s deals: products most shoppers would want right now (season, gifting, usefulness, wow factor), varied across departments, no two alike.',
        name: 'todays_deals', kind: 'deals', maxTokens: 400,
        schema: { type: 'object', properties: { picks: { type: 'array', items: { type: 'integer' }, description: `Exactly ${n} different numbers from the list.` } }, required: ['picks'] },
        text: `Today is ${dayInfo().day}. Choose ${n}:\n${cands.map((c, i) => `${i}. ${c.l.title.slice(0, 90)} — ${c.dept}, -${c.pct}%`).join('\n')}`
      });
      const chosen = [...new Set((r.picks || []).map(Number))].filter((i) => cands[i]).slice(0, n).map((i) => cands[i]);
      if (chosen.length >= Math.min(n, 4)) return [...chosen, ...mix(cands.filter((c) => !chosen.includes(c)), n - chosen.length)];
    } catch (e) { console.warn('[deals] AI pick:', e.message); }
  }
  return mix(cands, n);
}

let busy = false;
/** Every few minutes: a new set of deals when the day changes in Malta. */
async function tick({ force = false } = {}) {
  if (busy) return null;
  const d = db.settings.get(SID);
  if (!force && sameDay(d)) return d;
  busy = true;
  try {
    const { day, ends } = dayInfo();
    const chosen = await pick();
    const items = chosen.map((c) => ({ id: c.l.id, pct: c.pct }));
    const history = [items.map((x) => x.id), ...((d?.history) || [])].slice(0, 3); // not the same products three days running
    const doc = { day, ends, items, history, at: Date.now() };
    if (d) db.settings.update(SID, doc); else db.settings.insert({ id: SID, ...doc });
    console.log(`[deals] ${day}: ${items.length} deal(s)`);
    return doc;
  } finally { busy = false; }
}

function publicDeals() {
  const d = current();
  if (!d || !d.items.length) return null;
  return { ends: d.ends, ids: d.items.map((x) => x.id), count: d.items.length, max_pct: Math.max(...d.items.map((x) => x.pct)) };
}

module.exports = { tick, current, dealFor, priceOf, publicDeals, dayInfo, candidates };

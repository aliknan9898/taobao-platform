// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Parcel tracking for parcels that go straight from the supplier to the customer (AliExpress, Banggood, CJ without
 * webhook events). Every step is kept on the order (customer and seller see the whole journey), but the customer is
 * notified only at the big moments:
 *   5  left the country it ships from        6  arrived in the customer's country
 *   10 out for delivery                      12 delivered          13 not delivered (delivery problem / returned)
 * Steps come from Cainiao's public tracking (AliExpress parcels: AP…, LP…, CNSTB…, and most last-mile numbers).
 */
const db = require('../db');

const list = (v) => (Array.isArray(v) ? v : []);
const now = () => Date.now();
const t = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const MILESTONES = [5, 6, 10, 12];

// What each step means, from the carrier's code first, its words second
const RULES = [
  [13, /SIGN_?FAIL|DELIVERY_?FAIL|RETURN_?(TO_)?SENDER|RTS|EXCEPTION/i, /(fail|unsuccessful|could not|couldn't|unable|not).{0,25}deliver|deliver.{0,25}(fail|unsuccessful|attempt)|return(ed|ing)? to (the )?sender|refused|undeliverable|address (is )?(incorrect|incomplete|unknown)|no se pudo entregar|zustellung nicht möglich|non consegnat|échec de (la )?livraison|派送失败|退回/i],
  [12, /SIGNED|DELIVERED|GTMS_SIGN/i, /\bdelivered\b|signed (for|by)|has been signed|entregado|zugestellt|consegnato|livré|签收|妥投/i],
  [10, /DO_DEPART|OUT_FOR_DELIVERY|DELIVERING|GTMS_DO/i, /out for delivery|on (its|the) way to (you|the recipient)|with (the )?(courier|driver) for delivery|on (the )?(delivery )?vehicle|en reparto|in zustellung|in consegna|en cours de livraison|派送中|派件/i],
  [6, /CC_IM|LH_ARRIVE|ARRIVE.*DEST|GTMS_ACCEPT|IMPORT/i, /arriv\w* (at|in) (the )?(destination|your|local)|arrived in (the )?destination|import (customs|clearance)|customs clearance (started|completed|complete)|cleared customs|received by (the )?(local|destination)|handed over to (the )?(local|last.?mile)|inbound in destination|arrived at (the )?(local )?(delivery|post)|llegada al país de destino|im zielland|arrivato nel paese|arrivé dans le pays/i],
  [5, /LH_HO|LH_DEPART|CC_EX|DEPART.*ORIGIN|EXPORT/i, /depart\w* (from )?(the )?(origin|country|airport|departure)|(left|leaving|leave) .{0,20}(departure|origin) (country|region|airport)|left the (origin|country)|export (customs|clearance)|(handed|hand) over to (the )?(airline|carrier for export|linehaul)|flight|leave the (origin|departure)|in transit to (the )?destination country|despegue|abflug|partito dal paese|a quitté le pays/i]
];

/** One step → milestone code (5, 6, 10, 12, 13) or null. */
function stepCode(e) {
  const code = String(e.action || ''); const text = String(e.text || '');
  for (const [c, codeRe, textRe] of RULES) if ((code && codeRe.test(code)) || textRe.test(text)) return c;
  return null;
}

/** Where the parcel is now (steps newest first): the furthest milestone reached; 13 if the newest problem came after it. */
function stageOf(events) {
  let best = 0; let problemAt = -1; let bestAt = -1;
  events.forEach((e, i) => {
    const c = stepCode(e); if (!c) return;
    if (c === 13) { if (problemAt < 0) problemAt = i; return; }
    if (MILESTONES.indexOf(c) > MILESTONES.indexOf(best)) { best = c; bestAt = i; }
  });
  if (best === 12) return 12;
  if (problemAt >= 0 && (bestAt < 0 || problemAt < bestAt)) return 13; // newest relevant step is the problem
  return best || null;
}

/** Cainiao public tracking for up to 10 numbers → { number: [{ text, place, at, action }] newest first }. */
async function fetchCainiao(numbers) {
  const nums = [...new Set(numbers.map((n) => String(n).trim()).filter(Boolean))].slice(0, 10);
  if (!nums.length) return {};
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`https://global.cainiao.com/global/detail.json?mailNos=${encodeURIComponent(nums.join(','))}&lang=en-US`, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Kinan tracking)' } });
    if (!res.ok) throw new Error(`Cainiao ${res.status}`);
    return parseCainiao(await res.json());
  } finally { clearTimeout(timer); }
}
function parseCainiao(j) {
  const out = {};
  for (const m of list(j?.module || j?.data)) {
    const no = String(m.mailNo || m.mailNos || '').trim(); if (!no) continue;
    out[no] = list(m.detailList).map((d) => {
      let text = t(d.standerdDesc || d.desc || d.descTitle, 200); let place = '';
      const br = text.match(/^\[([^\]]{1,80})\]\s*(.*)$/); if (br) { place = br[1]; text = br[2] || text; }
      return { text, place: t(place, 100), at: t(d.timeStr || (d.time ? new Date(Number(d.time)).toISOString().slice(0, 16).replace('T', ' ') : ''), 30), action: t(d.actionCode, 60), ts: Number(d.time) || 0 };
    }).filter((e) => e.text).sort((a, b) => (b.ts - a.ts) || String(b.at).localeCompare(String(a.at))).slice(0, 40).map(({ ts, ...e }) => e);
  }
  return out;
}

let fetcher = fetchCainiao;

/** Refresh the steps of every direct parcel of one order. Notifies the customer at new milestones. */
async function refresh(orderId, { maxAgeMs = 0 } = {}) {
  const o = db.orders.get(orderId); if (!o) return null;
  const subs = (o.sub_orders || []).filter((s) => s.direct && (s.logistics || []).length && ['AE_PLACED', 'AE_PAID', 'AE_SHIPPED'].includes(s.status)
    && !(s.source === 'cj' && (s.track?.events || []).length) && !(s.track && now() - (s.track.at || 0) < maxAgeMs));
  if (!subs.length) return o;
  const byNo = await fetcher(subs.flatMap((s) => s.logistics.map((x) => x.tracking)));
  const changes = [];
  for (const s of subs) {
    const events = s.logistics.flatMap((x) => byNo[x.tracking] || []).slice(0, 40);
    if (!events.length) { changes.push({ ...s, track: { ...(s.track || { status: null, events: [] }), at: now() } }); continue; }
    const stage = stageOf(events); const before = s.track?.status ?? null;
    const sub = { ...s, track: { status: stage || before, events, at: now(), source: 'cainiao' } };
    if (stage === 12) sub.status = 'AE_DELIVERED';
    else if (stage && ['AE_PLACED', 'AE_PAID'].includes(sub.status)) sub.status = 'AE_SHIPPED';
    if (stage === 13 && before !== 13) sub.error = sub.error || 'Delivery problem reported by the carrier — check the tracking';
    changes.push(sub);
    if (stage && stage !== before && !(MILESTONES.indexOf(stage) >= 0 && MILESTONES.indexOf(before) > MILESTONES.indexOf(stage))) sub._notify = stage;
  }
  db.orders.update(o.id, (x) => ({ ...x, sub_orders: x.sub_orders.map((s) => { const c = changes.find((y) => y.outer_purchase_id === s.outer_purchase_id); if (!c) return s; const { _notify, ...keep } = c; return keep; }) }));
  const updated = require('./orders').recompute(o.id);
  const notify = require('../notify');
  for (const c of changes) if (c._notify && c._notify !== 12) notify.trackingStage(db.orders.get(o.id), c, c._notify);
  // a parcel delivered while others of the order are still travelling (the whole order's "delivered" notice comes from recompute)
  for (const c of changes) if (c._notify === 12 && db.orders.get(o.id)?.status !== 'delivered') notify.trackingStage(db.orders.get(o.id), c, 12);
  return updated;
}

/** Every open order with a parcel on its way (timer). */
async function refreshOpen() {
  let n = 0;
  for (const o of db.orders.all((x) => ['procuring', 'shipped', 'attention'].includes(x.status) && (x.sub_orders || []).some((s) => s.direct && (s.logistics || []).length))) {
    try { await refresh(o.id, { maxAgeMs: 50 * 60e3 }); n++; } catch (e) { console.warn('[tracking]', o.id, e.message); }
  }
  return n;
}

/** When someone opens the order: fresh steps if the last look is older than 10 minutes (never waits more than 5 s). */
async function freshen(orderId) {
  try { await Promise.race([refresh(orderId, { maxAgeMs: 10 * 60e3 }), new Promise((r) => setTimeout(r, 5000))]); } catch { /* show what we have */ }
  return db.orders.get(orderId);
}

module.exports = { stepCode, stageOf, parseCainiao, fetchCainiao, refresh, refreshOpen, freshen, MILESTONES, _setFetcher: (f) => { fetcher = f || fetchCainiao; } };

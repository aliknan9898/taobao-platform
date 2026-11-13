// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Sale campaigns (Black Friday, Cyber Monday…): for a few days the daily deals get bigger, more products and deeper
 * discounts (still above cost), the shop shows a banner with a countdown, and shoppers who allowed notifications get one
 * message when the sale opens. A week before, the shop shows a "starts in" teaser.
 *   CAMPAIGNS_JSON  optional list to replace the built-in one: [{ id, name, name_ar, start, end, count, max_pct, min_margin }]
 *                   start/end are Malta times "YYYY-MM-DDTHH:MM".
 */
const db = require('../db');

const TZ = 'Europe/Malta';
const BUILT_IN = [
  { id: 'blackfriday2026', name: 'Black Friday', name_ar: 'الجمعة السوداء', start: '2026-11-27T00:00', end: '2026-12-01T00:00', count: 40, max_pct: 35, min_margin: 1.15, teaser_days: 7 }
];

/** "YYYY-MM-DDTHH:MM" in Malta → epoch ms (Malta is UTC+1 in winter, UTC+2 in summer). */
function maltaTime(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return guess - (shown - guess);
}

function all() {
  let list = BUILT_IN;
  try { if (process.env.CAMPAIGNS_JSON) list = JSON.parse(process.env.CAMPAIGNS_JSON); } catch { list = BUILT_IN; }
  return (Array.isArray(list) ? list : []).map((c) => ({
    id: String(c.id), name: String(c.name || 'Sale'), name_ar: String(c.name_ar || c.name || 'تخفيضات'),
    starts: maltaTime(c.start), ends: maltaTime(c.end),
    count: Math.min(80, Math.max(1, Number(c.count) || 40)), max_pct: Math.min(60, Math.max(5, Number(c.max_pct) || 30)),
    min_margin: Math.max(1.05, Number(c.min_margin) || 1.15), teaser_days: Math.max(0, Number(c.teaser_days ?? 7))
  })).filter((c) => c.starts < c.ends);
}

/** The campaign running now (or null). */
function active(now = Date.now()) { return all().find((c) => now >= c.starts && now < c.ends) || null; }
/** The next campaign whose teaser is showing (or null). */
function upcoming(now = Date.now()) { return all().filter((c) => now < c.starts && now >= c.starts - c.teaser_days * 86400e3).sort((a, b) => a.starts - b.starts)[0] || null; }

/** For the shop: the live sale or the one about to start. */
function publicInfo(now = Date.now()) {
  const c = active(now) || upcoming(now);
  if (!c) return null;
  return { id: c.id, name: c.name, name_ar: c.name_ar, starts: c.starts, ends: c.ends, live: now >= c.starts, max_pct: c.max_pct };
}

/** Once per campaign, when it opens: a notification to every shopper who allowed them. */
function announce(c) {
  const id = `campaign_${c.id}`;
  if (db.settings.get(id)) return 0;
  db.settings.insert({ id, announced_at: Date.now() });
  const push = require('../push');
  const users = [...new Set(db.push_subs.all().map((s) => s.user_id))];
  for (const u of users) {
    try {
      push.toUser(u, {
        title: `🖤 ${c.name} is on at Kinan`, body: `Up to ${c.max_pct}% off — new deals every day until ${new Date(c.ends - 1).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'long' })}.`,
        url: '/#/deals', tag: id, ar: { title: `🖤 ${c.name_ar} بدأت في كنان`, body: `خصومات حتى ${c.max_pct}٪، وعروض جديدة كل يوم.` }
      });
    } catch { /* one bad subscription must not stop the rest */ }
  }
  console.log(`[campaigns] ${c.name}: announced to ${users.length} shopper(s)`);
  return users.length;
}

module.exports = { all, active, upcoming, publicInfo, announce, maltaTime };

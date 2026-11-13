// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Telegram for the owner: linking the bot without copying ids, and a short daily report.
 *  - TELEGRAM_BOT_TOKEN is set on the server (from @BotFather). The admin shows a link t.me/<bot>?start=<code>; opening it
 *    and pressing Start sends "/start <code>" to the bot, Kinan sees it (getUpdates) and keeps that chat. Only the
 *    matching code links, so a stranger writing to the bot cannot take the alerts.
 *  - Every morning (TELEGRAM_REPORT_HOUR, 9:00 Malta) a report: orders and sales, orders waiting for Kinan, CJ, eBay,
 *    the AI, new products, problems.
 */
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../auth');

const SID = 'telegram';
const TZ = 'Europe/Malta';
// Pasted tokens often carry spaces or a "bot" prefix: keep only the token itself (digits:letters)
const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').replace(/\s+/g, '').replace(/^bot/i, '');
const st = () => db.settings.get(SID) || {};
function save(p) { return db.settings.get(SID) ? db.settings.update(SID, p) : db.settings.insert({ id: SID, ...p }); }

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    const bad = r.status === 401 || r.status === 404;
    const hint = bad ? (/^\d{6,}:[\w-]{30,}$/.test(token()) ? ' — this token is not valid (revoked?). Get the current one from @BotFather.' : ' — the token does not look right: it should be digits, a colon, then about 35 letters, with no spaces.') : '';
    throw httpError(bad ? 400 : 502, `Telegram: ${j.description || r.status}${hint}`);
  }
  return j.result;
}

/** Bot name (cached) and the one-time link code. */
async function status() {
  const s = st();
  const out = { token: Boolean(token()), linked: Boolean(require('../push').tgChat()), from_env: Boolean(process.env.TELEGRAM_CHAT_ID), report_hour: hour(), last_report: s.last_report || null };
  if (!out.token) return out;
  let bot = s.bot;
  if (!bot || s.bot_token_tail !== token().slice(-6)) {
    try { const me = await tg('getMe'); bot = me.username; save({ bot, bot_token_tail: token().slice(-6) }); } catch (e) { return { ...out, error: e.message }; }
  }
  out.bot = bot;
  if (!out.linked) {
    let code = s.code;
    if (!code || Date.now() - (s.code_at || 0) > 86400e3) { code = crypto.randomBytes(4).toString('hex'); save({ code, code_at: Date.now() }); }
    out.link = `https://t.me/${bot}?start=${code}`;
  }
  return out;
}

/** While not linked: look at the messages the bot received for "/start <code>". */
let busy = false;
async function poll() {
  if (busy || !token() || require('../push').tgChat()) return null;
  const s = st(); if (!s.code) return null;
  busy = true;
  try {
    const ups = await tg('getUpdates', { offset: (s.update_offset || 0), timeout: 0, allowed_updates: ['message'] });
    let linked = null;
    for (const u of ups || []) {
      save({ update_offset: u.update_id + 1 });
      const m = u.message; if (!m || m.chat?.type !== 'private') continue;
      if (String(m.text || '').trim() === `/start ${s.code}` || String(m.text || '').trim() === s.code) { linked = m.chat; break; }
    }
    if (!linked) return null;
    save({ chat_id: String(linked.id), linked_at: Date.now(), linked_name: [linked.first_name, linked.last_name].filter(Boolean).join(' ') || linked.username || '', code: null });
    require('../push').telegram('✅ Kinan is connected. You will get alerts here (new orders, problems) and a short report every morning.');
    console.log('[telegram] linked to the owner’s chat');
    return true;
  } finally { busy = false; }
}

function unlink() { save({ chat_id: null, code: null }); return { ok: true }; }
function test() { if (!require('../push').tgOn()) throw httpError(409, 'Telegram is not linked yet'); require('../push').telegram('👋 Test message from Kinan — Telegram works.'); return { sent: true }; }

// ---------------- daily report ----------------

const hour = () => Math.min(23, Math.max(0, Math.floor(Number(process.env.TELEGRAM_REPORT_HOUR ?? 9))));
function malta(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const n2 = (v) => Math.round(Number(v) * 100) / 100;

function report(now = Date.now()) {
  const { config } = require('../config');
  const cur = String(config.currency || 'usd').toUpperCase();
  const since = now - 86400e3;
  const paid = db.orders.all((o) => o.paid_at && o.paid_at >= since);
  const sales = n2(paid.reduce((a, o) => a + (Number(o.total) || 0), 0));
  const ebayOrders = paid.filter((o) => o.channel === 'ebay').length;
  const open = db.orders.all((o) => o.paid_at && !['shipped', 'delivered', 'cancelled', 'refunded'].includes(o.status));
  const stuck = open.filter((o) => now - o.paid_at > 3 * 86400e3);
  const lines = [`☀️ Kinan — ${malta(now).day}`, '', `🛒 Last 24 h: ${paid.length} paid order(s), ${sales} ${cur}${ebayOrders ? ` (${ebayOrders} from eBay)` : ''}`];
  if (open.length) lines.push(`📦 Being handled: ${open.length}${stuck.length ? ` — ⚠️ ${stuck.length} paid more than 3 days ago` : ''}`);
  const newProducts = db.listings.all((l) => l.status === 'active' && (l.created_at || 0) >= since).length;
  const live = db.listings.all((l) => l.status === 'active').length;
  lines.push(`🧺 Products live: ${live}${newProducts ? ` (+${newProducts} new)` : ''}`);
  try {
    const u = require('../cj/client').usage();
    lines.push(`🔑 CJ background: ${u.background_calls}/${u.background_limit} calls${u.points_out_until ? ' — ⚠️ CJ points used up until the new CJ day' : ''}`);
  } catch { /* CJ off */ }
  try {
    const es = require('../ebay/client').status();
    if (es.configured) {
      const onEbay = db.listings.all((l) => l.ebay?.listing_id).length;
      const failed = db.listings.all((l) => l.ebay?.error && !l.ebay?.listing_id);
      const hold = failed.some((l) => /hold has been placed/i.test(l.ebay.error));
      lines.push(`🏷 eBay: ${es.connected ? `connected${es.account ? ` as ${es.account}` : ''}` : '⚠️ not connected'} · ${onEbay} listed${hold ? ' — ⚠️ account on hold (payment): fix in eBay Seller Hub → Payments' : failed.length ? ` · ${failed.length} not listed` : ''}`);
    }
  } catch { /* eBay off */ }
  try {
    const d = require('./deals').publicDeals();
    if (d) lines.push(`🔥 Deals today: ${d.count}${d.campaign ? ' (sale campaign)' : ''}`);
    const c = require('./campaigns').publicInfo(now);
    if (c && !c.live) lines.push(`🖤 ${c.name} starts in ${Math.ceil((c.starts - now) / 86400e3)} day(s)`);
  } catch { /* optional */ }
  try {
    const k = require('./keywords').status?.();
    if (k && k.connected && k.last_error) lines.push(`🔎 Google keywords: ⚠️ ${String(k.last_error).slice(0, 120)}`);
  } catch { /* optional */ }
  try { if (!require('./gpsr').ready()) lines.push('🛡 Product safety (GPSR) details are not filled in — admin → Product safety'); } catch { /* optional */ }
  const q = db.questions?.all ? db.questions.all((x) => !x.answer && x.status !== 'hidden').length : 0;
  if (q) lines.push(`❓ ${q} shopper question(s) waiting for an answer`);
  lines.push('', `${config.publicBaseUrl}/admin`);
  return lines.join('\n');
}

/** Every few minutes: link the bot if needed; send the morning report once a day. */
async function tick(now = Date.now()) {
  if (!token()) return null;
  await poll().catch((e) => console.warn('[telegram] link:', e.message));
  const push = require('../push');
  if (!push.tgOn()) return null;
  const m = malta(now);
  if (m.hour < hour() || st().last_report === m.day) return null;
  save({ last_report: m.day });
  push.telegram(report(now));
  return true;
}

module.exports = { status, poll, unlink, test, report, tick, malta };

'use strict';
/**
 * Delivery check of the published catalogue: every live CJ / AliExpress product must reach the customer in at most
 * MAX_DAYS (15) days — to the UK or to the EU. Products whose fastest delivery is longer (or that can no longer be
 * delivered) are paused (hidden from the shop, not deleted: they can be switched back on). Known delivery times are
 * reused; unknown ones are asked from CJ / AliExpress. Works through the catalogue in the background, resuming where
 * it stopped (CJ points), and reports on Telegram when done.
 */
const db = require('../db');

const ID = 'delivery_audit';
const MAX_DAYS = () => Math.min(30, Math.max(3, Number(process.env.MAX_DELIVERY_DAYS) || 15));
const now = () => Date.now();
const state = () => db.settings.get(ID) || {};
const save = (patch) => (db.settings.get(ID) ? db.settings.update(ID, patch) : db.settings.insert({ id: ID, ...patch }));

const live = () => db.listings.all((l) => l.status === 'active' && ['cj', 'aliexpress'].includes(l.source)).sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** Fastest known delivery (days) to the UK and to the EU, asking the supplier when it is not known yet. */
async function fastest(l, max) {
  const so = l.sourcing || {};
  let gb = Number(so.gb_days) || null; let eu = Number(so.eu_days) || null;
  if (gb && eu) return { gb, eu, asked: false };
  if (l.source === 'cj') {
    const cj = require('./cj'); const S = require('./sourcing');
    if (!gb) { const d = await S.delivery(cj, l, 'GB', max); gb = d?.max || (d ? max : null); if (!d) gb = gb || 99; }
    if (!eu && l.cj_from !== 'GB') { const d = await S.delivery(cj, l, l.cj_from === 'DE' ? 'FR' : 'DE', max); eu = d?.max || (d ? max : null); if (!d) eu = eu || 99; }
  } else {
    const A = require('./aeSourcing');
    const s = l.skus.find((k) => k.stock > 0 && k.ae_sku_id) || l.skus.find((k) => k.ae_sku_id);
    if (s) {
      if (!gb) gb = (await A.freight(l.ae_product_id, s.ae_sku_id, 'GB'))?.days || 99;
      if (!eu) eu = (await A.freight(l.ae_product_id, s.ae_sku_id, 'DE'))?.days || 99;
    }
  }
  return { gb, eu, asked: true };
}

let running = false;
/** One pass (resumes from the last product checked). */
async function run({ restart = false } = {}) {
  if (running) return { skipped: 'running' };
  // Once any market enforces per-country delivery eligibility (services/eligibility.js), products are no longer paused
  // for the whole shop because of their UK/EU delivery time: each country decides for itself.
  if (require('./eligibility').anyEnforced()) return { skipped: 'per-country eligibility is enforced' };
  running = true;
  const max = MAX_DAYS();
  const st0 = state();
  const st = restart || !st0.active ? { active: true, started_at: now(), cursor: '', checked: 0, paused: [], unknown: 0 } : { ...st0 };
  save(st);
  try {
    for (const l of live().filter((x) => String(x.id) > String(st.cursor || ''))) {
      let f;
      try { f = await fastest(l, max); } catch (e) {
        // CJ out of points / AliExpress busy: stop here and carry on next time
        if (/points|limit|frequen|busy|stopped answering/i.test(e.message)) { save({ ...st, waiting: e.message.slice(0, 120) }); return { waiting: true, ...st }; }
        st.unknown++; st.cursor = l.id; continue;
      }
      st.checked++; st.cursor = l.id;
      const best = Math.min(f.gb || 99, f.eu || 99);
      if (f.asked) db.listings.update(l.id, (x) => ({ ...x, sourcing: { ...(x.sourcing || {}), ...(f.gb && f.gb < 99 ? { gb_days: f.gb } : {}), ...(f.eu && f.eu < 99 ? { eu_days: f.eu } : {}), days_checked_at: now() } }));
      if (best > max) {
        db.listings.update(l.id, { status: 'paused', paused_reason: `Delivery takes more than ${max} days`, paused_by: 'delivery_audit', paused_at: now() });
        st.paused.push({ id: l.id, title: String(l.title).slice(0, 70), days: best >= 99 ? null : best, source: l.source });
      }
      if (st.checked % 20 === 0) save({ ...st, waiting: null });
    }
    st.active = false; st.finished_at = now(); st.waiting = null;
    save(st);
    console.log(`[delivery-audit] done: ${st.checked} checked, ${st.paused.length} hidden (over ${max} days)`);
    const lines = [`🚚 Delivery check of the shop — done`, `Checked ${st.checked} live CJ/AliExpress products · rule: at most ${max} days to the UK or the EU`, `Hidden (paused, not deleted): ${st.paused.length}`];
    for (const x of st.paused.slice(0, 40)) lines.push(`• ${x.title} — ${x.days ? `${x.days} days` : 'no delivery option'} (${x.source})`);
    if (st.paused.length > 40) lines.push(`…and ${st.paused.length - 40} more (Admin → Products, filter Paused)`);
    await require('../push').telegram(lines.join('\n'));
    return st;
  } finally { running = false; }
}
/** Background: continue an unfinished pass. */
async function tick() { if (state().active) return run(); return null; }
function status() { const s = state(); return { active: Boolean(s.active), checked: s.checked || 0, hidden: (s.paused || []).length, waiting: s.waiting || null, finished_at: s.finished_at || null, max_days: MAX_DAYS() }; }

module.exports = { run, tick, status, fastest, MAX_DAYS };

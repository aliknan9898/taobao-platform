// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Arabic product titles and descriptions.
 * - Sellers can write the Arabic text themselves (kept as is, never overwritten).
 * - Otherwise, when a translation service is set up, live products are translated automatically
 *   (from Chinese or English) and re-translated when the seller changes the text.
 * Services: DeepL (DEEPL_API_KEY; free keys end in ":fx") or Google Cloud Translation (GOOGLE_TRANSLATE_API_KEY).
 */
const crypto = require('crypto');
const db = require('../db');

const e = process.env;
function provider() {
  if (e.DEEPL_API_KEY) return 'deepl';
  if (e.GOOGLE_TRANSLATE_API_KEY) return 'google';
  return null;
}

/** Translate a few texts to `target` ('ar'). Returns texts in the same order. */
async function translate(texts, target = 'ar') {
  const p = provider();
  if (!p) throw new Error('No translation service set up');
  if (p === 'deepl') {
    const host = /:fx$/.test(e.DEEPL_API_KEY) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const r = await fetch(`${host}/v2/translate`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `DeepL-Auth-Key ${e.DEEPL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts, target_lang: target.toUpperCase() })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`DeepL ${r.status}: ${j.message || ''}`);
    return j.translations.map((t) => t.text);
  }
  const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(e.GOOGLE_TRANSLATE_API_KEY)}`, {
    method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target, format: 'text' })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Translate ${r.status}: ${j.error?.message || ''}`);
  return j.data.translations.map((t) => t.translatedText);
}

const fingerprint = (l) => crypto.createHash('sha1').update(`${l.title}\n${l.description || ''}`).digest('hex').slice(0, 16);
const needs = (l) => !l.ar_manual && l.ar_src !== fingerprint(l);

/** Translate one product if its Arabic text is missing or out of date. */
async function translateListing(id) {
  const l = db.listings.get(id);
  if (!l || !provider() || !needs(l)) return l;
  const desc = String(l.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
  const [title, description] = await translate([l.title, desc || ' '], 'ar');
  return db.listings.update(l.id, { title_ar: String(title || '').slice(0, 300), description_ar: desc ? String(description || '').slice(0, 6000) : '', ar_src: fingerprint(l), ar_auto: true });
}

let running = false;
/** Background job: translate live products that need it, a few at a time. */
async function translatePending(max = 20) {
  if (running || !provider()) return 0;
  running = true; let n = 0;
  try {
    for (const l of db.listings.all((x) => ['active', 'private'].includes(x.status) && needs(x)).slice(0, max)) {
      try { await translateListing(l.id); n++; } catch (err) { console.warn('[translate]', err.message); break; }
    }
  } finally { running = false; }
  if (n) console.log(`[translate] ${n} product(s) translated to Arabic`);
  return n;
}

/** Seller-written Arabic text (empty = go back to automatic translation). */
function manualPatch(b, existing) {
  const t = String(b.title_ar ?? '').trim().slice(0, 300);
  const d = String(b.description_ar ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 6000);
  if (b.title_ar === undefined && b.description_ar === undefined) return {};
  if (!t) return { ar_manual: false, ...(existing?.ar_manual ? { title_ar: '', description_ar: '', ar_src: null } : {}) };
  return { title_ar: t, description_ar: d, ar_manual: true };
}

module.exports = { provider, translate, translateListing, translatePending, manualPatch };

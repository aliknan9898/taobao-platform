// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * French, German, Italian and Spanish for the shop and seller pages.
 * The English phrases (the same ones the Arabic dictionary in public/assets/i18n.js covers, plus department names)
 * are translated by Kinan's AI a batch at a time and kept in settings; /i18n/<lang>.json serves them to the browser,
 * which shows the page in the phone's language. New phrases are translated as they appear (every 10 minutes).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const db = require('../db');

const LANGS = { fr: 'French', de: 'German', it: 'Italian', es: 'Spanish' };
const BATCH = 60;

let cache = null;
/** Every English phrase to translate (read from the Arabic dictionary file, so both stay in step). */
function source() {
  if (cache) return cache;
  const code = fs.readFileSync(path.join(__dirname, '../../public/assets/i18n.js'), 'utf8');
  const noop = () => {};
  const el = { setAttribute: noop, getAttribute: () => null };
  const sandbox = { window: {}, navigator: { language: 'en', languages: ['en'] }, localStorage: { getItem: () => 'en', setItem: noop, removeItem: noop }, document: { documentElement: el, readyState: 'loading', addEventListener: noop, body: null, title: '' }, location: { reload: noop }, fetch: () => Promise.reject(new Error('no')), console };
  vm.runInNewContext(code, sandbox, { timeout: 2000 });
  const src = sandbox.window.KinanLang._source();
  const extra = [];
  try {
    for (const d of Object.values(require('./sourcing').DEPARTMENTS)) { extra.push(d.en, ...Object.values(d.groups).map((g) => g.en)); }
    extra.push(...require('./shipping').CATEGORIES.map(([, en]) => en), 'Shop by department', 'See all', 'Phone language', 'Automatic');
  } catch { /* optional */ }
  const keys = [...new Set([...src.keys, ...src.templates, ...extra])].filter((k) => k && /[A-Za-z]/.test(k) && k.length <= 600);
  cache = { keys, hash: crypto.createHash('sha1').update(keys.join('\n')).digest('hex').slice(0, 10) };
  return cache;
}

const sid = (l) => `ui_${l}`;
function dict(lang) { return db.settings.get(sid(lang))?.dict || {}; }

/** The page's dictionary for one language (only phrases still in use). */
function serve(lang) {
  if (!LANGS[lang]) return null;
  const { keys, hash } = source(); const d = dict(lang); const out = {};
  for (const k of keys) if (d[k]) out[k] = d[k];
  return { lang, v: `${hash}-${Object.keys(out).length}`, total: keys.length, done: Object.keys(out).length, dict: out };
}

const SCHEMA = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, t: { type: 'string' } }, required: ['i', 't'] } } }, required: ['items'] };

async function translateBatch(lang, keys) {
  const ai = require('./ai');
  const out = await ai.structured({
    system: `You translate the interface of Kinan, an online marketplace (shop, cart, checkout, orders, seller centre), from English to ${LANGS[lang]}. Write natural, short, friendly ${LANGS[lang]} as big shops like Amazon use. Keep exactly: placeholders like {0} {1}, numbers, currency signs, symbols (· → × ★ ✓ ✕ …), line breaks, and brand/product names (Kinan, Stripe, Taobao, Tmall, 1688, AliExpress, CJ, eBay, Google, Apple Pay, WhatsApp, PayPal). Keep the same capitalisation style (a button stays a short button label). Do not add quotes or notes.`,
    name: 'ui_translations', schema: SCHEMA, maxTokens: 6000, timeoutMs: 90000, kind: 'translate',
    text: `Translate each text. Answer with every index.\n${keys.map((k, i) => `${i}\t${k.replace(/\n/g, '\\n')}`).join('\n')}`
  });
  const res = {};
  for (const x of out.items || []) {
    const k = keys[x.i]; let t = String(x.t || '').replace(/\\n/g, '\n').trim();
    if (!k || !t) continue;
    const want = (k.match(/\{\d+\}/g) || []).sort().join(); const got = (t.match(/\{\d+\}/g) || []).sort().join();
    if (want !== got) continue; // lost a blank: keep English for this one
    res[k] = t.slice(0, 900);
  }
  return res;
}

let busy = false;
/** Every 10 minutes: translate up to `batches` batches per language of phrases not translated yet. */
async function tick({ batches = 2 } = {}) {
  if (busy || !require('./ai').enabled()) return { skipped: true };
  busy = true; const done = {};
  try {
    const { keys } = source();
    for (const lang of Object.keys(LANGS)) {
      const d = dict(lang); const missing = keys.filter((k) => !d[k]);
      done[lang] = 0;
      for (let b = 0; b < batches && missing.length; b++) {
        const part = missing.splice(0, BATCH);
        try {
          const t = await translateBatch(lang, part);
          const cur = db.settings.get(sid(lang));
          const next = { ...(cur?.dict || {}), ...t };
          if (cur) db.settings.update(sid(lang), { dict: next, at: Date.now() }); else db.settings.insert({ id: sid(lang), dict: next, at: Date.now() });
          done[lang] += Object.keys(t).length;
        } catch (e) { console.warn(`[i18n] ${lang}:`, e.message); break; }
      }
    }
  } finally { busy = false; }
  const n = Object.values(done).reduce((a, x) => a + x, 0);
  if (n) console.log(`[i18n] translated ${JSON.stringify(done)}`);
  return done;
}

function status() {
  const { keys } = source();
  return Object.fromEntries(Object.entries(LANGS).map(([l, name]) => { const d = dict(l); return [l, { name, done: keys.filter((k) => d[k]).length, total: keys.length }]; }));
}

module.exports = { LANGS, source, serve, tick, status, translateBatch, _reset: () => { cache = null; } };

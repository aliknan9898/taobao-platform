// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * AI for product listings. Two providers:
 * - Google Gemini (GEMINI_API_KEY, free tier from Google AI Studio; GEMINI_MODEL, default gemini-3.5-flash-lite)
 * - Anthropic Claude (ANTHROPIC_API_KEY; AI_MODEL, default claude-haiku-5-5 — about 20× cheaper than Sonnet)
 * With both keys, Gemini is used unless AI_PROVIDER=claude.
 * Used by: the seller's listing assistant (suggestions only — nothing is saved until they press Save),
 * the automatic product review (services/autoreview.js), Kinan's catalogue copy and the Christmas Shop copy.
 * AI_DAILY_LIMIT: listing-assistant uses per shop per day (default 40). Every call's tokens are counted per day/month (usage()).
 */
const db = require('../db');
const { httpError } = require('../auth');

const API = 'https://api.anthropic.com/v1/messages';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
function provider() {
  const want = String(process.env.AI_PROVIDER || '').toLowerCase();
  const gem = Boolean(process.env.GEMINI_API_KEY); const cla = Boolean(process.env.ANTHROPIC_API_KEY);
  if (want === 'claude' && cla) return 'claude';
  if (want === 'gemini' && gem) return 'gemini';
  return gem ? 'gemini' : cla ? 'claude' : null;
}
const enabled = () => Boolean(provider());
const model = () => (provider() === 'gemini' ? process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite' : process.env.AI_MODEL || 'claude-haiku-5-5');
const limit = () => Math.max(1, Number(process.env.AI_DAILY_LIMIT) || 40);
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const s = (v, n) => String(v ?? '').trim().slice(0, n);

// ---------- usage & cost (USD per million tokens: input / output) ----------
const PRICES = { haiku: [0.10, 0.50], sonnet: [2, 10], opus: [4, 20], gemini: [0, 0] }; // Gemini: free tier
const priceOf = (m) => PRICES[(String(m).match(/haiku|sonnet|opus|gemini/) || ['sonnet'])[0]];
function record(m, usage, kind) {
  if (!usage) return;
  const [pi, po] = priceOf(m);
  const inT = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outT = usage.output_tokens || 0;
  const cost = (inT * pi + outT * po) / 1e6;
  const now = new Date();
  for (const id of [`set_ai_usage_d_${now.toISOString().slice(0, 10)}`, `set_ai_usage_m_${now.toISOString().slice(0, 7)}`]) {
    const cur = db.settings.get(id) || { calls: 0, input: 0, output: 0, cost: 0, kinds: {} };
    const doc = { calls: cur.calls + 1, input: cur.input + inT, output: cur.output + outT, cost: Math.round((cur.cost + cost) * 1e6) / 1e6, kinds: { ...(cur.kinds || {}), [kind]: ((cur.kinds || {})[kind] || 0) + 1 } };
    db.settings.get(id) ? db.settings.update(id, doc) : db.settings.insert({ id, ...doc });
  }
}
/** Today's and this month's AI calls, tokens and estimated cost (USD). */
function usage() {
  const now = new Date(); const blank = { calls: 0, input: 0, output: 0, cost: 0, kinds: {} };
  const pick = (id) => { const x = db.settings.get(id); return x ? { calls: x.calls, input: x.input, output: x.output, cost: x.cost, kinds: x.kinds || {} } : blank; };
  return { enabled: enabled(), model: model(), price_per_million: { input: priceOf(model())[0], output: priceOf(model())[1] }, daily_limit_per_shop: limit(),
    today: pick(`set_ai_usage_d_${now.toISOString().slice(0, 10)}`), month: pick(`set_ai_usage_m_${now.toISOString().slice(0, 7)}`) };
}

/** Search keywords as stored on a listing: lower case, unique, at most 15 of up to 40 characters. */
function cleanKeywords(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,،\n]/);
  const out = [];
  for (const k of list) {
    const w = String(k).replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
    if (w.length >= 2 && !out.includes(w)) out.push(w);
    if (out.length >= 15) break;
  }
  return out;
}

const TOOL = {
  name: 'listing_suggestions',
  description: 'Return the improved listing and the photo check.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Clear English product title, 40–110 characters.' },
      description: { type: 'string', description: 'English description, plain text: 1–2 short sentences, then "• " feature lines (material, size, what is in the box). 400–1200 characters.' },
      title_ar: { type: 'string', description: 'Natural Arabic title.' },
      description_ar: { type: 'string', description: 'Natural Arabic description with the same facts and layout.' },
      keywords: { type: 'array', items: { type: 'string' }, description: '8–14 search keywords customers would type: English first, then a few Arabic. Lower case, 1–3 words each.' },
      category: { type: 'string', description: 'Best category id from the list given, or empty.' },
      photos: {
        type: 'array',
        description: 'One entry per photo, in the order received.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: '1-based photo number.' },
            verdict: { type: 'string', enum: ['good', 'fix', 'remove'] },
            issues: { type: 'array', items: { type: 'string' }, description: 'Short problems found, in the seller language. Empty when good.' }
          },
          required: ['index', 'verdict', 'issues']
        }
      },
      tips: { type: 'array', items: { type: 'string' }, description: 'Up to 4 short tips for the seller, in the seller language (e.g. add a size chart, missing weight).' }
    },
    required: ['title', 'description', 'title_ar', 'description_ar', 'keywords', 'photos', 'tips']
  }
};

function system(lang, categories) {
  return [
    'You help sellers on Kinan, an online marketplace that delivers to customers in Europe, the UK and worldwide. Prices on Kinan already include shipping.',
    'Rewrite the seller\'s product listing so it is clear, honest and easy to find. Rules:',
    '- Use ONLY facts given by the seller or clearly visible in the photos. Never invent materials, sizes, certifications, brands, warranties or numbers. If a fact is unknown, leave it out.',
    '- Do not mention China, Taobao, Tmall, 1688, AliExpress, CJ, dropshipping, suppliers, factories or where the item ships from.',
    '- No brand or trademark names unless the seller says the product is that brand. No ALL CAPS, emoji, prices, shipping promises or superlatives like "best".',
    '- Plain text only (no HTML, no markdown headings).',
    '- Photo check, for each photo: "remove" for another shop\'s watermark or logo, a counterfeit brand logo, explicit or offensive content, a photo that shows a different product, or a mostly-text advert; "fix" for Chinese or other foreign-language text on the image, blur or very low resolution, heavy collage, busy background that hides the product, or borders/stickers; otherwise "good".',
    `- Write photo issues and tips in ${lang === 'ar' ? 'Arabic' : 'English'}.`,
    `- Category ids you may use: ${categories.join(', ')}.`,
  ].join('\n');
}

function imageBlock(u) {
  const m = String(u).match(IMG_RE);
  if (m) return { type: 'image', source: { type: 'base64', media_type: `image/${m[1]}`, data: m[2] } };
  if (/^https:\/\/[^\s"'<>]{8,500}$/.test(u)) return { type: 'image', source: { type: 'url', url: u } };
  return null;
}

/** Image bytes for Gemini, which needs them inline: data URLs as they are, HTTPS photos downloaded (up to 4 MB). */
async function inlineImage(u) {
  const m = String(u).match(IMG_RE);
  if (m) return { inline_data: { mime_type: `image/${m[1]}`, data: m[2] } };
  if (!/^https:\/\/[^\s"'<>]{8,500}$/.test(u)) return null;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
    return { inline_data: { mime_type: type, data: buf.toString('base64') } };
  } catch { return null; }
}

/**
 * Ask the configured AI for an answer that follows `schema` (JSON Schema).
 * images: data URLs or HTTPS links (bad ones are skipped). Returns the parsed object.
 * Errors carry status 429 when the AI is busy or the free quota is used up.
 */
async function structured({ system, name, description = '', schema, text, images = [], maxTokens = 2500, timeoutMs = 60000, kind = 'other' }) {
  const p = provider();
  if (!p) throw httpError(503, 'The AI assistant is not switched on yet');
  if (p === 'claude') {
    const blocks = images.map(imageBlock).filter(Boolean);
    const tool = { name, description: description || 'Return the answer.', input_schema: schema };
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model(), max_tokens: maxTokens, system: `${system}\nAlways answer by calling the ${name} tool.`, tools: [tool], tool_choice: { type: 'tool', name }, messages: [{ role: 'user', content: blocks.length ? [...blocks, { type: 'text', text }] : text }] }),
      signal: AbortSignal.timeout(timeoutMs)
    }).catch((e) => { throw httpError(502, `The AI assistant could not be reached (${e.message})`); });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[ai] claude', res.status, j.error?.type, j.error?.message);
      throw httpError(res.status === 429 || res.status === 529 ? 429 : 502, res.status === 429 || res.status === 529 ? 'The AI assistant is busy — try again in a minute' : 'The AI assistant could not answer — try again');
    }
    record(model(), j.usage, kind);
    const out = (j.content || []).find((c) => c.type === 'tool_use')?.input;
    if (!out) throw httpError(502, 'The AI assistant could not answer — try again');
    return out;
  }
  // Gemini takes up to ~20 MB per request: keep the photos under 14 MB together
  let total = 0;
  const parts = (await Promise.all(images.map(inlineImage))).filter((x) => x && (total += x.inline_data.data.length) <= 14 * 1024 * 1024);
  // Busy (503) or this model's free quota used (429): try the next model in GEMINI_FALLBACK_MODELS (each has its own free quota)
  const models = [model(), ...String(process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.5-flash,gemini-3-flash-lite').split(',').map((x) => x.trim()).filter((x) => x && x !== model())];
  let res; let j; let used = models[0]; let busy = false; let quota = false;
  for (let m = 0; m < models.length; m++) {
    used = models[m];
    res = await fetch(`${GEMINI_API}/${encodeURIComponent(used)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [...parts, { text }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: Math.max(8192, maxTokens * 2) }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    }).catch((e) => { throw httpError(502, `The AI assistant could not be reached (${e.message})`); });
    j = await res.json().catch(() => ({}));
    if (res.ok) break;
    console.error('[ai] gemini', used, res.status, j.error?.status, j.error?.message);
    if (res.status === 503) busy = true; if (res.status === 429) quota = true;
    if (![429, 503, 404].includes(res.status) || m === models.length - 1) break;
  }
  if (!res.ok) {
    throw httpError(busy || quota ? 429 : 502, quota ? 'The free AI quota is used up for now — try again later' : 'The AI assistant could not answer — try again');
  }
  const um = j.usageMetadata || {};
  record(used, { input_tokens: um.promptTokenCount || 0, output_tokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0) }, kind);
  if (j.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw httpError(502, 'The AI answer was too long — try again');
  const raw = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim();
  try { return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw httpError(502, 'The AI assistant could not answer — try again'); }
}

function useToday(sellerId) {
  const day = new Date().toISOString().slice(0, 10);
  const id = `ai_use_${sellerId}`;
  const cur = db.settings.get(id);
  const n = cur && cur.day === day ? cur.n : 0;
  if (n >= limit()) throw httpError(429, `You have used the AI assistant ${limit()} times today — try again tomorrow`);
  if (cur) db.settings.update(id, { day, n: n + 1 }); else db.settings.insert({ id, day, n: n + 1 });
  return limit() - n - 1;
}

/** Ask Claude for listing suggestions. b = { title, description, options[], category, images[], lang } */
async function assist(seller, b = {}) {
  if (!enabled()) throw httpError(503, 'The AI assistant is not switched on yet');
  const title = s(b.title, 300); const description = s(b.description, 5000);
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 6).map(imageBlock).filter(Boolean); // valid photos (for counting)
  if (title.length < 3 && !description && !images.length) throw httpError(400, 'Write a title or add a photo first');
  const lang = b.lang === 'ar' ? 'ar' : 'en';
  const categories = require('./shipping').CATEGORIES.map(([id]) => id);
  const left = useToday(seller.id);
  const options = (Array.isArray(b.options) ? b.options : []).map((o) => s(o, 80)).filter(Boolean).slice(0, 30);
  const text = [
    `Seller's title: ${title || '(none)'}`,
    `Seller's description: ${description || '(none)'}`,
    options.length ? `Options (size / colour): ${options.join(' | ')}` : '',
    b.category ? `Category chosen: ${s(b.category, 40)}` : '',
    `Photos attached: ${images.length}`
  ].filter(Boolean).join('\n');
  const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 6).map(String).filter((u) => imageBlock(u));
  const out = await structured({ system: system(lang, categories), name: TOOL.name, description: TOOL.description, schema: TOOL.input_schema, text, images: imgs, maxTokens: 2500, kind: 'seller' });
  const cat = categories.includes(out.category) ? out.category : null;
  return {
    title: s(out.title, 200), description: s(out.description, 5000).replace(/<[^>]*>/g, ''),
    title_ar: s(out.title_ar, 300), description_ar: s(out.description_ar, 6000).replace(/<[^>]*>/g, ''),
    keywords: cleanKeywords(out.keywords), category: cat,
    photos: (Array.isArray(out.photos) ? out.photos : []).slice(0, images.length).map((p, i) => ({ index: Number(p.index) || i + 1, verdict: ['good', 'fix', 'remove'].includes(p.verdict) ? p.verdict : 'good', issues: (Array.isArray(p.issues) ? p.issues : []).map((x) => s(x, 200)).slice(0, 4) })),
    tips: (Array.isArray(out.tips) ? out.tips : []).map((x) => s(x, 240)).slice(0, 4),
    uses_left_today: left
  };
}

const COPY_TOOL = {
  name: 'product_copy',
  description: 'Return shop copy for every product, in the order received.',
  input_schema: {
    type: 'object',
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            title: { type: 'string', description: 'Warm, clear English title, 35–80 characters, Title Case, no emoji.' },
            description: { type: 'string', description: 'English, plain text: one inviting sentence, then 3–5 "• " lines with the real facts (material, size, what is in the box, power). 300–800 characters.' },
            title_ar: { type: 'string' }, description_ar: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } },
            ad_line: { type: 'string', description: 'One short social-media ad line in English, up to 70 characters, may use one emoji.' }
          },
          required: ['index', 'title', 'description', 'title_ar', 'description_ar', 'keywords', 'ad_line']
        }
      }
    },
    required: ['products']
  }
};

/**
 * Shop copy for imported products (e.g. the Christmas collection), up to 10 per call.
 * items = [{ title, description, options[] }]; theme = a short note such as "Christmas gifts".
 */
async function copywrite(items, theme = '') {
  if (!enabled()) throw httpError(503, 'The AI assistant is not switched on yet');
  const text = items.slice(0, 10).map((it, i) => `#${i + 1}\nSupplier title: ${s(it.title, 300)}\nSupplier description: ${s(it.description, 1500)}\nOptions: ${(it.options || []).slice(0, 12).join(' | ')}`).join('\n\n');
  const res = await structured({ name: COPY_TOOL.name, description: COPY_TOOL.description, schema: COPY_TOOL.input_schema, text, maxTokens: 6000, timeoutMs: 120000, kind: 'copy',
    system: [
        `You write product copy for Kinan, an online shop for families in Europe and the UK.${theme ? ` Collection: ${theme}.` : ''}`,
        '- Use only facts in the supplier text. Never invent materials, sizes, certifications, brands or numbers; leave unknown facts out.',
        '- Do not mention China, CJ, dropshipping, suppliers, factories, "wholesale", "cross-border", Amazon or other shops.',
        '- No brand or trademark names, no prices, no delivery promises, no ALL CAPS. Plain text.',
        '- Arabic versions say the same thing naturally. Keywords: 8–12, English first then a few Arabic, lower case.'
      ].join('\n') });
  const out = res?.products || [];
  return items.slice(0, 10).map((_, i) => {
    const o = out.find((x) => Number(x.index) === i + 1) || out[i];
    return o ? { title: s(o.title, 120), description: s(o.description, 3000).replace(/<[^>]*>/g, ''), title_ar: s(o.title_ar, 200), description_ar: s(o.description_ar, 4000).replace(/<[^>]*>/g, ''), keywords: cleanKeywords(o.keywords), ad_line: s(o.ad_line, 90) } : null;
  });
}

// ---------- Kinan's own catalogue: rewrite supplier titles/descriptions once ----------
const SETTINGS = 'set_ai_prefs';
const prefs = () => ({ auto: true, ...(db.settings.get(SETTINGS) || {}) });
function savePrefs(b = {}) {
  const doc = { auto: b.auto !== false, updated_at: Date.now() };
  db.settings.get(SETTINGS) ? db.settings.update(SETTINGS, doc) : db.settings.insert({ id: SETTINGS, ...doc });
  return prefs();
}
/** Products of Kinan's own shop (CJ, Banggood, AliExpress, Taobao) whose copy has not been rewritten yet. */
function pending() {
  const kinan = require('./buyforme').systemSeller();
  return db.listings.all((l) => l.seller_id === kinan.id && l.status === 'active' && !l.ai_copy_at && !l.ai_review?.at && !l.xmas); // products checked by the automatic review are done too // seasonal products are written by seasonal.polish()
}
let improving = false;
/** Rewrite up to `max` Kinan products, 8 per call. The previous text is kept in ai_prev for undo. */
async function improveKinan(max = 40) {
  if (!enabled() || improving) return { done: 0, left: pending().length };
  improving = true; let done = 0;
  try {
    const todo = pending().slice(0, max);
    for (let i = 0; i < todo.length; i += 8) {
      const batch = todo.slice(i, i + 8);
      let out;
      try { out = await copywrite(batch.map((l) => ({ title: l.title, description: String(l.description || '').replace(/<[^>]*>/g, ' '), options: (l.skus || []).map((k) => k.props).filter(Boolean) }))); }
      catch (e) { console.warn('[ai] catalogue copy:', e.message); break; }
      batch.forEach((l, k) => {
        const o = out[k];
        if (!o || o.title.length < 10) { db.listings.update(l.id, { ai_copy_at: Date.now(), ai_copy_failed: true }); return; }
        const upd = db.listings.update(l.id, (x) => ({ ...x, ai_prev: { title: x.title, description: x.description, keywords: x.keywords || [] }, title: o.title, description: o.description, keywords: o.keywords.length ? o.keywords : x.keywords, ...(o.title_ar ? { title_ar: o.title_ar, description_ar: o.description_ar } : {}), ai_copy_at: Date.now() }));
        if (o.title_ar) db.listings.update(upd.id, { ar_src: require('./translate').fingerprint(upd), ar_auto: true });
        done++;
      });
    }
  } finally { improving = false; }
  if (done) console.log(`[ai] shop copy rewritten for ${done} Kinan product(s)`);
  return { done, left: pending().length };
}
/** Put back the supplier text of one product. */
function undo(listingId) {
  const l = db.listings.get(listingId);
  if (!l || !l.ai_prev) throw httpError(404, 'Nothing to undo');
  return db.listings.update(l.id, (x) => ({ ...x, title: x.ai_prev.title, description: x.ai_prev.description, keywords: x.ai_prev.keywords, ai_prev: null, ai_undone: true }));
}
function status() { return { ...usage(), prefs: prefs(), pending: pending().length, running: improving }; }
/** Hourly: when switched on, rewrite new Kinan products a few at a time. */
async function tick() {
  if (require('./autoreview').on()) return null; // the automatic review (services/autoreview.js) rewrites every product, Kinan's included
  if (enabled() && prefs().auto) return improveKinan(40); return null;
}

module.exports = { enabled, provider, model, structured, assist, cleanKeywords, copywrite, usage, status, savePrefs, improveKinan, undo, tick, PRICES };

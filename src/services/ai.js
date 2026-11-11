// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * AI listing assistant for sellers (Claude, Anthropic API).
 * From what the seller typed (title, description, options, category) and their photos it suggests:
 * a clear English title and description, Arabic versions, search keywords, a category, and a check of
 * every photo (watermarks, other shops' logos, Chinese text, blur, collages, brand logos, photos that
 * don't match the product). The seller decides what to use — nothing is saved until they press Save.
 * Settings: ANTHROPIC_API_KEY (required), AI_MODEL (default claude-sonnet-5-5), AI_DAILY_LIMIT per shop (default 40).
 */
const db = require('../db');
const { httpError } = require('../auth');

const API = 'https://api.anthropic.com/v1/messages';
const enabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
const model = () => process.env.AI_MODEL || 'claude-sonnet-5-5';
const limit = () => Math.max(1, Number(process.env.AI_DAILY_LIMIT) || 40);
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const s = (v, n) => String(v ?? '').trim().slice(0, n);

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
    'Always answer by calling the listing_suggestions tool.'
  ].join('\n');
}

function imageBlock(u) {
  const m = String(u).match(IMG_RE);
  if (m) return { type: 'image', source: { type: 'base64', media_type: `image/${m[1]}`, data: m[2] } };
  if (/^https:\/\/[^\s"'<>]{8,500}$/.test(u)) return { type: 'image', source: { type: 'url', url: u } };
  return null;
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
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 6).map(imageBlock).filter(Boolean);
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
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model(), max_tokens: 2500, system: system(lang, categories),
      tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: [...images, { type: 'text', text }] }]
    }),
    signal: AbortSignal.timeout(60000)
  }).catch((e) => { throw httpError(502, `The AI assistant could not be reached (${e.message})`); });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[ai]', res.status, j.error?.type, j.error?.message);
    throw httpError(502, res.status === 429 || res.status === 529 ? 'The AI assistant is busy — try again in a minute' : 'The AI assistant could not answer — try again');
  }
  const out = (j.content || []).find((c) => c.type === 'tool_use')?.input;
  if (!out) throw httpError(502, 'The AI assistant could not answer — try again');
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

module.exports = { enabled, assist, cleanKeywords };

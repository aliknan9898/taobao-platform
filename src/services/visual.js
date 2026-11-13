// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Search by photo: the shopper takes or picks a picture, the AI says what the product is
 * (the words a shopper would type, plus a few alternatives), and Kinan finds the closest products.
 * The photo is used for this one question only and is not kept.
 */
const db = require('../db');
const { httpError } = require('../auth');

const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'in', 'to', 'set', 'pcs', 'new', 'women', 'men']);
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

const SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'false if the photo shows no product that could be bought (a person, a landscape, a blank image…).' },
    query: { type: 'string', description: 'What the product is, as 2–5 English words a shopper would type (e.g. "led strip lights", "dog harness").' },
    alternatives: { type: 'array', items: { type: 'string' }, description: '3–6 other short English searches for the same or very similar products (synonyms, the general type).' },
    colour: { type: 'string', description: 'Main colour in English, or empty.' },
    category: { type: 'string', description: 'Best Kinan category id from the list, or empty.' }
  },
  required: ['found', 'query', 'alternatives', 'colour', 'category']
};

/** Score live products against the AI's words: title words count most, keywords and category help. */
function match(d, limit = 40) {
  const catalog = require('./catalog');
  const all = catalog.browse({ limit: 100000 }).items;
  const main = words(d.query); const alt = [...new Set((d.alternatives || []).flatMap(words))].filter((w) => !main.includes(w));
  const col = words(d.colour)[0];
  const scored = [];
  for (const p of all) {
    const l = db.listings.get(p.id); if (!l) continue;
    const t = new Set(words(`${l.title} ${(l.keywords || []).join(' ')}`));
    let s = 0;
    for (const w of main) if (t.has(w) || [...t].some((x) => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))) s += 3;
    for (const w of alt) if (t.has(w)) s += 1;
    if (!s) continue;
    if (main.length && main.every((w) => t.has(w))) s += 4; // every main word: a close match
    if (d.category && (l.category || 'other') === d.category) s += 1;
    if (col && t.has(col)) s += 1;
    scored.push({ p, s });
  }
  return scored.sort((a, b) => b.s - a.s || b.p.listed_at - a.p.listed_at).slice(0, limit).map((x) => x.p);
}

async function search(image) {
  const img = String(image || '');
  if (!IMG.test(img)) throw httpError(400, 'Choose a photo (JPEG, PNG or WebP)');
  if (img.length > 3.5 * 1024 * 1024) throw httpError(413, 'The photo is too large');
  const ai = require('./ai');
  if (!ai.enabled()) throw httpError(503, 'Search by photo is not available right now');
  const cats = require('./shipping').CATEGORIES.map(([id, en]) => `${id} (${en})`).join(', ');
  let d;
  try {
    d = await ai.structured({
      system: 'You help shoppers find products from a photo. Identify the main product in the picture and give the words a shopper would search with. Ignore people, backgrounds and brand names.',
      name: 'photo_search', schema: SCHEMA, images: [img], maxTokens: 400, timeoutMs: 30000, kind: 'image_search',
      text: `Kinan categories: ${cats}. What product is in this photo?`
    });
  } catch (e) { throw httpError(503, 'Search by photo is busy — try again in a moment'); }
  if (!d.found || !String(d.query || '').trim()) return { query: '', alternatives: [], items: [], message: 'No product found in this photo' };
  const items = match(d);
  return { query: String(d.query).trim().slice(0, 80), alternatives: (d.alternatives || []).map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 6), category: d.category || '', items };
}

module.exports = { search, match, words };

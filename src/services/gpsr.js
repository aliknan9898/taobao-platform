// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * EU General Product Safety Regulation (GPSR): every product sold to EU shoppers must name an economic operator in the EU
 * (the "responsible person"), the manufacturer, and carry its safety warnings. Kinan is in Malta, so Kinan itself is the
 * EU responsible person for the products it sells; the details are set once in the admin (or GPSR_* settings).
 * Per product: l.gpsr = { manufacturer: {name, address, email}, warnings: [..] } overrides the defaults; without warnings
 * of its own a product gets the general warnings for its kind (toys, electrical, candles, kitchen…).
 */
const db = require('../db');
const { httpError } = require('../auth');

const SID = 'gpsr';
const FIELDS = ['company', 'address', 'city', 'postal_code', 'country', 'email', 'phone', 'manufacturer_name', 'manufacturer_address', 'manufacturer_email'];
const str = (v, n = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function settings() {
  const s = db.settings.get(SID) || {};
  const env = process.env;
  const v = (k) => str(s[k] ?? env[`GPSR_${k.toUpperCase()}`] ?? '');
  const out = Object.fromEntries(FIELDS.map((k) => [k, v(k)]));
  if (!out.country) out.country = 'MT';
  return out;
}
function save(body = {}) {
  const patch = {};
  for (const k of FIELDS) if (body[k] !== undefined) patch[k] = str(body[k], k.endsWith('address') ? 300 : 200);
  if (patch.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.email)) throw httpError(400, 'Enter a valid email');
  if (patch.country && !/^[A-Z]{2}$/.test(patch.country.toUpperCase())) throw httpError(400, 'Country: two letters, e.g. MT');
  if (patch.country) patch.country = patch.country.toUpperCase();
  if (db.settings.get(SID)) db.settings.update(SID, patch); else db.settings.insert({ id: SID, ...patch });
  return status();
}
/** Is the EU responsible person complete (name, full postal address, email)? */
function ready(s = settings()) { return Boolean(s.company && s.address && s.city && s.postal_code && s.country && s.email); }
function status() { const s = settings(); return { ...s, ready: ready(s), missing: ['company', 'address', 'city', 'postal_code', 'email'].filter((k) => !s[k]) }; }

// General warnings by kind of product (checked against the title, keywords and category)
const RULES = [
  [/\b(toy|toys|plush|doll|puzzle|kids?|children|baby|infant|toddler|stem|building blocks?|rattle)\b/i, ['Warning: not suitable for children under 3 years — small parts, choking hazard.', 'Use under the direct supervision of an adult.']],
  [/\b(led|lights?|lamp|electric|electronic|usb|battery|batteries|charger|plug|heater|projector|speaker|power)\b/i, ['Read the instructions before use and keep them for later.', 'Do not use if the cable, plug or housing is damaged. Keep away from water unless marked as waterproof.', 'Batteries: keep out of reach of children; if swallowed, seek medical help immediately.']],
  [/\b(candle|candles|lighter|fireplace|burner|incense|wax)\b/i, ['Never leave a burning candle unattended. Keep away from things that can catch fire, children and pets.']],
  [/\b(knife|knives|blade|scissors|cutter|peeler|grater|slicer)\b/i, ['Sharp edges — handle with care and keep out of reach of children.']],
  [/\b(pan|pot|kettle|mug|cup|bottle|lunch box|food|baking|kitchen|tray|container)\b/i, ['Wash before first use. Follow the care instructions; check that it is suitable for the dishwasher, microwave or oven before use.']],
  [/\b(pet|dog|cat|collar|leash|chew)\b/i, ['Supervise your pet when using this product. Remove it if it is damaged; not a toy for children.']],
  [/\b(cosmetic|cream|serum|oil|lotion|nail|makeup|perfume)\b/i, ['For external use only. Do a patch test before first use; stop using if irritation occurs. Keep out of reach of children.']],
  [/\b(ladder|tool|drill|saw|hammer|garden|shovel|axe)\b/i, ['Wear suitable protection when using. Keep out of reach of children.']]
];
const GENERAL = 'Use only as intended. Keep packaging away from babies and young children to avoid the risk of suffocation.';

function warningsFor(l) {
  if (Array.isArray(l?.gpsr?.warnings) && l.gpsr.warnings.length) return l.gpsr.warnings.map((w) => str(w, 300)).filter(Boolean).slice(0, 8);
  const text = `${l?.title || ''} ${(l?.keywords || []).join(' ')} ${l?.category || ''} ${l?.sourcing?.dept || ''}`;
  const out = [];
  for (const [re, ws] of RULES) if (re.test(text)) for (const w of ws) if (!out.includes(w)) out.push(w);
  out.push(GENERAL);
  return out.slice(0, 6);
}

/** What the product page and eBay show for one product (null when Kinan's details are not filled in yet). */
function forListing(l) {
  const s = settings();
  if (!ready(s)) return null;
  const rp = { name: s.company, address: [s.address, `${s.postal_code} ${s.city}`, s.country].filter(Boolean).join(', '), email: s.email, phone: s.phone || null };
  const m = l?.gpsr?.manufacturer;
  const manufacturer = m && m.name ? { name: str(m.name), address: str(m.address, 300), email: str(m.email) || null }
    : s.manufacturer_name ? { name: s.manufacturer_name, address: s.manufacturer_address, email: s.manufacturer_email || null } : null;
  return { responsible: rp, manufacturer, warnings: warningsFor(l) };
}

/** eBay offer "regulatory" block (EU responsible person + manufacturer). */
function ebayRegulatory(l) {
  const s = settings();
  if (!ready(s)) return null;
  const person = { companyName: s.company.slice(0, 100), addressLine1: s.address.slice(0, 180), city: s.city.slice(0, 64), postalCode: s.postal_code.slice(0, 9), country: s.country, email: s.email.slice(0, 250), ...(s.phone ? { phone: s.phone.slice(0, 64) } : {}) };
  const g = forListing(l);
  const reg = { responsiblePersons: [{ ...person, types: ['EUResponsiblePerson'] }] };
  // Only a manufacturer Kinan actually knows (set per product or as the default supplier) — never a made-up one
  if (g?.manufacturer?.name && g.manufacturer.address) reg.manufacturer = { companyName: g.manufacturer.name.slice(0, 100), addressLine1: g.manufacturer.address.slice(0, 180), ...(g.manufacturer.email ? { email: g.manufacturer.email } : {}) };
  return reg;
}

module.exports = { settings, save, status, ready, warningsFor, forListing, ebayRegulatory, RULES };

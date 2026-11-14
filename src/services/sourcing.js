// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * AI catalog builder — fills the Kinan shop like a big marketplace, department by department.
 *  1. Finds CJ products by keyword, kept in CJ's European and UK warehouses, most-listed (best-selling) first.
 *  2. Checks each one: stock in that warehouse, price range, words that must not be sold, and a real CJ delivery
 *     to the UK and to the EU within the day limits (fast delivery only).
 *  3. The AI looks at the photos and the text: keeps only clean, sellable, eBay-safe products, scores them,
 *     puts each in the right department and section, writes an eBay title (≤ 80 characters) and search keywords.
 *  4. Adds them to the Kinan shop in that department (a collection the shop shows like a marketplace aisle);
 *     the AI product review then polishes the copy and photos before they go live, and eBay can list them.
 * Runs in the background, a batch at a time, and every day by itself when "Daily" is on. Progress is kept in settings.
 */
const db = require('../db');
const { httpError } = require('../auth');

const now = () => Date.now();
const list = (v) => (Array.isArray(v) ? v : []);
const SID = 'sourcing';

// A marketplace's aisles: department → sections → search words that bring the best sellers
const DEPARTMENTS = {
  'home-kitchen': { en: 'Home & Kitchen', ar: 'المنزل والمطبخ', emoji: '🍳', category: 'home', groups: {
    gadgets: { en: 'Kitchen gadgets', ar: 'أدوات المطبخ', keywords: ['kitchen gadget', 'vegetable chopper', 'garlic press', 'kitchen scale', 'oil sprayer', 'can opener'] },
    storage: { en: 'Storage & organisation', ar: 'التخزين والتنظيم', keywords: ['storage box', 'drawer organizer', 'spice rack', 'food storage container', 'closet organizer', 'under sink organizer'] },
    cookware: { en: 'Cookware & baking', ar: 'أواني الطبخ والخبز', keywords: ['silicone baking mold', 'non stick pan', 'baking tools', 'cooking utensils set', 'air fryer accessories'] },
    cleaning: { en: 'Cleaning', ar: 'التنظيف', keywords: ['cleaning brush', 'microfiber cloth', 'spin mop', 'lint remover', 'electric cleaning brush'] },
    drinkware: { en: 'Drinkware', ar: 'أكواب وزجاجات', keywords: ['insulated water bottle', 'travel mug', 'glass cup', 'tumbler with straw'] }
  } },
  'home-decor': { en: 'Home Décor & Lighting', ar: 'ديكور وإضاءة', emoji: '🛋️', category: 'home', groups: {
    lighting: { en: 'Lighting', ar: 'إضاءة', keywords: ['led strip light', 'night light', 'table lamp', 'sunset lamp', 'motion sensor light', 'galaxy projector'] },
    decor: { en: 'Wall & room décor', ar: 'ديكور الجدران والغرف', keywords: ['wall decor', 'artificial plant', 'photo frame', 'wall clock', 'vase', 'decorative mirror'] },
    textiles: { en: 'Bedding & textiles', ar: 'مفروشات', keywords: ['cushion cover', 'throw blanket', 'bed sheet set', 'curtain', 'rug'] },
    fragrance: { en: 'Candles & fragrance', ar: 'شموع وروائح', keywords: ['aroma diffuser', 'scented candle', 'humidifier', 'essential oil diffuser'] }
  } },
  'garden-outdoor': { en: 'Garden & Outdoor', ar: 'الحديقة والخارج', emoji: '🌿', category: 'home', groups: {
    solar: { en: 'Solar & garden lights', ar: 'إضاءة شمسية', keywords: ['solar garden light', 'solar lamp outdoor', 'solar string lights', 'solar wall light'] },
    gardening: { en: 'Gardening', ar: 'الزراعة', keywords: ['garden tools', 'plant pot', 'watering can', 'garden hose nozzle', 'plant support'] },
    camping: { en: 'Camping & picnic', ar: 'التخييم والرحلات', keywords: ['camping lantern', 'camping chair', 'picnic blanket', 'camping cookware', 'hammock'] },
    bbq: { en: 'BBQ & patio', ar: 'الشواء والجلسات', keywords: ['bbq tools set', 'grill brush', 'outdoor cushion', 'patio lights'] }
  } },
  pets: { en: 'Pet Supplies', ar: 'مستلزمات الحيوانات', emoji: '🐾', category: 'home', groups: {
    dogs: { en: 'Dogs', ar: 'الكلاب', keywords: ['dog harness', 'dog leash', 'dog bed', 'dog toy', 'dog grooming brush', 'dog bowl'] },
    cats: { en: 'Cats', ar: 'القطط', keywords: ['cat toy', 'cat scratcher', 'cat bed', 'cat litter mat', 'cat water fountain'] },
    care: { en: 'Grooming & care', ar: 'العناية', keywords: ['pet hair remover', 'pet nail clipper', 'pet grooming glove', 'pet carrier'] }
  } },
  beauty: { en: 'Beauty & Personal Care', ar: 'الجمال والعناية', emoji: '💄', category: 'beauty', groups: {
    hair: { en: 'Hair care & styling', ar: 'العناية بالشعر', keywords: ['hair straightener brush', 'hair curler', 'hair dryer brush', 'hair clips', 'scalp massager'] },
    skin: { en: 'Skin care tools', ar: 'أدوات العناية بالبشرة', keywords: ['facial cleansing brush', 'gua sha', 'face roller', 'blackhead remover', 'led face mask'] },
    nails: { en: 'Nails & makeup', ar: 'الأظافر والمكياج', keywords: ['nail art kit', 'makeup brush set', 'makeup organizer', 'nail drill', 'press on nails'] },
    massage: { en: 'Massage & wellness', ar: 'المساج والاسترخاء', keywords: ['neck massager', 'massage gun', 'foot massager', 'eye massager'] }
  } },
  sports: { en: 'Sports & Fitness', ar: 'الرياضة واللياقة', emoji: '🏋️', category: 'sports', groups: {
    fitness: { en: 'Home fitness', ar: 'اللياقة المنزلية', keywords: ['resistance bands', 'yoga mat', 'dumbbell', 'jump rope', 'ab roller', 'push up board'] },
    cycling: { en: 'Cycling', ar: 'الدراجات', keywords: ['bike light', 'bike phone holder', 'bike lock', 'cycling gloves'] },
    water: { en: 'Swimming & beach', ar: 'السباحة والشاطئ', keywords: ['swimming goggles', 'beach towel', 'waterproof phone bag', 'snorkel'] },
    running: { en: 'Running & wear', ar: 'الجري', keywords: ['running belt', 'sports armband', 'compression socks', 'sports water bottle'] }
  } },
  electronics: { en: 'Electronics & Gadgets', ar: 'الإلكترونيات', emoji: '🎧', category: 'electronics', groups: {
    audio: { en: 'Audio', ar: 'الصوت', keywords: ['wireless earbuds', 'bluetooth speaker', 'headphones', 'karaoke microphone'] },
    smart: { en: 'Smart home', ar: 'المنزل الذكي', keywords: ['smart plug', 'wifi camera', 'smart light bulb', 'video doorbell'] },
    computer: { en: 'Computer accessories', ar: 'ملحقات الكمبيوتر', keywords: ['wireless mouse', 'mechanical keyboard', 'laptop stand', 'usb hub', 'mouse pad'] },
    gadgets: { en: 'Cool gadgets', ar: 'أجهزة ذكية', keywords: ['mini projector', 'digital alarm clock', 'electric lighter', 'portable fan', 'smart watch'] }
  } },
  phone: { en: 'Phone Accessories', ar: 'إكسسوارات الهاتف', emoji: '📱', category: 'phone', groups: {
    charging: { en: 'Chargers & cables', ar: 'الشواحن والكوابل', keywords: ['fast charger', 'wireless charger', 'charging cable', 'power bank', 'magnetic charger'] },
    holders: { en: 'Holders & stands', ar: 'الحوامل', keywords: ['phone stand', 'phone holder', 'selfie stick', 'tripod for phone', 'ring light'] },
    protection: { en: 'Cases & protection', ar: 'الأغطية والحماية', keywords: ['phone case', 'screen protector', 'tablet case', 'airpods case'] }
  } },
  car: { en: 'Car Accessories', ar: 'إكسسوارات السيارات', emoji: '🚗', category: 'car', groups: {
    interior: { en: 'Interior', ar: 'داخلية', keywords: ['car organizer', 'car seat cushion', 'car air freshener', 'car trash can', 'steering wheel cover'] },
    tech: { en: 'Car tech', ar: 'تقنيات السيارة', keywords: ['car phone holder', 'car charger', 'dash cam', 'car fm transmitter'] },
    care: { en: 'Car care', ar: 'العناية بالسيارة', keywords: ['car vacuum cleaner', 'car cleaning kit', 'tire inflator', 'car wash brush'] }
  } },
  'baby-kids': { en: 'Baby & Kids', ar: 'الرضّع والأطفال', emoji: '🍼', category: 'kids', groups: {
    baby: { en: 'Baby care', ar: 'العناية بالرضيع', keywords: ['baby bottle', 'baby bib', 'baby monitor', 'baby carrier', 'baby bath'] },
    feeding: { en: 'Feeding', ar: 'التغذية', keywords: ['baby feeding set', 'silicone baby plate', 'sippy cup', 'baby food maker'] },
    room: { en: 'Kids room', ar: 'غرفة الأطفال', keywords: ['kids night light', 'kids backpack', 'kids water bottle', 'growth chart'] }
  } },
  toys: { en: 'Toys & Games', ar: 'الألعاب', emoji: '🧸', category: 'toys', groups: {
    learning: { en: 'Learning toys', ar: 'ألعاب تعليمية', keywords: ['montessori toy', 'educational toy', 'drawing board', 'building blocks', 'puzzle'] },
    play: { en: 'Play & fun', ar: 'لعب ومرح', keywords: ['plush toy', 'fidget toy', 'remote control car', 'bubble machine', 'card game'] },
    outdoor: { en: 'Outdoor toys', ar: 'ألعاب خارجية', keywords: ['water gun', 'kite', 'sand toys', 'kids scooter'] }
  } },
  fashion: { en: 'Fashion & Accessories', ar: 'الأزياء والإكسسوارات', emoji: '👜', category: 'shoes_bags', groups: {
    bags: { en: 'Bags & wallets', ar: 'الحقائب والمحافظ', keywords: ['crossbody bag', 'tote bag', 'backpack', 'wallet', 'travel bag'] },
    jewelry: { en: 'Jewellery & watches', ar: 'المجوهرات والساعات', keywords: ['necklace', 'earrings', 'bracelet', 'watch', 'jewelry box'] },
    women: { en: 'Women', ar: 'نساء', keywords: ['women cardigan', 'women dress', 'women hoodie', 'leggings', 'women scarf'] },
    men: { en: 'Men', ar: 'رجال', keywords: ['men hoodie', 'men t-shirt', 'men jacket', 'men socks', 'beanie hat'] }
  } },
  'tools-diy': { en: 'Tools & DIY', ar: 'العدد والأدوات', emoji: '🔧', category: 'home', groups: {
    hand: { en: 'Hand tools', ar: 'العدد اليدوية', keywords: ['screwdriver set', 'tool kit', 'measuring tape', 'utility knife', 'pliers set'] },
    power: { en: 'Power tool accessories', ar: 'ملحقات العدد الكهربائية', keywords: ['drill bit set', 'cordless drill', 'electric screwdriver', 'glue gun'] },
    workshop: { en: 'Storage & workshop', ar: 'تنظيم الورشة', keywords: ['tool box', 'tool organizer', 'magnetic tool holder', 'work light'] }
  } },
  office: { en: 'Office & School', ar: 'المكتب والمدرسة', emoji: '✏️', category: 'other', groups: {
    desk: { en: 'Desk organisation', ar: 'تنظيم المكتب', keywords: ['desk organizer', 'monitor stand', 'pen holder', 'cable organizer'] },
    stationery: { en: 'Stationery', ar: 'القرطاسية', keywords: ['notebook', 'gel pens', 'sticky notes', 'pencil case', 'highlighter'] }
  } }
};
const EUROPE = ['DE', 'FR', 'ES', 'IT', 'PL', 'CZ', 'NL', 'GB'];
const EU = new Set(['DE', 'FR', 'ES', 'IT', 'PL', 'CZ', 'NL', 'BE', 'AT', 'HU', 'PT', 'IE', 'SE', 'DK']);
// Words that keep products out (on top of cj.BLOCK): medical claims, batteries alone, brands, things eBay restricts
const NOT_FOR_US = /\b(medical|medicine|pill|supplement|drug|cbd|weight loss|slimming|syringe|contact lens|lithium battery only|laser pointer|pepper spray|stun|taser|tattoo gun|knuckle|nunchaku|replica|apple|iphone \d+ original|samsung original|nike|adidas|gucci|chanel|louis vuitton|disney|marvel|pokemon|lego|barbie|hello kitty|harry potter|star wars)\b/i;

// ---------------- settings & state ----------------

function prefs() {
  const p = state().prefs || {};
  const deps = list(p.departments).filter((d) => DEPARTMENTS[d]);
  return {
    batch: Math.min(1000, Math.max(1, Math.floor(Number(p.batch) || 100))),
    daily: p.daily !== false, per_day: Math.min(1000, Math.max(0, Math.floor(Number(p.per_day ?? 150)))),
    markup_pct: Math.min(400, Math.max(10, Number(p.markup_pct) || 70)),
    min_cost: Math.max(0, Number(p.min_cost ?? 2)), max_cost: Math.min(300, Math.max(2, Number(p.max_cost) || 40)),
    min_listed: Math.max(0, Math.floor(Number(p.min_listed ?? 20))), min_stock: Math.max(1, Math.floor(Number(p.min_stock) || 20)),
    max_days_eu: Math.min(30, Math.max(2, Math.floor(Number(p.max_days_eu) || 7))), max_days_gb: Math.min(30, Math.max(2, Math.floor(Number(p.max_days_gb) || 10))),
    min_quality: Math.min(10, Math.max(1, Math.floor(Number(p.min_quality) || 7))), per_keyword: Math.min(20, Math.max(1, Math.floor(Number(p.per_keyword) || 4))),
    warehouses: (list(p.warehouses).length ? p.warehouses : EUROPE).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x) && x !== 'CN'),
    departments: deps.length ? deps : Object.keys(DEPARTMENTS)
  };
}
function state() { return db.settings.get(SID) || {}; }
function save(patch) { return db.settings.get(SID) ? db.settings.update(SID, typeof patch === 'function' ? patch : { ...patch }) : db.settings.insert({ id: SID, ...(typeof patch === 'function' ? patch({}) : patch) }); }
function savePrefs(b = {}) {
  const cur = state().prefs || {}; const next = { ...cur };
  for (const k of ['batch', 'per_day', 'markup_pct', 'min_cost', 'max_cost', 'min_listed', 'min_stock', 'max_days_eu', 'max_days_gb', 'min_quality', 'per_keyword']) if (b[k] !== undefined && b[k] !== '') next[k] = Number(b[k]);
  if (b.daily !== undefined) next.daily = Boolean(b.daily);
  if (b.warehouses !== undefined) next.warehouses = (Array.isArray(b.warehouses) ? b.warehouses : String(b.warehouses).split(/[\s,]+/)).filter(Boolean);
  if (b.departments !== undefined) next.departments = (Array.isArray(b.departments) ? b.departments : String(b.departments).split(/[\s,]+/)).filter((d) => DEPARTMENTS[d]);
  save({ prefs: next });
  return prefs();
}
const today = () => new Date().toISOString().slice(0, 10);
const addedToday = () => (state().day === today() ? state().day_added || 0 : 0);

/** Every (department, section, keyword), departments taken in turns so each one fills evenly. */
function queue(p) {
  const per = p.departments.map((d) => Object.entries(DEPARTMENTS[d].groups).flatMap(([g, x]) => x.keywords.map((kw) => ({ dept: d, group: g, kw }))));
  const out = []; const n = Math.max(...per.map((x) => x.length));
  for (let i = 0; i < n; i++) for (const arr of per) if (arr[i]) out.push(arr[i]);
  return out;
}

// ---------------- finding & checking ----------------

async function candidatesFor(cjc, item, p, have, tried) {
  const out = [];
  for (const verified of [1, 0]) {
    for (const cc of p.warehouses) {
      if (out.length >= p.per_keyword * 3) break;
      let d;
      try { d = await cjc.call('GET', '/product/listV2', { query: { keyWord: item.kw, countryCode: cc, page: 1, size: 40, orderBy: 1, sort: 'desc', verifiedWarehouse: verified ? 1 : undefined, startSellPrice: p.min_cost || undefined, endSellPrice: p.max_cost } }); }
      catch (e) { if (busyError(e)) throw e; continue; }
      for (const x of list(d?.content).flatMap((c) => list(c.productList))) {
        const pid = String(x.id || x.pid || ''); const title = x.nameEn || x.productNameEn || '';
        const cost = Number(String(x.sellPrice ?? '').split(/[-–]/)[0]); const listed = Number(x.listedNum) || 0;
        if (!pid || have.has(pid) || tried.has(pid) || out.some((o) => o.pid === pid)) continue;
        if (require('./cj').BLOCK.test(title) || NOT_FOR_US.test(title) || !(x.bigImage || x.productImage)) continue;
        if (!(cost >= p.min_cost && cost <= p.max_cost) || listed < p.min_listed) continue;
        out.push({ pid, from: cc, title, listed, cost });
      }
    }
    if (out.length >= p.per_keyword) break; // CJ-verified stock was enough
  }
  return out.sort((a, b) => b.listed - a.listed);
}

const busyError = (e) => e.status === 429 || e.status >= 500 || /busy|limit|too many|points|reach|timeout|fetch failed/i.test(e.message || '');

/** The fastest CJ delivery to a country within the day limit (null when there is none). */
async function delivery(cj, l, dest, maxDays) {
  const vid = [...l.skus].filter((k) => k.stock > 0).sort((a, b) => a.price - b.price)[0]?.cj_vid;
  if (!vid) return null;
  const storage = [...new Set(l.skus.filter((k) => k.cj_vid === vid).flatMap((k) => k.cj_storage || []))];
  let opts = await cj.freightOptions(dest, [{ vid, qty: 1 }], l.cj_from);
  if (!opts.length && storage.length) opts = await cj.freightOptions(dest, [{ vid, qty: 1 }], l.cj_from, storage);
  const fast = opts.filter((o) => (o.max ?? 99) <= maxDays).sort((a, b) => a.fee - b.fee || (a.max ?? 99) - (b.max ?? 99));
  const o = fast[0];
  return o ? { fee: o.fee, method: o.method, days: o.days || (o.max ? `${o.min || o.max}-${o.max}` : ''), max: o.max, vid } : null;
}

const SCHEMA = (deptIds, groupIds) => ({
  type: 'object',
  properties: {
    keep: { type: 'boolean', description: 'true only if this is a good product to sell: clear photos of the real product, sellable in the UK/EU, not a brand copy, not restricted on eBay.' },
    reason: { type: 'string', description: 'One short sentence: why kept or why not.' },
    quality: { type: 'integer', description: '1–10: how good the product AND its photos are for a premium marketplace (10 = clean studio photos, clear useful product, strong demand).' },
    photos_ok: { type: 'boolean', description: 'false if the photos are blurry, collages with lots of text, watermarked with another shop, show Chinese text everywhere, or do not match the title.' },
    photo_issues: { type: 'string', description: 'Short note on photo problems, empty if none.' },
    department: { type: 'string', enum: deptIds, description: 'The best department.' },
    section: { type: 'string', enum: groupIds, description: 'The best section inside that department (dept:section).' },
    ebay_ok: { type: 'boolean', description: 'false if eBay UK restricts it (brands/logos of others, weapons, medical claims, adult, batteries shipped alone, food, cosmetics needing safety files, etc.).' },
    ebay_title: { type: 'string', description: 'eBay title: max 80 characters, the words buyers search first, no brand names, no ALL CAPS, no symbols like ! or ★.' },
    keywords: { type: 'array', items: { type: 'string' }, description: '8–12 lower-case search phrases a UK/EU shopper ready to buy would type, 2–4 words each, specific to THIS product: about 3 with the product type and its main feature or material (e.g. "rechargeable led desk lamp"), 3 with the benefit or problem it solves, 2–3 with the use, room, occasion or who it is for (e.g. "gift for runners"), 1–2 British/European spellings or synonyms. No single generic words, no brand names, no features it does not have, no near-duplicates.' }
  },
  required: ['keep', 'reason', 'quality', 'photos_ok', 'photo_issues', 'department', 'section', 'ebay_ok', 'ebay_title', 'keywords']
});

/** The AI looks at the photos and text (null when the AI is off or busy: the product then waits for the AI review). */
async function curate(l, item) {
  const ai = require('./ai');
  if (!ai.enabled()) return null;
  const deptIds = Object.keys(DEPARTMENTS);
  const groupIds = deptIds.flatMap((d) => Object.keys(DEPARTMENTS[d].groups).map((g) => `${d}:${g}`));
  const opts = [...new Set(list(l.skus).map((s) => s.props).filter(Boolean))].slice(0, 12);
  try {
    return await ai.structured({
      system: 'You are the head buyer of Kinan, a marketplace that sells to the UK and Europe and also lists on eBay UK. You decide which supplier products are good enough to sell, and you organise them like a big marketplace. Judge the photos strictly and keep only products you would be proud to sell: clear real photos, useful, likely to sell well, and fair for the price. Be honest and brief.',
      name: 'product_decision', schema: SCHEMA(deptIds, groupIds), images: list(l.images).slice(0, 4), kind: 'sourcing', maxTokens: 900,
      text: `Supplier title: ${l.title}\nSearched as: "${item.kw}" (department ${item.dept}, section ${item.group})\nOptions: ${opts.join(', ') || 'one'}\nShips from: ${l.cj_from} warehouse\nDescription:\n${String(l.description || '').slice(0, 1800)}`
    });
  } catch (e) { return { error: e.message }; }
}

// ---------------- the run ----------------

let running = false; let stopAsked = false;

/** One run: add up to `count` products (background job). */
async function run(opts = {}, by = 'admin') {
  if (running) throw httpError(409, 'The catalog builder is already running');
  const cjc = require('../cj/client'); const cj = require('./cj');
  if (!cjc.enabled()) throw httpError(503, 'CJdropshipping is not connected');
  const p = prefs();
  const target = Math.min(1000, Math.max(1, Math.floor(Number(opts.count) || p.batch)));
  running = true; stopAsked = false;
  const kinan = require('./buyforme').systemSeller();
  const have = new Set(db.listings.all((l) => l.source === 'cj').map((l) => l.cj_pid));
  const s0 = state();
  const tried = new Set(list(s0.tried));
  const q = queue(p);
  let cursor = Number(s0.cursor) || 0;
  const added = []; // details of each product added, for the Telegram report
  const st = { running: true, started_at: now(), by, target, added: 0, checked: 0, skipped: 0, reasons: {}, by_dept: {}, error: null, last: [] };
  const skip = (why, pid) => { st.skipped++; st.reasons[why] = (st.reasons[why] || 0) + 1; if (pid) tried.add(pid); };
  const persist = () => save((x) => ({ ...x, run: { ...st }, cursor, tried: [...tried].slice(-30000), day: today(), day_added: (x.day === today() ? x.day_added || 0 : 0) }));
  save({ run: st });
  console.log(`[sourcing] started — up to ${target} products, ${p.departments.length} departments, warehouses ${p.warehouses.join(',')}`);
  let busy = 0; let passes = 0;
  try {
    while (st.added < target && !stopAsked && passes < q.length) {
      const item = q[cursor % q.length]; cursor = (cursor + 1) % q.length; passes++;
      let cands;
      try { cands = await candidatesFor(cjc, item, p, have, tried); busy = 0; }
      catch (e) { if (busyError(e)) { st.error = `CJ stopped answering (${e.message}) — continues automatically later`; st.retry_at = require('../cj/client').retryAt(); cursor = (cursor - 1 + q.length) % q.length; break; } continue; }
      let took = 0;
      for (const c of cands) {
        if (st.added >= target || took >= p.per_keyword || stopAsked) break;
        have.add(c.pid); st.checked++;
        let l;
        try {
          l = await cj.publish(kinan, { ref: { pid: c.pid }, from: c.from, markup_pct: p.markup_pct, category: DEPARTMENTS[item.dept].category, extra: { collections: [item.dept], collection_group: item.group } });
          busy = 0;
        } catch (e) {
          if (busyError(e)) { have.delete(c.pid); st.checked--; if ((busy += 1) >= 5) { st.error = `CJ stopped answering (${e.message}) — continues automatically later`; st.retry_at = require('../cj/client').retryAt(); stopAsked = true; } continue; }
          skip(/stock|price/i.test(e.message) ? 'no price' : 'not available', c.pid); continue;
        }
        const drop = (why) => { db.listings.remove(l.id); skip(why, c.pid); };
        if (l.cj_from !== c.from) { drop('not in a European/UK warehouse'); continue; }
        if (!l.skus.some((k) => k.stock >= p.min_stock)) { drop('low stock'); continue; }
        if (cj.BLOCK.test(`${l.title} ${l.description}`) || NOT_FOR_US.test(l.title)) { drop('not suitable'); continue; }
        if (list(l.images).filter((u) => /^https?:/.test(u)).length < 2) { drop('too few photos'); continue; }
        // fast delivery: the EU from an EU warehouse, the UK for eBay UK
        let eu = null; let gb = null;
        try {
          if (c.from !== 'GB') eu = await delivery(cj, l, c.from === 'DE' ? 'FR' : 'DE', p.max_days_eu);
          gb = await delivery(cj, l, 'GB', c.from === 'GB' ? p.max_days_eu : p.max_days_gb);
        } catch (e) { if (busyError(e)) { db.listings.remove(l.id); have.delete(c.pid); st.checked--; continue; } }
        if (c.from !== 'GB' && !eu) { drop(`no delivery in ${p.max_days_eu} days`); continue; }
        if (c.from === 'GB' && !gb) { drop(`no UK delivery in ${p.max_days_eu} days`); continue; }
        // the AI decides (photos + text)
        const d = await curate(l, item);
        if (d && !d.error) {
          if (!d.keep || !d.photos_ok || (Number(d.quality) || 0) < p.min_quality) { drop(!d.photos_ok ? 'AI: photos not good enough' : !d.keep ? 'AI: not a good product' : 'AI: quality too low'); continue; }
        }
        const [dept, group] = d && !d.error && /:/.test(d.section || '') && DEPARTMENTS[d.section.split(':')[0]]?.groups[d.section.split(':')[1]] ? d.section.split(':') : [d?.department && DEPARTMENTS[d.department] ? d.department : item.dept, item.group];
        const sec = DEPARTMENTS[dept].groups[group] ? group : Object.keys(DEPARTMENTS[dept].groups)[0];
        db.listings.update(l.id, (x) => ({
          ...x, collections: [dept], collection_group: sec, category: DEPARTMENTS[dept].category, cj_auto: true, auto_added_at: now(),
          ...(d && !d.error && list(d.keywords).length ? { keywords: list(d.keywords).slice(0, 12) } : {}),
          cj_ship: { ...(x.cj_ship || {}), ...(eu ? { [c.from === 'DE' ? 'FR' : 'DE']: { fee: eu.fee, vid: eu.vid, at: now() } } : {}), ...(gb ? { GB: { fee: gb.fee, vid: gb.vid, at: now() } } : {}) },
          sourcing: {
            dept, group: sec, keyword: item.kw, listed: c.listed, from: c.from, cost: c.cost, supplier_title: c.title, at: now(),
            eu_days: eu?.days || null, eu_fee: eu?.fee ?? null, gb_days: gb?.days || null, gb_fee: gb?.fee ?? null,
            ai: d ? (d.error ? 'failed' : 'ok') : 'off', quality: d && !d.error ? Number(d.quality) || null : null, reason: d && !d.error ? String(d.reason || '').slice(0, 200) : null,
            ebay_ok: Boolean(gb) && (d && !d.error ? d.ebay_ok !== false : true), ebay_title: d && !d.error ? String(d.ebay_title || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null
          }
        }));
        st.added++; took++; st.by_dept[dept] = (st.by_dept[dept] || 0) + 1;
        st.last = [{ id: l.id, title: l.title.slice(0, 70), dept, quality: d && !d.error ? d.quality : null }, ...st.last].slice(0, 12);
        added.push({ id: l.id, title: (d && !d.error && d.ebay_title) || l.title, dept, from: c.from, quality: d && !d.error ? Number(d.quality) || null : null, eu: eu?.days || null, gb: gb?.days || null, cost: c.cost, price: Math.min(...list(db.listings.get(l.id)?.skus).map((k) => Number(k.price) || Infinity)), kw: d && !d.error ? list(d.keywords).slice(0, 4) : [], listed: c.listed });
        save((x) => ({ ...x, day: today(), day_added: (x.day === today() ? x.day_added || 0 : 0) + 1 }));
        persist();
      }
      persist();
    }
  } catch (e) { st.error = e.message; }
  finally {
    running = false; st.running = false; st.done_at = now(); st.stopped = stopAsked && !st.retry_at ? true : undefined;
    persist();
  }
  console.log(`[sourcing] done: added ${st.added}, checked ${st.checked}, skipped ${st.skipped} ${JSON.stringify(st.reasons)}${st.error ? ` — ${st.error}` : ''}`);
  if (st.added) try { telegramReport(st, added); } catch (e) { console.warn('[sourcing] telegram', e.message); }
  return st;
}

function start(opts = {}, by = 'admin') {
  if (running) throw httpError(409, 'The catalog builder is already running');
  if (!require('../cj/client').enabled()) throw httpError(503, 'CJdropshipping is not connected');
  require('../cj/client').background(() => run(opts, by)).catch((e) => console.warn('[sourcing]', e.message));
  return { started: true };
}
function stop() { stopAsked = true; return { stopping: running }; }

/** Hourly: the daily batch (and resuming one CJ paused or a restart cut short). */
function tick() {
  const p = prefs(); const s = state();
  if (running || !require('../cj/client').enabled()) return false;
  if (s.run?.retry_at && now() < Math.min(s.run.retry_at, (s.run.done_at || 0) + 3600e3)) return false; // waits at most an hour (older runs saved 2 hours)
  const left = p.per_day - addedToday();
  const interrupted = s.run?.running; // the process that ran it is gone
  if (!(p.daily && left > 0) && !interrupted) return false;
  const n = interrupted ? Math.min(100, Math.max(1, (s.run.target || 0) - (s.run.added || 0))) : Math.min(100, left);
  if (n <= 0) return false;
  start({ count: n }, interrupted ? 'resume' : 'daily');
  return true;
}

// ---------------- admin & shop ----------------

function status() {
  const s = state(); const p = prefs();
  const mine = db.listings.all((l) => l.sourcing);
  const per = Object.fromEntries(Object.keys(DEPARTMENTS).map((d) => [d, { live: 0, waiting: 0, ebay: 0 }]));
  for (const l of mine) { const x = per[l.sourcing.dept]; if (!x) continue; if (l.status === 'active') x.live++; else if (l.status === 'pending_review') x.waiting++; if (l.ebay?.listing_id) x.ebay++; }
  const run = s.run ? { ...s.run, running: running || false } : null;
  return {
    prefs: p, running, run, added_today: addedToday(), total: mine.length,
    departments: Object.entries(DEPARTMENTS).map(([id, d]) => ({ id, en: d.en, ar: d.ar, emoji: d.emoji, on: p.departments.includes(id), keywords: Object.values(d.groups).reduce((a, g) => a + g.keywords.length, 0), groups: Object.entries(d.groups).map(([gid, g]) => ({ id: gid, en: g.en })), ...per[id] })),
    cj: require('../cj/client').enabled(), ai: require('./ai').enabled()
  };
}

/** Departments with live products, for the shop (like the Christmas collection). */
// ---------------- re-classifying the whole shop into departments ----------------
// Every live product gets a department and a section (AI on titles in batches; word rules when the AI is busy).
// Seasonal collections (Christmas) are kept: the department is added next to them, the section goes to sourcing.group.
const wordsOf = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function ruleFor(l) {
  const text = ` ${wordsOf(`${l.title} ${list(l.keywords).join(' ')}`).join(' ')} `;
  let best = null;
  for (const [d, D] of Object.entries(DEPARTMENTS)) for (const [g, G] of Object.entries(D.groups)) {
    let sc = 0;
    for (const k of list(G.keywords)) { const kw = wordsOf(k); if (kw.length && kw.every((w) => text.includes(` ${w}`))) sc += kw.length * 2; else sc += kw.filter((w) => text.includes(` ${w} `)).length * 0.5; }
    if (text.includes(` ${wordsOf(G.en)[0] || '#'} `)) sc += 1;
    if (!best || sc > best.sc) best = { d, g, sc };
  }
  return best && best.sc >= 1 ? { dept: best.d, group: best.g } : null;
}
let reclassing = false;
async function reclassify({ all = true } = {}) {
  if (reclassing) throw httpError(409, 'Already re-classifying');
  reclassing = true;
  const ai = require('./ai');
  const targets = db.listings.all((l) => l.status === 'active' && (all || !(l.sourcing && DEPARTMENTS[l.sourcing.dept])));
  const keys = Object.entries(DEPARTMENTS).flatMap(([d, D]) => Object.entries(D.groups).map(([g, G]) => `${d}:${g} (${D.en} › ${G.en})`));
  const st = { total: targets.length, ai: 0, rules: 0, unsure: 0, moved: 0, by_dept: {} };
  try {
    for (let i = 0; i < targets.length; i += 40) {
      const batch = targets.slice(i, i + 40); let picks = null;
      if (ai.enabled()) {
        for (let t = 0; t < 3 && !picks; t++) {
          try {
            const r = await ai.structured({
              system: 'You sort the products of an online shop into its departments and sections, the way Amazon would. Choose the ONE place a shopper would look for each product. Use "none" only when nothing fits at all.',
              name: 'classify', kind: 'sourcing', maxTokens: 1800, timeoutMs: 60000,
              schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, place: { type: 'string', enum: [...keys.map((k) => k.split(' ')[0]), 'none'] } }, required: ['n', 'place'] } } }, required: ['items'] },
              text: `Places:\n${keys.join('\n')}\n\nProducts:\n${batch.map((l, n) => `${n}. ${String(l.title).slice(0, 110)}`).join('\n')}`
            });
            picks = new Map(list(r.items).map((x) => [Number(x.n), String(x.place)]));
          } catch (e) { console.warn('[classify]', e.message); await new Promise((res) => setTimeout(res, 15000)); }
        }
      }
      batch.forEach((l, n) => {
        let dept = null; let group = null; let by = 'ai';
        const pk = picks && picks.get(n);
        if (pk && pk !== 'none') { [dept, group] = pk.split(':'); if (!DEPARTMENTS[dept]?.groups[group]) dept = null; }
        if (!dept) { const r = ruleFor(l); by = 'rules'; if (r) ({ dept, group } = r); }
        if (!dept) { st.unsure++; return; }
        st[by]++; st.by_dept[dept] = (st.by_dept[dept] || 0) + 1;
        const before = l.sourcing?.dept;
        if (before !== dept) st.moved++;
        db.listings.update(l.id, (x) => {
          const seasonal = list(x.collections).filter((c) => !DEPARTMENTS[c]);
          const keepGroup = seasonal.length && x.collection_group && !Object.values(DEPARTMENTS).some((D) => D.groups[x.collection_group]);
          return { ...x, sourcing: { ...(x.sourcing || {}), dept, group, classified_by: by, classified_at: Date.now() }, collections: [...seasonal, dept], collection_group: keepGroup ? x.collection_group : group };
        });
      });
    }
    return st;
  } finally { reclassing = false; }
}

function publicDepartments() {
  const live = db.listings.all((l) => l.status === 'active' && l.sourcing && DEPARTMENTS[l.sourcing.dept] && list(l.collections).includes(l.sourcing.dept));
  const out = [];
  for (const [id, d] of Object.entries(DEPARTMENTS)) {
    const mine = live.filter((l) => l.sourcing.dept === id);
    if (!mine.length) continue;
    out.push({ id, kind: 'department', name: d.en, name_ar: d.ar, emoji: d.emoji, count: mine.length, image: list(mine[0].images)[0] || null,
      groups: Object.entries(d.groups).map(([gid, g]) => ({ id: gid, en: g.en, ar: g.ar, count: mine.filter((l) => (l.sourcing.group || l.collection_group) === gid).length })).filter((g) => g.count) });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** The owner's Telegram: every product added in this run (name, department, AI score, delivery, cost → price,
 *  keywords, link), why the others were skipped, and the CJ points left. Split into messages Telegram accepts. */
function telegramReport(st, added, title = 'Kinan catalog builder') {
  const push = require('../push'); const { config } = require('../config');
  const cur = String(config.currency || 'usd').toUpperCase(); const m2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : '?');
  const head = [`🛍️ ${title} — ${st.added} new product(s)`, `Checked ${st.checked} · skipped ${st.skipped}`,
    ...Object.entries(st.by_dept || {}).map(([k, v]) => `• ${DEPARTMENTS[k]?.emoji || ''} ${DEPARTMENTS[k]?.en || k}: ${v}`)];
  const why = Object.entries(st.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (why.length) head.push('', 'Skipped because:', ...why.map(([r, n]) => `• ${r}: ${n}`));
  try { const u = require('../cj/client').usage(); if (u.points) head.push('', `🔑 CJ points: ${u.points.remaining}/${u.points.total || '?'} (+${u.points.refill_per_minute || '?'}/min)`); } catch { /* optional */ }
  if (st.error) head.push('', `⏸ ${st.error}`);
  const msgs = [head.join('\n')]; let cur2 = '';
  added.forEach((a, i) => {
    const block = [`${i + 1}. ${a.title.slice(0, 90)}`, `   ${DEPARTMENTS[a.dept]?.en || a.dept} · from ${a.from}${a.quality ? ` · AI ${a.quality}/10` : ''}${a.listed ? ` · ${a.listed} CJ shops sell it` : ''}`,
      `   Delivery: ${a.eu ? `EU ${a.eu} days` : ''}${a.eu && a.gb ? ' · ' : ''}${a.gb ? `UK ${a.gb} days` : ''} · cost ${m2(a.cost)} → price ${m2(a.price)} ${cur}`,
      ...(a.kw.length ? [`   🔎 ${a.kw.join(', ')}`] : []), `   ${config.publicBaseUrl}/#/p/${a.id}`].join('\n');
    if ((cur2 + block).length > 3300) { msgs.push(cur2); cur2 = ''; }
    cur2 += (cur2 ? '\n\n' : '') + block;
  });
  if (cur2) msgs.push(cur2);
  for (const t of msgs.slice(0, 12)) push.telegram(t);
}

module.exports = { telegramReport, reclassify, ruleFor, DEPARTMENTS, prefs, savePrefs, status, start, stop, run, tick, publicDepartments, queue, curate, _running: () => running };

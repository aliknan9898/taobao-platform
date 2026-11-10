// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Extract a Taobao item ID from a pasted link.
 * Supported by the platform: Taobao (and Tmall) items.
 * NOT supported (Service Partner guide §2.1, FAQ §7.1): Taote (淘特 / Taobao Special Edition) and Goofish (闲鱼).
 */

const UNSUPPORTED = [
  { re: /(^|\.)goofish\.com$|(^|\.)2\.taobao\.com$|(^|\.)xianyu|idle/i, reason: 'GOOFISH' },
  { re: /(^|\.)taote\.com$|(^|\.)tejia\.taobao\.com$|ltao\.com$/i, reason: 'TAOTE' }
];

const SHORT_HOSTS = /(^|\.)(m\.tb\.cn|tb\.cn|e\.tb\.cn)$/i;
const TAOBAO_HOSTS = /(^|\.)(taobao\.com|tmall\.com|tmall\.hk|taobao\.global|world\.taobao\.com)$/i;

function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>，。]+/i);
  return m ? m[0] : null;
}

/**
 * @returns {{ok:true,itemId:string}|{ok:false,reason:string,shortUrl?:string}}
 */
function parseTaobaoLink(input) {
  const raw = String(input || '').trim();
  if (/^\d{6,20}$/.test(raw)) return { ok: true, itemId: raw };

  const urlStr = extractUrl(raw);
  if (!urlStr) return { ok: false, reason: 'NO_URL' };

  let u;
  try { u = new URL(urlStr); } catch { return { ok: false, reason: 'BAD_URL' }; }
  const host = u.hostname.toLowerCase();

  for (const x of UNSUPPORTED) if (x.re.test(host)) return { ok: false, reason: x.reason };
  if (SHORT_HOSTS.test(host)) return { ok: false, reason: 'SHORT_LINK', shortUrl: urlStr };
  if (!TAOBAO_HOSTS.test(host)) return { ok: false, reason: 'NOT_TAOBAO' };

  const q = u.searchParams;
  const id = q.get('id') || q.get('itemId') || q.get('item_id') || q.get('itemid');
  if (id && /^\d{6,20}$/.test(id)) return { ok: true, itemId: id };

  const pathMatch = u.pathname.match(/(?:\/item\/|\/i|\/detail\/)(\d{6,20})(?:\.htm|\/|$)/i);
  if (pathMatch) return { ok: true, itemId: pathMatch[1] };

  return { ok: false, reason: 'NO_ITEM_ID' };
}

/** Resolve m.tb.cn short links by following redirects (server-side only). */
async function resolveShortLink(shortUrl) {
  let url = shortUrl;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const loc = res.headers.get('location');
    if (loc) { url = new URL(loc, url).toString(); const p = parseTaobaoLink(url); if (p.ok || p.reason !== 'NO_ITEM_ID' && p.reason !== 'SHORT_LINK') return p; continue; }
    const html = (await res.text()).slice(0, 200000);
    const m = html.match(/https?:\/\/(?:item\.taobao\.com|detail\.tmall\.com|[a-z.]*taobao\.com)\/[^"'\s]*?[?&]id=(\d{6,20})/i)
      || html.match(/[?&]id=(\d{6,20})/);
    if (m) return { ok: true, itemId: m[1] };
    break;
  }
  return { ok: false, reason: 'SHORT_LINK_UNRESOLVED' };
}

async function itemIdFromInput(input) {
  const p = parseTaobaoLink(input);
  if (p.ok || p.reason !== 'SHORT_LINK') return p;
  return resolveShortLink(p.shortUrl);
}

module.exports = { parseTaobaoLink, itemIdFromInput };

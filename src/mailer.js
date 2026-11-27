// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Transactional email via Brevo's HTTP API (no SMTP library needed).
 * Without BREVO_API_KEY + MAIL_FROM, messages are kept in the `mail` log with status "not_sent"
 * so nothing breaks and the admin can see what would have gone out.
 */
const db = require('./db');
const { config } = require('./config');

const DOMAIN_ID = 'mail_domain';
/** Once the site's own domain is authenticated in Brevo, mail goes out as noreply@<domain>; until then from MAIL_FROM. */
function sender() {
  const d = db.settings.get(DOMAIN_ID);
  if (d && d.authenticated && d.domain) return { email: `${config.mail.domainSender}@${d.domain}`, name: config.mail.fromName };
  return { email: config.mail.from, name: config.mail.fromName };
}
const enabled = () => Boolean(config.mail.brevoKey && sender().email);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Branded layout with the Kinan logo. `lines` are plain-text paragraphs; `button` is { text, url }.
 * `ar` = { title, lines, button } adds an Arabic version (shown first, right-to-left) above the English one.
 * `highlight` = { label, value } shows a boxed code (e.g. a discount code). `app` = 'shop' | 'seller' picks the label under the logo.
 */
/** Product cards: `products` = [{ title, image, price, qty, url }] — a medium photo (120 px) with name, quantity and price. */
function productRows(products, rtl) {
  const site = String(config.publicBaseUrl || '').replace(/\/$/, '');
  const abs = (u) => (/^https:\/\//.test(u || '') ? u : u && u.startsWith('/') && /^https:\/\//.test(site) ? site + u : '');
  const rows = products.slice(0, 6).map((p) => {
    const img = abs(p.image); const url = abs(p.url) || site;
    const pic = `<td width="120" style="width:120px;padding:${rtl ? '0 0 0 14px' : '0 14px 0 0'};vertical-align:top">${img ? `<a href="${esc(url)}"><img src="${esc(img)}" width="120" height="120" alt="${esc(p.title)}" style="display:block;width:120px;height:120px;object-fit:cover;border-radius:12px;border:1px solid #e1e5ee;background:#f4f6f9"></a>` : `<div style="width:120px;height:120px;border-radius:12px;background:#f4f6f9"></div>`}</td>`;
    const txt = `<td style="vertical-align:middle;text-align:${rtl ? 'right' : 'left'}"><a href="${esc(url)}" style="color:#141b3a;text-decoration:none;font-weight:600;font-size:15px;line-height:1.4">${esc(p.title)}</a>
      ${p.qty > 1 ? `<div style="font-size:13px;color:#6b7290;margin-top:4px">× ${esc(p.qty)}</div>` : ''}${p.price ? `<div style="font-size:16px;font-weight:800;color:#0e7c66;margin-top:6px">${esc(p.price)}</div>` : ''}</td>`;
    return `<tr><td style="padding:8px 0;border-top:1px solid #eef0f4"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" dir="${rtl ? 'rtl' : 'ltr'}"><tr>${pic}${txt}</tr></table></td></tr>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:12px 0 4px">${rows}</table>`;
}
function block({ title, lines = [], button, highlight, products }, rtl) {
  const align = rtl ? 'right' : 'left';
  return `<div dir="${rtl ? 'rtl' : 'ltr'}" style="text-align:${align}">
  <h1 style="font-size:21px;line-height:1.35;margin:0 0 12px;color:#141b3a">${esc(title)}</h1>
  ${lines.map((l) => `<p style="margin:0 0 10px;line-height:1.65;font-size:15px;color:#2b3355">${esc(l)}</p>`).join('')}
  ${products && products.length ? productRows(products, rtl) : ''}
  ${highlight ? `<div style="margin:14px 0;padding:14px;border:2px dashed #0e7c66;border-radius:12px;background:#eef8f5;text-align:center"><div style="font-size:12px;color:#4b5573;margin-bottom:4px">${esc(highlight.label)}</div><div style="font-size:24px;font-weight:800;letter-spacing:2px;color:#0e7c66">${esc(highlight.value)}</div></div>` : ''}
  ${button ? `<p style="margin:18px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#0e7c66;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:12px;font-size:15px">${esc(button.text)}</a></p>` : ''}
  </div>`;
}
function layout({ title, lines = [], button, highlight, ar, app, products, shipping }) {
  const site = config.publicBaseUrl || '';
  const logo = /^https:\/\//.test(site) ? `${site}/assets/${app === 'seller' ? 'icon-seller-192.png' : 'icon-192.png'}` : '';
  const label = app === 'seller' ? 'Seller Center' : 'Shop';
  const head = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 18px"><tr>
    ${logo ? `<td style="padding-right:10px;vertical-align:middle"><img src="${esc(logo)}" width="44" height="44" alt="Kinan" style="display:block;border-radius:12px;border:0"></td>` : ''}
    <td style="vertical-align:middle"><div style="font-weight:800;font-size:24px;color:#141b3a;letter-spacing:-.3px;line-height:1">KINAN</div><div style="font-size:12px;color:#0e7c66;font-weight:600;margin-top:2px">${label}</div></td></tr></table>`;
  const banner = shipping && /^https:\/\//.test(site)
    ? `<img src="${esc(site.replace(/\/$/, '') + '/assets/kinan-delivery-van.jpg')}" width="510" alt="KINAN delivery van" style="display:block;width:100%;height:auto;border-radius:12px;margin:0 0 18px">`
    : '';
  const en = block({ title, lines, button, highlight, products }, /[\u0600-\u06FF]/.test(String(title)));
  const body = ar ? `${block({ highlight, products, ...ar }, true)}<hr style="border:0;border-top:1px solid #e1e5ee;margin:22px 0">${en}` : en;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f6f9;font-family:Segoe UI,Tahoma,Arial,sans-serif;color:#141b3a">
  <div style="max-width:560px;margin:0 auto;padding:24px 14px">${head}<div style="background:#fff;border:1px solid #e1e5ee;border-radius:16px;padding:26px 22px">${banner}${body}</div>
  <p style="font-size:12px;color:#6b7290;text-align:center;margin-top:16px;line-height:1.6">${site ? `<a href="${esc(site)}" style="color:#0e7c66;text-decoration:none;font-weight:600">${esc(site.replace(/^https?:\/\//, ''))}</a><br>` : ''}${esc(config.operator.tradingName)} · ${esc(config.operator.name)}</p></div></body></html>`;
  // Brand colours: emerald for customers, violet for sellers (the logo comes from the app icons)
  const accent = app === 'seller' ? '#4b319b' : '#036747'; const soft = app === 'seller' ? '#f1edfc' : '#e8f3ec';
  return html.replace(/#0e7c66/g, accent).replace(/#eef8f5/g, soft).replace(/#141b3a/g, '#172923').replace(/#2b3355/g, '#2f3d38').replace(/#4b5573|#6b7290/g, '#55655e').replace(/#e1e5ee|#eef0f4/g, '#e3e9e4').replace(/#f4f6f9/g, '#f5f7f4');
}

/** Send (or log) one email. Never throws; returns the log record. `key` makes the send idempotent. */
/** The recipient's language: what their app was set to (phone language or their choice). Unknown → both languages. */
function langOf(to) { const u = db.users.find((x) => x.email === String(to).toLowerCase()); return u?.lang === 'ar' || u?.lang === 'en' ? u.lang : null; }

async function send({ to, subject, title, lines, button, key, kind = 'general', attachments, ar, highlight, app, lang, products, shipping = false }) {
  if (!to || /\.invalid$/i.test(String(to).trim())) return null; // no address, or a deleted account's placeholder
  // Arabic readers get only the Arabic version, English readers only the English one
  const l = lang || langOf(to);
  if (ar && l === 'ar') { title = ar.title; lines = ar.lines; button = ar.button || button; subject = ar.subject || subject; ar = undefined; }
  else if (ar && l === 'en') ar = undefined;
  else if (ar && ar.subject) subject = `${ar.subject} · ${subject}`;
  if (key) { const dup = db.mail.find((m) => m.key === key); if (dup) return dup; }
  const rec = db.mail.insert({ to, subject, kind, key: key || null, status: enabled() ? 'sending' : 'not_sent' });
  pruneLog();
  if (!enabled()) { console.log(`[mail] (not sent — email not set up) to=${to} subject="${subject}"${button ? ` link=${button.url}` : ''}`); return rec; }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': config.mail.brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: sender(), ...(config.mail.replyTo ? { replyTo: { email: config.mail.replyTo } } : {}), to: [{ email: to }], ...(attachments ? { attachment: attachments } : {}), subject, htmlContent: layout({ title: title || subject, lines, button, ar, highlight, products, shipping, app: app || (kind === 'seller' ? 'seller' : 'shop') }) })
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return db.mail.update(rec.id, { status: 'sent', sent_at: Date.now() });
  } catch (e) {
    console.error('[mail] failed:', e.message);
    return db.mail.update(rec.id, { status: 'failed', error: e.message.slice(0, 300) });
  }
}

// ---------- domain authentication in Brevo (DKIM / Brevo code records in DNS) ----------
async function brevo(path, method = 'GET', body) {
  const r = await fetch(`https://api.brevo.com/v3${path}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'api-key': config.mail.brevoKey, accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  return { ok: r.ok, status: r.status, body: j };
}

/**
 * Add the site's domain to Brevo (once), ask Brevo to check its DNS, and remember the result.
 * Logs the DNS records to add while the domain is not yet authenticated. Safe to call repeatedly.
 */
async function setupDomain() {
  if (!config.mail.brevoKey) return { skipped: 'no BREVO_API_KEY' };
  let host; try { host = new URL(config.publicBaseUrl).hostname; } catch { return { skipped: 'no PUBLIC_BASE_URL' }; }
  if (!/^https:/.test(config.publicBaseUrl) || /onrender\.com$|localhost/.test(host)) return { skipped: 'no custom domain' };
  const domain = host.replace(/^www\./, '');
  const saved = db.settings.get(DOMAIN_ID);
  if (saved && saved.domain === domain && saved.authenticated && saved.sender_ready) return saved;

  let info = await brevo(`/senders/domains/${encodeURIComponent(domain)}`);
  if (info.status === 404) {
    const created = await brevo('/senders/domains', 'POST', { name: domain });
    if (!created.ok) throw new Error(`Brevo: could not add ${domain}: ${JSON.stringify(created.body).slice(0, 200)}`);
    console.log(`[mail] domain ${domain} added to Brevo`);
    info = await brevo(`/senders/domains/${encodeURIComponent(domain)}`);
  }
  if (!info.ok) throw new Error(`Brevo: ${info.status} ${JSON.stringify(info.body).slice(0, 200)}`);
  if (!info.body.authenticated) {
    await brevo(`/senders/domains/${encodeURIComponent(domain)}/authenticate`, 'PUT');
    info = await brevo(`/senders/domains/${encodeURIComponent(domain)}`);
  }
  const authenticated = Boolean(info.body.authenticated);
  const doc = { domain, authenticated, verified: Boolean(info.body.verified), dns_records: info.body.dns_records || null, checked_at: Date.now(), sender_ready: Boolean(saved && saved.domain === domain && saved.sender_ready) };
  if (authenticated && !doc.sender_ready) {
    const email = `${config.mail.domainSender}@${domain}`;
    const list = await brevo('/senders');
    if (!(list.body.senders || []).some((s) => String(s.email).toLowerCase() === email)) {
      const add = await brevo('/senders', 'POST', { name: config.mail.fromName, email });
      if (!add.ok) console.warn('[mail] could not add sender', email, JSON.stringify(add.body).slice(0, 200));
    }
    doc.sender_ready = true;
    console.log(`[mail] ${domain} authenticated — emails now go out from ${email}`);
  } else if (!authenticated) {
    console.log(`[mail] ${domain} not authenticated yet — DNS records to add: ${JSON.stringify(doc.dns_records)}`);
  }
  if (saved) db.settings.update(DOMAIN_ID, doc); else db.settings.insert({ id: DOMAIN_ID, ...doc });
  return doc;
}

function domainStatus() { return db.settings.get(DOMAIN_ID) || null; }

function pruneLog() {
  const all = db.mail.all();
  if (all.length > 500) for (const m of all.slice(0, all.length - 500)) db.mail.remove(m.id);
}

module.exports = { langOf, send, enabled, layout, sender, setupDomain, domainStatus };

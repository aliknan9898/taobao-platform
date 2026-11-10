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

/** Simple branded layout. `lines` are plain-text paragraphs; `button` is { text, url }. */
function layout({ title, lines = [], button, rtl = false }) {
  const dir = rtl ? 'rtl' : 'ltr';
  return `<!doctype html><html dir="${dir}"><body style="margin:0;background:#f4f6f9;font-family:Segoe UI,Arial,sans-serif;color:#141b3a">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border:1px solid #e1e5ee;border-radius:14px;padding:24px">
  <div style="font-weight:700;font-size:20px;color:#0e7c66;margin-bottom:12px">kinan</div>
  <h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
  ${lines.map((l) => `<p style="margin:0 0 10px;line-height:1.55">${esc(l)}</p>`).join('')}
  ${button ? `<p style="margin:18px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#0e7c66;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:10px">${esc(button.text)}</a></p>` : ''}
  </div><p style="font-size:12px;color:#6b7290;text-align:center;margin-top:14px">${esc(config.operator.tradingName)} · ${esc(config.operator.name)}</p></div></body></html>`;
}

/** Send (or log) one email. Never throws; returns the log record. `key` makes the send idempotent. */
async function send({ to, subject, title, lines, button, key, kind = 'general', attachments }) {
  if (!to) return null;
  if (key) { const dup = db.mail.find((m) => m.key === key); if (dup) return dup; }
  const rec = db.mail.insert({ to, subject, kind, key: key || null, status: enabled() ? 'sending' : 'not_sent' });
  pruneLog();
  if (!enabled()) { console.log(`[mail] (not sent — email not set up) to=${to} subject="${subject}"${button ? ` link=${button.url}` : ''}`); return rec; }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': config.mail.brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: sender(), ...(config.mail.replyTo ? { replyTo: { email: config.mail.replyTo } } : {}), to: [{ email: to }], ...(attachments ? { attachment: attachments } : {}), subject, htmlContent: layout({ title: title || subject, lines, button }) })
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

module.exports = { send, enabled, layout, sender, setupDomain, domainStatus };

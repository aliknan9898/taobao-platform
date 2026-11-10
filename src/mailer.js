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

const enabled = () => Boolean(config.mail.brevoKey && config.mail.from);
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
async function send({ to, subject, title, lines, button, key, kind = 'general' }) {
  if (!to) return null;
  if (key) { const dup = db.mail.find((m) => m.key === key); if (dup) return dup; }
  const rec = db.mail.insert({ to, subject, kind, key: key || null, status: enabled() ? 'sending' : 'not_sent' });
  pruneLog();
  if (!enabled()) { console.log(`[mail] (not sent — email not set up) to=${to} subject="${subject}"${button ? ` link=${button.url}` : ''}`); return rec; }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': config.mail.brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: config.mail.from, name: config.mail.fromName }, to: [{ email: to }], subject, htmlContent: layout({ title: title || subject, lines, button }) })
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return db.mail.update(rec.id, { status: 'sent', sent_at: Date.now() });
  } catch (e) {
    console.error('[mail] failed:', e.message);
    return db.mail.update(rec.id, { status: 'failed', error: e.message.slice(0, 300) });
  }
}

function pruneLog() {
  const all = db.mail.all();
  if (all.length > 500) for (const m of all.slice(0, all.length - 500)) db.mail.remove(m.id);
}

module.exports = { send, enabled, layout };

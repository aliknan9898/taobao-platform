// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Error reporting to Sentry without the SDK (one HTTPS POST per event, Sentry's envelope format).
 *
 * Off unless SENTRY_DSN is set. What is sent: the error type, message and stack trace, the request method and path
 * (no query string), the release (git commit) and the service name. Never request bodies, headers, cookies, IP
 * addresses or user details. Messages are scrubbed of e-mail addresses, phone numbers, card-like numbers and
 * secret-looking tokens before they leave.
 *
 * Limits: the same error is sent at most once a minute, at most 30 events a minute in total, and Sentry's own
 * rate-limit answers (429 / Retry-After) are respected. Reporting never throws and never delays the caller. */
'use strict';

const crypto = require('crypto');

const PER_MINUTE = 30;
const SAME_ERROR_MS = 60e3;

function parseDsn(dsn) {
  try {
    const u = new URL(String(dsn || '').trim());
    const projectId = u.pathname.replace(/^\/+|\/+$/g, '').split('/').pop();
    if (u.protocol !== 'https:' || !u.username || !/^\d+$/.test(projectId)) return null;
    const prefix = u.pathname.replace(/\/?\d+\/?$/, '');
    return { key: u.username, host: u.host, projectId, url: `https://${u.host}${prefix}/api/${projectId}/envelope/`, dsn: `https://${u.username}@${u.host}${prefix}/${projectId}` };
  } catch { return null; }
}

/** Remove personal data and secrets from free text (messages, stack traces, page paths). */
function scrub(text, max = 2000) {
  return String(text ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(sk|rk|pk|whsec|sk_live|sk_test|pk_live|pk_test)_[A-Za-z0-9_]{8,}/g, '[secret]')
    .replace(/\b(Bearer|Basic) +[^\s"',;]{6,}/g, '$1 [redacted]')
    .replace(/\b(token|access_token|api_key|apikey|key|secret|password|pwd|code|t)(=|: ?)[^\s&#"',;]{4,}/gi, '$1$2[redacted]')
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, '[database-url]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[token]')
    .replace(/\b(?:\d{4}[ -]){3}\d{1,7}\b/g, '[card]') // grouped card numbers (plain long digit runs stay: product ids)
    .replace(/\+\d[\d ()-]{7,}\d/g, '[phone]')
    .slice(0, max);
}

/** Node / V8 stack → Sentry frames (oldest first). */
function frames(stack) {
  const out = [];
  for (const line of String(stack || '').split('\n').slice(1, 40)) {
    const m = line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/) || line.match(/^\s*(.*?)@(.+?):(\d+):(\d+)$/);
    if (!m) continue;
    const file = scrub(m[2], 300);
    out.push({ function: scrub(m[1] || '?', 200), filename: file, lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|node:internal|^node:|chrome-extension:|moz-extension:/.test(file) });
  }
  return out.reverse();
}

function createReporter({ dsn = process.env.SENTRY_DSN, env = process.env, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const target = parseDsn(dsn);
  const sent = new Map(); // fingerprint → last sent time
  let windowStart = 0; let windowCount = 0; let blockedUntil = 0;

  function allow(fingerprint) {
    const t = now();
    if (t < blockedUntil) return false;
    if (t - windowStart > 60e3) { windowStart = t; windowCount = 0; }
    if (windowCount >= PER_MINUTE) return false;
    if (t - (sent.get(fingerprint) || 0) < SAME_ERROR_MS) return false;
    windowCount += 1; sent.set(fingerprint, t);
    if (sent.size > 500) for (const [k, v] of sent) if (t - v > SAME_ERROR_MS) sent.delete(k);
    return true;
  }

  function event({ type, message, stack, platform = 'node', level = 'error', tags = {}, request }) {
    const event_id = crypto.randomBytes(16).toString('hex');
    const value = scrub(message, 2000);
    const st = frames(scrub(stack, 20000));
    return {
      event_id, timestamp: now() / 1000, platform, level, logger: platform === 'javascript' ? 'browser' : 'server',
      environment: env.SENTRY_ENVIRONMENT || (env.RENDER ? 'production' : 'development'),
      ...(env.RENDER_GIT_COMMIT ? { release: String(env.RENDER_GIT_COMMIT).slice(0, 40) } : {}),
      ...(env.RENDER_SERVICE_NAME ? { server_name: String(env.RENDER_SERVICE_NAME).slice(0, 64) } : {}),
      tags: Object.fromEntries(Object.entries(tags).filter(([, v]) => v != null && v !== '').map(([k, v]) => [String(k).slice(0, 32), scrub(v, 200)])),
      ...(request ? { request: { method: String(request.method || '').slice(0, 10), url: scrub(request.url, 500) } } : {}),
      exception: { values: [{ type: scrub(type || 'Error', 100), value, ...(st.length ? { stacktrace: { frames: st } } : {}) }] },
    };
  }

  /** Send one event; resolves to { sent } or { skipped }. Never rejects. */
  async function send(ev) {
    if (!target) return { skipped: 'no SENTRY_DSN' };
    const body = `${JSON.stringify({ event_id: ev.event_id, sent_at: new Date(now()).toISOString(), dsn: target.dsn })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(ev)}\n`;
    try {
      const r = await fetchImpl(target.url, {
        method: 'POST', body, signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=kinan/1.0` },
      });
      if (r.status === 429) { blockedUntil = now() + Math.min(3600, Number(r.headers?.get?.('retry-after')) || 60) * 1000; return { skipped: 'rate limited by Sentry' }; }
      return r.ok ? { sent: ev.event_id } : { skipped: `Sentry answered ${r.status}` };
    } catch (e) { return { skipped: `Sentry unreachable: ${e.name}` }; }
  }

  /** A server error. ctx: { method, path, tags }. */
  function captureException(err, ctx = {}) {
    try {
      if (!target) return Promise.resolve({ skipped: 'no SENTRY_DSN' });
      const e = err instanceof Error ? err : new Error(String(err));
      const fp = `s|${e.name}|${String(e.message).slice(0, 120)}|${ctx.path || ''}`;
      if (!allow(fp)) return Promise.resolve({ skipped: 'limited' });
      const path = String(ctx.path || '').split('?')[0];
      return send(event({ type: e.name, message: e.message, stack: e.stack, tags: { ...ctx.tags, ...(e.code ? { code: e.code } : {}) }, ...(path ? { request: { method: ctx.method, url: path } } : {}) }));
    } catch { return Promise.resolve({ skipped: 'failed' }); }
  }

  /** An error reported by a shopper's browser (already trimmed by the endpoint). */
  function captureBrowser(b = {}) {
    try {
      if (!target) return Promise.resolve({ skipped: 'no SENTRY_DSN' });
      const message = String(b.message || '').slice(0, 1000);
      const stack = String(b.stack || '').slice(0, 8000);
      if (!message) return Promise.resolve({ skipped: 'empty' });
      if (/chrome-extension:|moz-extension:|safari-extension:|ResizeObserver loop/.test(`${message}\n${stack}`)) return Promise.resolve({ skipped: 'not ours' });
      const [where, hash] = String(b.page || '').slice(0, 300).split('#'); const page = where.split('?')[0] + (hash ? `#${hash}` : ''); // no query string
      if (!allow(`b|${message.slice(0, 120)}|${page.split('#')[0]}`)) return Promise.resolve({ skipped: 'limited' });
      const type = (message.match(/^(\w*Error):/) || [])[1] || 'Error';
      return send(event({ type, message: message.replace(/^\w*Error:\s*/, ''), stack: `${type}\n${stack.split('\n').filter((l) => /:\d+:\d+/.test(l)).join('\n')}`, platform: 'javascript', tags: { page: page.split('#')[0] || '/', app: String(b.app || '').slice(0, 20) }, request: { method: 'GET', url: page } }));
    } catch { return Promise.resolve({ skipped: 'failed' }); }
  }

  return { enabled: () => Boolean(target), captureException, captureBrowser };
}

let shared = null;
const reporter = () => (shared ||= createReporter());

module.exports = { createReporter, parseDsn, scrub, frames, captureException: (e, c) => reporter().captureException(e, c), captureBrowser: (b) => reporter().captureBrowser(b), enabled: () => reporter().enabled() };

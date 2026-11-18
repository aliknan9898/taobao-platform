'use strict';
/**
 * Read-only Cloudflare diagnostics for KINAN.
 * Secrets are loaded from environment variables, never returned to callers or logged.
 * No Cloudflare mutations are implemented.
 */
const BASE = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = () => process.env.CLOUDFLARE_ACCOUNT_ID || '';
const TOKEN = () => process.env.CLOUDFLARE_API_TOKEN || '';
const ZONE_ID = () => process.env.CLOUDFLARE_ZONE_ID || '';
const DOMAIN = () => process.env.CLOUDFLARE_ZONE_NAME || 'kinan.shop';

function configured() { return Boolean(TOKEN()); }
function safeError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}
async function get(path, query = {}) {
  if (!configured()) throw safeError('Cloudflare API token is not configured', 503);
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/json' },
    signal: AbortSignal.timeout(12000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const codes = (body.errors || []).map(x => x.code).filter(Boolean);
    throw safeError('Cloudflare request failed (' + res.status + (codes.length ? '; codes ' + codes.join(',') : '') + ')', res.status);
  }
  return body.result;
}
async function zone() {
  if (ZONE_ID()) {
    const z = await get('/zones/' + encodeURIComponent(ZONE_ID()));
    if (z.name !== DOMAIN()) throw safeError('Cloudflare zone does not match configured domain', 409);
    return { id: z.id, name: z.name, status: z.status, paused: z.paused, plan: z.plan?.name || null };
  }
  const zones = await get('/zones', { name: DOMAIN(), per_page: 10 });
  const z = (Array.isArray(zones) ? zones : []).find(x => x.name === DOMAIN());
  if (!z) throw safeError('Cloudflare zone not found or token lacks Zone Read', 404);
  return { id: z.id, name: z.name, status: z.status, paused: z.paused, plan: z.plan?.name || null };
}
async function diagnose() {
  const z = await zone();
  const tasks = {
    dns: () => get('/zones/' + encodeURIComponent(z.id) + '/dns_records', { per_page: 100 }),
    settings: () => get('/zones/' + encodeURIComponent(z.id) + '/settings'),
    cacheRules: () => get('/zones/' + encodeURIComponent(z.id) + '/rulesets/phases/http_request_cache_settings/entrypoint')
  };
  const out = { configured: true, zone: z, checked_at: new Date().toISOString(), checks: {} };
  await Promise.all(Object.entries(tasks).map(async ([name, fn]) => {
    try {
      const result = await fn();
      if (name === 'dns') out.checks.dns = { ok: true, records: result.length, proxied: result.filter(x => x.proxied === true).length, types: [...new Set(result.map(x => x.type))] };
      if (name === 'settings') out.checks.settings = { ok: true, values: Object.fromEntries(result.filter(x => ['brotli', 'http3', 'minify', 'browser_cache_ttl', 'always_use_https', 'rocket_loader', 'early_hints'].includes(x.id)).map(x => [x.id, x.value])) };
      if (name === 'cacheRules') out.checks.cacheRules = { ok: true, rules: (result.rules || []).map(x => ({ id: x.id, enabled: x.enabled, action: x.action, description: x.description || '' })) };
    } catch (e) { out.checks[name] = { ok: false, error: e.message }; }
  }));
  return out;
}
module.exports = { configured, zone, diagnose };

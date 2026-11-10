'use strict';
const { config } = require('../config');
const { signRequest } = require('./sign');

class TaobaoApiError extends Error {
  constructor(message, { code, type, requestId, raw } = {}) {
    super(message);
    this.name = 'TaobaoApiError';
    this.code = code;
    this.type = type;
    this.requestId = requestId;
    this.raw = raw;
  }
  get retryable() {
    return ['ServiceTimeout', 'InternalError', '502'].includes(String(this.code)) || this.type === 'ISP';
  }
}

/** Objects/arrays are sent as JSON strings (IOP convention for complex params). */
function serialize(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Call an Open Platform API.
 * @param {string} apiPath e.g. '/product/get'
 * @param {object} params business params
 * @param {object} opts { accessToken, method: 'GET'|'POST', retries }
 */
async function call(apiPath, params = {}, opts = {}) {
  const { accessToken, method = 'POST', retries = 2 } = opts;
  const sys = {
    app_key: config.appKey,
    timestamp: String(Date.now()), // must be within 7200s of UTC
    sign_method: 'sha256',
    ...(accessToken ? { access_token: accessToken } : {})
  };
  const all = { ...sys };
  for (const [k, v] of Object.entries(params)) {
    const s = serialize(v);
    if (s !== undefined) all[k] = s;
  }
  all.sign = signRequest(apiPath, all, config.appSecret);

  const url = new URL(config.apiUrl + apiPath);
  const body = new URLSearchParams(all);
  let res;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (method === 'GET') {
        url.search = body.toString();
        res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20000) });
      } else {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
          body,
          signal: AbortSignal.timeout(20000)
        });
      }
      if (res.status === 502 || res.status === 503) {
        // Docs: 502 = QPS too high → retry
        lastErr = new TaobaoApiError(`HTTP ${res.status}`, { code: '502' });
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch {
        throw new TaobaoApiError('Non-JSON response', { raw: text.slice(0, 500) });
      }
      const code = json.code ?? json.error_code;
      const failed = (json.code !== undefined && String(json.code) !== '0') || json.success === false || json.success === 'false';
      if (failed) {
        const err = new TaobaoApiError(json.message || json.error_msg || json.msg || `API error ${code}`, {
          code: json.error_code || json.code, type: json.type, requestId: json.request_id, raw: json
        });
        if (err.retryable && attempt < retries) { lastErr = err; await sleep(500 * 2 ** attempt); continue; }
        throw err;
      }
      return json;
    } catch (e) {
      if (e instanceof TaobaoApiError) throw e;
      lastErr = new TaobaoApiError(e.message || 'Network error', { code: 'NETWORK' });
      if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { call, TaobaoApiError };

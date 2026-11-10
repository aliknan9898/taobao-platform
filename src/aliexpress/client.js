// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * AliExpress Open Platform client (IOP gateway, same signing scheme as the Taobao Global platform).
 *  - Business APIs:  POST {apiUrl}/sync   with `method=aliexpress.ds.…`, signature over sorted params only.
 *  - System APIs:    POST {apiUrl}/rest{path} (e.g. /auth/token/create), signature prefixed with the path.
 * Names marked VERIFY come from public SDKs/docs; confirm against the console once the app is approved.
 */
const crypto = require('crypto');
const { config } = require('../config');

const API = {
  AUTHORIZE: '/oauth/authorize',
  TOKEN_CREATE: '/auth/token/create',
  TOKEN_REFRESH: '/auth/token/refresh',
  PRODUCT_GET: 'aliexpress.ds.product.get',          // product_id, ship_to_country, target_currency, target_language
  ORDER_CREATE: 'aliexpress.ds.order.create',        // param_place_order_request4_open_api_d_t_o (VERIFY)
  ORDER_GET: 'aliexpress.trade.ds.order.get',        // single_order_query { order_id } (VERIFY)
  ORDER_CREATE_PARAM: 'param_place_order_request4_open_api_d_t_o',
  ORDER_GET_PARAM: 'single_order_query'
};

class AliExpressError extends Error {
  constructor(message, { code, requestId } = {}) { super(message); this.name = 'AliExpressError'; this.code = code; this.requestId = requestId; }
}

const enabled = () => Boolean(config.aliexpress.appKey && config.aliexpress.appSecret);

function sign(params, path = '') {
  const base = path + Object.keys(params).filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha256', config.aliexpress.appSecret).update(base, 'utf8').digest('hex').toUpperCase();
}

const ser = (v) => (v === undefined || v === null ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Unwrap both response styles: { <method>_response: { result } } and IOP { code, result }. */
function unwrap(j) {
  const key = Object.keys(j || {}).find((k) => k.endsWith('_response'));
  const body = key ? j[key] : j;
  const err = j.error_response || (body && body.code && String(body.code) !== '0' ? body : null);
  if (err) throw new AliExpressError(err.msg || err.message || err.sub_msg || `AliExpress error ${err.code}`, { code: err.code || err.sub_code, requestId: err.request_id });
  const r = body?.result ?? body;
  if (r && r.rsp_code !== undefined && String(r.rsp_code) !== '200' && String(r.rsp_code) !== '0' && r.rsp_msg) throw new AliExpressError(r.rsp_msg, { code: r.rsp_code });
  return r;
}

async function post(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new AliExpressError(`AliExpress returned an unexpected response (${res.status})`); }
  return unwrap(j);
}

/** Business API call (method-style). */
async function call(method, params = {}, accessToken) {
  if (!enabled()) throw new AliExpressError('AliExpress API is not set up');
  const all = { app_key: config.aliexpress.appKey, method, timestamp: String(Date.now()), sign_method: 'sha256', ...(accessToken ? { session: accessToken, access_token: accessToken } : {}) };
  for (const [k, v] of Object.entries(params)) { const s = ser(v); if (s !== undefined) all[k] = s; }
  all.sign = sign(all);
  return post(`${config.aliexpress.apiUrl}/sync`, all);
}

/** System API call (path-style), used for OAuth tokens. */
async function system(path, params = {}) {
  if (!enabled()) throw new AliExpressError('AliExpress API is not set up');
  const all = { app_key: config.aliexpress.appKey, timestamp: String(Date.now()), sign_method: 'sha256' };
  for (const [k, v] of Object.entries(params)) { const s = ser(v); if (s !== undefined) all[k] = s; }
  all.sign = sign(all, path);
  return post(`${config.aliexpress.apiUrl}/rest${path}`, all);
}

module.exports = { API, call, system, sign, enabled, AliExpressError };

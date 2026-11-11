// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Are TAOBAO_APP_KEY / TAOBAO_APP_SECRET right? Exchanges a made-up sign-in code: Taobao answers
 * "invalid code" when the key and signature are accepted, and a key/signature error when they are not.
 */
const { config } = require('../config');
const { call } = require('./client');
const API = require('./apis');

const BAD = /sign|appkey|app_key|api ?key|InvalidApi|IncompleteSignature|InvalidSignature|AppKey/i;
async function check() {
  if (!config.appKey || !config.appSecret) return { ok: false, configured: false, message: 'TAOBAO_APP_KEY / TAOBAO_APP_SECRET are not set' };
  try {
    await call(API.TOKEN_CREATE, { code: 'kinan_credentials_check' }, { retries: 0 });
    return { ok: true, configured: true, message: 'Accepted' };
  } catch (e) {
    const text = `${e.code || ''} ${e.message || ''}`;
    if (BAD.test(text)) return { ok: false, configured: true, message: text.trim() };
    return { ok: true, configured: true, message: `Key and signature accepted (${text.trim().slice(0, 120)})` };
  }
}
module.exports = { check };

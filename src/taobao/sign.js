// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const crypto = require('crypto');

/**
 * Request signature (Open Platform Manual §3.2.5–3.2.6):
 *  1. sort all params (system + business, excluding `sign` and byte arrays) by name, ASCII order
 *  2. concatenate name+value
 *  3. prefix with the API path
 *  4. HMAC-SHA256 with AppSecret, hex UPPERCASE
 * Matches the official Python sample in "Make API Calls Through HTTP Requests"
 * (that page's printed example hash 4190D323… does not follow from its own inputs; the sample code is authoritative).
 */
function signRequest(apiPath, params, appSecret) {
  const base = apiPath + Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && !Buffer.isBuffer(params[k]))
    .sort()
    .map((k) => k + params[k])
    .join('');
  return crypto.createHmac('sha256', appSecret).update(base, 'utf8').digest('hex').toUpperCase();
}

/**
 * Incoming message signature (Manual §8.2.4):
 * Authorization = HEX(HMAC-SHA256(appKey + rawBody, appSecret)), lowercase.
 * The raw body must NOT be parsed/re-serialized before verifying.
 */
function messageSignature(rawBody, appKey, appSecret) {
  return crypto.createHmac('sha256', appSecret).update(appKey + rawBody, 'utf8').digest('hex');
}

function verifyMessage(rawBody, authorizationHeader, appKey, appSecret) {
  if (!authorizationHeader) return false;
  const expected = Buffer.from(messageSignature(rawBody, appKey, appSecret), 'utf8');
  const got = Buffer.from(String(authorizationHeader).trim().toLowerCase(), 'utf8');
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

module.exports = { signRequest, messageSignature, verifyMessage };

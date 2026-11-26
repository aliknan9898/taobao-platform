'use strict';

const { createHash } = require('node:crypto');
const { challenge } = require('../ebay/client');

async function handle(req, res, { url, send, readRaw, publicBaseUrl }) {
  if (req.method === 'GET') {
    const code = url.searchParams.get('challenge_code');
    if (!code || code.length > 512) return send(res, 400, { error: 'Invalid challenge_code' });
    const endpoint = process.env.EBAY_DELETION_ENDPOINT || publicBaseUrl + '/webhooks/ebay/deletion';
    const token = process.env.EBAY_VERIFICATION_TOKEN;
    const challengeResponse = token ? createHash('sha256').update(code).update(token).update(endpoint).digest('hex') : challenge(code, endpoint);
    return send(res, 200, { challengeResponse });
  }
  if (req.method === 'POST') {
    const raw = await readRaw(req);
    try { JSON.parse(raw); } catch { return send(res, 400, { error: 'Invalid notification JSON' }); }
    // Receipt only. Never log the notification body or account identifiers.
    console.info('[ebay] Marketplace account deletion notification received');
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
}

module.exports = { handle };

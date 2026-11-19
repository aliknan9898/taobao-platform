'use strict';

const EXPECTED_USERNAME = 'kinanshop4u';

async function checkConnection() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN?.trim();
  if (!token) return { status: 'not_configured' };

  // Tester tokens use Instagram /me. Unified Login system-user tokens target
  // the assigned Instagram account's numeric ID through Facebook Graph.
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID?.trim();
  if (accountId && !/^\d+$/.test(accountId)) return { status: 'invalid_account_id' };
  const host = accountId ? 'graph.facebook.com' : 'graph.instagram.com';
  const url = new URL(`https://${host}/v24.0/${accountId || 'me'}`);
  url.searchParams.set('fields', 'username');

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || result?.error) {
      const code = result?.error?.code;
      return { status: 'meta_error', httpStatus: response.status, ...(Number.isInteger(code) ? { code } : {}) };
    }
    const username = result?.username;
    if (typeof username !== 'string' || !/^[a-z0-9_.]{1,30}$/i.test(username)) return { status: 'unexpected_response' };
    return { status: username.toLowerCase() === EXPECTED_USERNAME ? 'connected' : 'wrong_account', username };
  } catch {
    return { status: 'unavailable' };
  }
}

module.exports = { checkConnection };

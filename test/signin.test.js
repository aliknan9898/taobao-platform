// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Sign in with Facebook and with a phone number (SMS code). Facebook Graph and Brevo/Twilio are faked. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', ADMIN_GOOGLE_EMAILS: 'boss@x.com', PUBLIC_BASE_URL: 'https://kinan.example',
  FACEBOOK_APP_ID: '111', FACEBOOK_APP_SECRET: 'fbsecret', BREVO_API_KEY: 'brevo_x', SMS_SENDER: 'Kinan' });
delete process.env.CJ_API_KEY; delete process.env.TWILIO_ACCOUNT_SID;

const sms = []; let FB = { id: 'fb1', name: 'Lina Borg', email: 'lina@x.com' };
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.hostname === 'graph.facebook.com') {
    if (u.pathname.endsWith('/oauth/access_token')) { assert.strictEqual(u.searchParams.get('client_secret'), 'fbsecret'); return ok({ access_token: `tok_${u.searchParams.get('code')}` }); }
    if (u.pathname.endsWith('/me')) {
      assert.strictEqual(u.searchParams.get('appsecret_proof'), crypto.createHmac('sha256', 'fbsecret').update(u.searchParams.get('access_token')).digest('hex'));
      return ok(FB);
    }
  }
  if (u.hostname === 'api.brevo.com' && u.pathname === '/v3/transactionalSMS/sms') { sms.push(JSON.parse(opts.body)); return ok({ messageId: 1 }); }
  return realFetch(url, opts);
};

const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body) {
  const res = await realFetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${Math.floor(Math.random() * 200)}` }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j, headers: res.headers };
}
const codeOf = (m) => m.content.match(/\d{6}/)[0];

test('Facebook: sign in creates the customer once, links an existing account by email, never the owner', async () => {
  assert.strictEqual((await api('GET', '/api/config/public')).body.facebook_signin, true);
  const go = await api('GET', '/auth/facebook?app=shop&next=%23%2Fcart');
  assert.strictEqual(go.status, 302);
  const loc = new URL(go.headers.get('location'));
  assert.strictEqual(loc.hostname, 'www.facebook.com'); assert.strictEqual(loc.searchParams.get('redirect_uri'), 'https://kinan.example/auth/facebook/callback');
  const state = loc.searchParams.get('state');
  const back = await api('GET', `/auth/facebook/callback?code=c1&state=${state}`);
  assert.strictEqual(back.status, 302); assert.strictEqual(back.headers.get('location'), '/#/cart');
  assert.match(back.headers.get('set-cookie') || '', /=/);
  const u = db.users.find((x) => x.facebook_id === 'fb1');
  assert.ok(u && u.role === 'buyer' && u.email === 'lina@x.com');
  // the same Facebook account again: same Kinan account
  const s2 = new URL((await api('GET', '/auth/facebook?app=shop')).headers.get('location')).searchParams.get('state');
  await api('GET', `/auth/facebook/callback?code=c2&state=${s2}`);
  assert.strictEqual(db.users.all((x) => x.facebook_id === 'fb1').length, 1);
  // a state used twice is refused
  const again = await api('GET', `/auth/facebook/callback?code=c3&state=${s2}`);
  assert.match(decodeURIComponent(again.headers.get('location')), /expired/);
  // the owner's email cannot be taken over through Facebook
  FB = { id: 'fb_evil', name: 'X', email: 'boss@x.com' };
  const s3 = new URL((await api('GET', '/auth/facebook?app=shop')).headers.get('location')).searchParams.get('state');
  const evil = await api('GET', `/auth/facebook/callback?code=c4&state=${s3}`);
  assert.match(decodeURIComponent(evil.headers.get('location')), /Google or a password/);
  assert.ok(!db.users.find((x) => x.facebook_id === 'fb_evil'));
  // password sign-in for a Facebook-only account explains what to do
  const pw = await api('POST', '/api/auth/login', { email: 'lina@x.com', password: 'whatever', app: 'shop' });
  assert.match(pw.body.error, /Facebook/);
  // Facebook's data deletion callback (signed) unlinks the account
  const payload = Buffer.from(JSON.stringify({ user_id: 'fb1', algorithm: 'HMAC-SHA256' })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'fbsecret').update(payload).digest('base64url');
  const del = await realFetch(`${base}/auth/facebook/delete`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `signed_request=${sig}.${payload}` });
  const dj = await del.json();
  assert.strictEqual(del.status, 200); assert.ok(dj.confirmation_code); assert.match(dj.url, /privacy#data-deletion/);
  assert.ok(!db.users.find((x) => x.facebook_id === 'fb1'));
  const bad = await realFetch(`${base}/auth/facebook/delete`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `signed_request=AAAA.${payload}` });
  assert.strictEqual(bad.status, 400);
});

test('phone: SMS code signs in (new number creates the customer), wrong codes and floods refused', async () => {
  assert.strictEqual((await api('GET', '/api/config/public')).body.phone_signin, true);
  assert.strictEqual((await api('POST', '/api/auth/phone/start', { phone: '12345' })).status, 400);
  assert.match((await api('POST', '/api/auth/phone/start', { phone: '+2348012345678' })).body.error, /not available for this country/);
  const s = await api('POST', '/api/auth/phone/start', { phone: '+356 7912 3456', lang: 'ar' });
  assert.strictEqual(s.status, 200, JSON.stringify(s.body)); assert.match(s.body.phone, /^\+356 •••• 56$/);
  assert.strictEqual(sms.length, 1); assert.strictEqual(sms[0].recipient, '35679123456'); assert.match(sms[0].content, /كنان/);
  assert.strictEqual((await api('POST', '/api/auth/phone/start', { phone: '+35679123456' })).status, 429, 'one SMS a minute');
  const code = codeOf(sms[0]);
  const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  assert.strictEqual((await api('POST', '/api/auth/phone/verify', { phone: '+35679123456', code: wrong })).status, 400);
  const v = await api('POST', '/api/auth/phone/verify', { phone: '0035679123456', code, name: 'Maria' });
  assert.strictEqual(v.status, 200, JSON.stringify(v.body)); assert.strictEqual(v.body.created, true); assert.strictEqual(v.body.user.name, 'Maria');
  assert.match(v.headers.get('set-cookie') || '', /=/);
  assert.strictEqual((await api('POST', '/api/auth/phone/verify', { phone: '+35679123456', code })).status, 400, 'a code works once');
  // next time: same account, not a new one
  const id = db.oauthStates.all((x) => x.kind === 'phone')[0].id; db.oauthStates.update(id, { sent: [] });
  await api('POST', '/api/auth/phone/start', { phone: '+35679123456' });
  const v2 = await api('POST', '/api/auth/phone/verify', { phone: '+35679123456', code: codeOf(sms[1]) });
  assert.strictEqual(v2.body.created, false); assert.strictEqual(db.users.all((x) => x.phone_login === '+35679123456').length, 1);
  // 5 wrong tries end the code
  db.oauthStates.update(id, { sent: [] });
  await api('POST', '/api/auth/phone/start', { phone: '+35679123456' });
  for (let i = 0; i < 5; i++) await api('POST', '/api/auth/phone/verify', { phone: '+35679123456', code: '000000' === codeOf(sms[2]) ? '111111' : '000000' });
  assert.strictEqual((await api('POST', '/api/auth/phone/verify', { phone: '+35679123456', code: codeOf(sms[2]) })).status, 429);
});

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* The owner's email gives no rights until Google confirms it: sign-ups with it are refused, password accounts
   someone made with it are not the owner, and the first Google sign-in drops whatever password or sessions were on it. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-'));
Object.assign(process.env, { ADMIN_EMAIL: 'owner@gmail.com', PUBLIC_BASE_URL: 'https://kinan.example' });
delete process.env.ADMIN_PASSWORD; delete process.env.ADMIN_GOOGLE_EMAILS;

const auth = require('../src/auth');
const db = require('../src/db');
const g = require('../src/googleAuth');
const { server } = require('../src/server');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const api = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('a stranger cannot become admin by signing up with the owner’s email', async () => {
  // Sign-up with the owner's address is refused, for both apps and any spelling
  for (const [role, email] of [['buyer', 'owner@gmail.com'], ['seller', 'Owner@Gmail.com']]) {
    const r = await api('POST', '/api/auth/register', { role, email, password: 'attacker123', name: 'x', shop_name: 'x' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body)); assert.match(r.body.error, /Google/);
  }

  // An account made with the address before this fix (password, no Google) is not the owner and can't sign in with a password
  const old = db.users.insert({ email: 'owner@gmail.com', role: 'buyer', status: 'active', pass: auth.hashPassword('attacker123') });
  assert.strictEqual(auth.isOwner(old), false);
  const tok = auth.createSession(old).token; // e.g. a session it already had
  assert.strictEqual((await api('GET', '/api/admin/overview', null, tok)).status, 403, 'no admin rights');
  const login = await api('POST', '/api/auth/login', { email: 'owner@gmail.com', password: 'attacker123', app: 'shop' });
  assert.strictEqual(login.status, 401); assert.match(login.body.error, /Google/);

  // The one-time clean-up after the update ends its sessions and drops its password
  assert.strictEqual(auth.secureOwnerAccounts(), 1);
  assert.strictEqual(auth.secureOwnerAccounts(), 0, 'only once');
  assert.strictEqual((await api('GET', '/api/me', null, tok)).status, 401);
  assert.strictEqual(db.users.get(old.id).pass, null);

  // The real owner signs in with Google: that account becomes theirs and gets every app
  const again = auth.createSession({ ...db.users.get(old.id), status: 'active' }).token; // pretend someone got a session again
  const u = g._upsertUser({ sub: 'g-owner', email: 'owner@gmail.com', name: 'Ali' }, 'shop');
  assert.strictEqual(u.id, old.id); assert.strictEqual(u.google_sub, 'g-owner'); assert.strictEqual(auth.isOwner(u), true);
  assert.strictEqual((await api('GET', '/api/me', null, again)).status, 401, 'sessions from before the Google link are ended');
  const mine = auth.createSession(u).token;
  assert.strictEqual((await api('GET', '/api/admin/overview', null, mine)).status, 200);
  assert.strictEqual((await api('GET', '/api/me', null, mine)).body.owner, true);

  // Another Google account with a different identity can't take it over
  assert.throws(() => g._upsertUser({ sub: 'g-other', email: 'owner@gmail.com' }, 'shop'), /mismatch/);

  // Ordinary customers are not affected
  const c = await api('POST', '/api/auth/register', { role: 'buyer', email: 'customer@x.com', password: 'customer123', name: 'C' });
  assert.strictEqual(c.status, 201);
  assert.strictEqual((await api('POST', '/api/auth/login', { email: 'customer@x.com', password: 'customer123', app: 'shop' })).status, 200);
});

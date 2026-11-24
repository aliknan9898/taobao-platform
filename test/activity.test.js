'use strict';
/* Admin → Activity log: customer and seller actions are recorded with date, time, type and result; bodies never
   (no passwords, addresses or message text); staff entries stay owner-only; filters and paging work. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
Object.assign(process.env, { ADMIN_EMAIL: 'admin@x.com', ADMIN_PASSWORD: 'adminpass1', SHIPPING_FLAT_FEE: '8' });
delete process.env.TELEGRAM_BOT_TOKEN;

const db = require('../src/db');
const { server } = require('../src/server');

test('activity log: who did what, when, with type and result', async (t) => {
  require('../src/auth').bootstrapAdmin();
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body, token) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const aLogin = await api('POST', '/api/auth/login', { email: 'admin@x.com', password: 'adminpass1' });
  const aTok = aLogin.body.token; assert.ok(aTok, JSON.stringify(aLogin.body));
  const reg = await api('POST', '/api/auth/register', { role: 'buyer', accept_terms: true, email: 'buyer@x.com', password: 'buyerpass1', name: 'Mona' });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual((await api('POST', '/api/auth/login', { email: 'buyer@x.com', password: 'wrong-password' })).status, 401);
  const bTok = (await api('POST', '/api/auth/login', { email: 'buyer@x.com', password: 'buyerpass1' })).body.token;
  assert.ok(bTok);
  await api('PATCH', '/api/buyer/profile', { name: 'Mona K', phone: '+356 7900 0000' }, bTok);
  await api('POST', '/api/auth/logout', null, bTok);

  const allRes = await api('GET', '/api/admin/activity?limit=50', null, aTok); assert.strictEqual(allRes.status, 200, JSON.stringify(allRes.body) + ' tok:' + Boolean(aTok)); const all = allRes.body;
  const actions = all.items.map((x) => x.action);
  for (const a of ['Created an account', 'Signed in', 'Updated the profile', 'Signed out']) assert.ok(actions.includes(a), `${a} in ${actions}`);
  const failed = all.items.find((x) => x.action === 'Signed in' && !x.ok);
  assert.ok(failed, 'a failed sign-in is recorded');
  assert.strictEqual(failed.actor.email, 'buyer@x.com'); assert.strictEqual(failed.status, 401);
  const out = all.items.find((x) => x.action === 'Signed out');
  assert.strictEqual(out.actor.email, 'buyer@x.com', 'sign-out still knows who');
  const profile = all.items.find((x) => x.action === 'Updated the profile');
  assert.strictEqual(profile.category, 'account'); assert.strictEqual(profile.actor.role, 'buyer'); assert.ok(profile.at > 0 && profile.ok);
  const raw = JSON.stringify(db.activity.all());
  for (const secret of ['buyerpass1', 'wrong-password', '7900']) assert.ok(!raw.includes(secret), `${secret} must not be stored`);
  assert.ok(!all.items.some((x) => x.actor?.role === 'admin'), 'the admin sign-in is staff activity, not here');

  // filters
  const acc = (await api('GET', '/api/admin/activity?category=account&failed=1', null, aTok)).body;
  assert.ok(acc.items.length >= 1 && acc.items.every((x) => x.category === 'account' && !x.ok));
  assert.strictEqual((await api('GET', '/api/admin/activity?who=seller', null, aTok)).body.items.length, 0);
  assert.ok((await api('GET', '/api/admin/activity?q=buyer%40x.com', null, aTok)).body.items.length >= 4);
  assert.ok(all.counts.account >= 5);
  // paging: "before" continues where the page stopped
  const p1 = (await api('GET', '/api/admin/activity?limit=2', null, aTok)).body;
  const p2 = (await api('GET', `/api/admin/activity?limit=2&before=${p1.more}`, null, aTok)).body;
  assert.ok(p1.more && p2.items.every((x) => x.at < p1.more));

  // staff audit entries are owner-only; customers cannot read the log
  assert.ok(!all.items.some((x) => x.category === 'staff') || (await api('GET', '/api/me', null, aTok)).body.owner);
  assert.strictEqual((await api('GET', '/api/admin/activity', null, bTok)).status, 401);
});

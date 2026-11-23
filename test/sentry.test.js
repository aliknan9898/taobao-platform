'use strict';
/* Sentry reporting without the SDK: off without a DSN, the envelope Sentry expects, no personal data or secrets,
   and limits that keep a burst of errors from flooding Sentry. Uses a fake fetch: nothing leaves the machine. */
const test = require('node:test');
const assert = require('node:assert');
const { createReporter, parseDsn, scrub, frames } = require('../src/sentry');

const DSN = 'https://abc123publickey@o4501.ingest.de.sentry.io/4509876';
function fake(status = 200, headers = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] } }; };
  return { calls, fetchImpl };
}
const parse = (body) => body.trim().split('\n').map((l) => JSON.parse(l));

test('DSN: parsed into the envelope URL; anything else switches reporting off', () => {
  const d = parseDsn(DSN);
  assert.strictEqual(d.url, 'https://o4501.ingest.de.sentry.io/api/4509876/envelope/');
  assert.strictEqual(d.key, 'abc123publickey');
  for (const bad of ['', 'nonsense', 'http://k@host/1', 'https://host/1', 'https://k@host/notanumber']) assert.strictEqual(parseDsn(bad), null, bad);
});

test('without SENTRY_DSN nothing is sent', async () => {
  const f = fake(); const r = createReporter({ dsn: '', env: {}, fetchImpl: f.fetchImpl });
  assert.strictEqual(r.enabled(), false);
  assert.deepStrictEqual(await r.captureException(new Error('x')), { skipped: 'no SENTRY_DSN' });
  assert.deepStrictEqual(await r.captureBrowser({ message: 'x' }), { skipped: 'no SENTRY_DSN' });
  assert.strictEqual(f.calls.length, 0);
});

test('server error: one envelope with type, message, stack, path, release; no query string', async () => {
  const f = fake();
  const r = createReporter({ dsn: DSN, env: { RENDER: 'true', RENDER_GIT_COMMIT: 'deadbeef', RENDER_SERVICE_NAME: 'kinan-17ma' }, fetchImpl: f.fetchImpl });
  const e = new TypeError('Cannot read properties of undefined (reading \'price\')');
  const out = await r.captureException(e, { method: 'GET', path: '/api/catalog/42?email=a@b.com', tags: { error_id: 'ab12', status: 500 } });
  assert.ok(out.sent);
  assert.strictEqual(f.calls.length, 1);
  const { url, opts } = f.calls[0];
  assert.strictEqual(url, 'https://o4501.ingest.de.sentry.io/api/4509876/envelope/');
  assert.match(opts.headers['X-Sentry-Auth'], /sentry_version=7, sentry_key=abc123publickey/);
  const [head, item, ev] = parse(opts.body);
  assert.strictEqual(head.event_id, ev.event_id); assert.strictEqual(item.type, 'event');
  assert.strictEqual(ev.exception.values[0].type, 'TypeError');
  assert.match(ev.exception.values[0].value, /reading 'price'/);
  assert.ok(ev.exception.values[0].stacktrace.frames.some((fr) => /sentry\.test\.js$/.test(fr.filename) && fr.in_app));
  assert.deepStrictEqual(ev.request, { method: 'GET', url: '/api/catalog/42' });
  assert.strictEqual(ev.release, 'deadbeef'); assert.strictEqual(ev.environment, 'production'); assert.strictEqual(ev.server_name, 'kinan-17ma');
  assert.strictEqual(ev.tags.error_id, 'ab12');
});

test('scrubbing: e-mails, phones, grouped card numbers, secrets, database URLs and long tokens never leave', () => {
  const s = scrub('user ali@example.com +44 7700 900123 card 4242 4242 4242 4242 key sk_live_abcdefgh12345 Bearer eyJhbGciOiJIUzI1NiJ9.x '
    + 'postgres://u:pw@h/db token=abcdef123 /reset#t=s3cr3tvalue ' + 'a'.repeat(50) + ' product 1005006853589194');
  for (const leak of ['ali@example.com', '7700 900123', '4242 4242', 'sk_live_abcdefgh', 'eyJhbGci', 'u:pw@h', 'abcdef123', 's3cr3tvalue', 'a'.repeat(50)]) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
  assert.ok(s.includes('1005006853589194'), 'product ids stay readable');
  assert.ok(scrub("can't connect to the database").includes("can't connect"), 'ordinary words untouched');
});

test('the stack is scrubbed too, and frames are oldest first', () => {
  const st = frames('Error: x\n    at inner (/app/src/a.js:10:5)\n    at outer (/app/src/b.js:20:7)\n    at node:internal/process:1:1');
  assert.deepStrictEqual(st.map((f) => f.function), ['?', 'outer', 'inner']);
  assert.strictEqual(st[st.length - 1].function, 'inner');
  assert.strictEqual(st[0].in_app, false, 'node internals are not app code');
});

test('limits: the same error once a minute, 30 a minute in total, and Sentry\'s 429 pauses sending', async () => {
  let t = 1_000_000; const f = fake();
  const r = createReporter({ dsn: DSN, env: {}, fetchImpl: f.fetchImpl, now: () => t });
  await r.captureException(new Error('same'), { path: '/x' });
  assert.deepStrictEqual(await r.captureException(new Error('same'), { path: '/x' }), { skipped: 'limited' });
  for (let i = 0; i < 40; i += 1) await r.captureException(new Error(`e${i}`));
  assert.strictEqual(f.calls.length, 30);
  t += 61e3;
  assert.ok((await r.captureException(new Error('same'), { path: '/x' })).sent, 'allowed again after a minute');

  const busy = fake(429, { 'retry-after': '120' }); let t2 = 5_000_000;
  const r2 = createReporter({ dsn: DSN, env: {}, fetchImpl: busy.fetchImpl, now: () => t2 });
  assert.deepStrictEqual(await r2.captureException(new Error('a')), { skipped: 'rate limited by Sentry' });
  t2 += 60e3; await r2.captureException(new Error('b'));
  assert.strictEqual(busy.calls.length, 1, 'no call while Sentry asked us to wait');
  t2 += 61e3; await r2.captureException(new Error('c'));
  assert.strictEqual(busy.calls.length, 2);
});

test('Sentry down or slow: reporting resolves quietly, never throws', async () => {
  const r = createReporter({ dsn: DSN, env: {}, fetchImpl: async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); } });
  assert.deepStrictEqual(await r.captureException(new Error('x')), { skipped: 'Sentry unreachable: TimeoutError' });
});

test('browser errors: forwarded as javascript events; extension noise and empty reports dropped', async () => {
  const f = fake(); const r = createReporter({ dsn: DSN, env: {}, fetchImpl: f.fetchImpl });
  const out = await r.captureBrowser({ message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at paint (https://kinan.shop/:1200:15)', page: '/?ref=mail#/p/42', app: 'shop' });
  assert.ok(out.sent);
  const ev = parse(f.calls[0].opts.body)[2];
  assert.strictEqual(ev.platform, 'javascript'); assert.strictEqual(ev.exception.values[0].type, 'TypeError');
  assert.strictEqual(ev.exception.values[0].value, 'x is undefined');
  assert.strictEqual(ev.request.url, '/#/p/42', 'query string dropped, hash route kept');
  assert.strictEqual(ev.exception.values[0].stacktrace.frames[0].function, 'paint');
  assert.deepStrictEqual(await r.captureBrowser({ message: 'boom', stack: 'at x (chrome-extension://abc/x.js:1:1)' }), { skipped: 'not ours' });
  assert.deepStrictEqual(await r.captureBrowser({}), { skipped: 'empty' });
  assert.strictEqual(f.calls.length, 1);
});

test('POST /api/client-error reaches Sentry through the real server (fake Sentry, temporary data)', async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-'));
  process.env.SENTRY_DSN = DSN;
  const realFetch = global.fetch; const toSentry = [];
  global.fetch = async (url, opts) => (String(url).includes('sentry.io') ? (toSentry.push(opts.body), { status: 200, ok: true, headers: { get: () => null } }) : realFetch(url, opts));
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await realFetch(`${base}/api/client-error`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'TypeError: boom for ali@example.com', stack: 'at f (https://kinan.shop/:1:1)', page: '/#/cart', app: 'shop' }) });
    assert.strictEqual(res.status, 200);
    for (let i = 0; i < 20 && !toSentry.length; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(toSentry.length, 1);
    const ev = parse(toSentry[0])[2];
    assert.strictEqual(ev.platform, 'javascript'); assert.match(ev.exception.values[0].value, /boom for \[email\]/);
    assert.strictEqual((await realFetch(`${base}/api/client-error`, { method: 'POST', body: 'not json' })).status, 400);
  } finally { global.fetch = realFetch; server.close(); delete process.env.SENTRY_DSN; }
});

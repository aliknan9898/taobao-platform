'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-digest-'));
const push = require('../src/push');
const report = require('../src/services/importDigest');

test('imports send one Telegram message per source after midnight in Malta', async (t) => {
  const messages = [];
  t.mock.method(push, 'telegram', async (message) => { messages.push(message); return true; });
  const before = Date.parse('2026-11-20T22:59:00Z');
  const after = Date.parse('2026-11-20T23:05:00Z');
  report.record('CJ catalog', { checked: 3, skipped: 1, reasons: { stock: 1 } },
    [{ status: 'active' }, { status: 'pending_review' }], [{ reason: 'stock' }], before);
  report.record('AliExpress', { checked: 4, skipped: 3 }, [{ status: 'active' }], [], before);
  assert.equal(await report.tick(before), false);
  assert.deepEqual(await Promise.all([report.tick(after), report.tick(after)]), [true, false]);
  assert.equal(await report.tick(after), false);
  assert.equal(messages.length, 2);
  const cj = messages.find((m) => /CJ catalog/.test(m));
  const ae = messages.find((m) => /AliExpress/.test(m));
  assert.ok(cj && ae);
  assert.doesNotMatch(cj, /AliExpress/);
  assert.doesNotMatch(ae, /CJ catalog/);
  for (const m of messages) assert.match(m, /2026-11-20/);
  assert.match(cj, /stock: 1/);
  assert.match(cj, /نُشر: 1 · بانتظار النشر: 1 · رُفض: 1/);
});

test('a failed Telegram send retries only the sources not yet sent', async (t) => {
  const messages = [];
  let fail = true;
  t.mock.method(push, 'telegram', async (message) => {
    if (/CJ best sellers/.test(message) && fail) return false;
    messages.push(message);
    return true;
  });
  const before = Date.parse('2026-11-21T22:00:00Z');
  const after = Date.parse('2026-11-21T23:10:00Z');
  report.record('AliExpress', { checked: 2 }, [{ status: 'active' }], [], before);
  report.record('CJ best sellers', { checked: 5 }, [], [], before);
  assert.equal(await report.tick(after), false);
  fail = false;
  assert.equal(await report.tick(after), true);
  assert.equal(messages.filter((m) => /AliExpress/.test(m)).length, 1);
  assert.equal(messages.filter((m) => /CJ best sellers/.test(m)).length, 1);
});

test('midnight in Malta splits the reports by day; each day is sent once, the oldest first', async (t) => {
  const messages = [];
  t.mock.method(push, 'telegram', async (message) => { messages.push(message); return true; });
  // 23:50 and 00:10 Malta time (UTC+1) on 22/23 November
  report.record('AliExpress', { checked: 1 }, [{ status: 'active' }], [], Date.parse('2026-11-22T22:50:00Z'));
  report.record('AliExpress', { checked: 2 }, [{ status: 'active' }], [], Date.parse('2026-11-22T23:10:00Z'));
  const nextNight = Date.parse('2026-11-23T23:05:00Z');
  assert.equal(await report.tick(nextNight), true);
  assert.equal(await report.tick(nextNight), false); // one report per tick day
  assert.equal(await report.tick(Date.parse('2026-11-24T23:05:00Z')), true);
  const ae = messages.filter((m) => /AliExpress/.test(m));
  assert.equal(ae.length, 2);
  assert.match(ae[0], /2026-11-22/);
  assert.match(ae[1], /2026-11-23/);
});

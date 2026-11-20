'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-digest-'));
const push = require('../src/push');
const report = require('../src/services/importDigest');

test('imports send one combined Telegram digest after midnight in Malta', async (t) => {
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
  assert.equal(messages.length, 1);
  assert.match(messages[0], /2026-11-20/);
  assert.match(messages[0], /CJ catalog/);
  assert.match(messages[0], /AliExpress/);
  assert.match(messages[0], /stock: 1/);
  assert.match(messages[0], /نُشر: 1 · بانتظار النشر: 1 · رُفض: 1/);
});

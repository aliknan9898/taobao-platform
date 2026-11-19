'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const push = require('../src/push');
const cj = require('../src/cj/client');
const report = require('../src/services/cjReport');

test('CJ Telegram report keeps published, pending and rejected products distinct and delivers all pages', async (t) => {
  const messages = [];
  t.mock.method(push, 'telegram', async (message) => { messages.push(message); return true; });
  t.mock.method(cj, 'usage', () => ({ points: { remaining: 856, total: 50278, refill_per_minute: 35 } }));
  const rejected = Array.from({ length: 90 }, (_, i) => ({ pid: `cj-${i}`, title: `Rejected product ${i}`, reason: 'low stock' }));
  assert.equal(await report.send({ checked: 92, skipped: 90 }, [
    { id: 'live-id', pid: 'cj-live', title: 'Live product', status: 'active' },
    { id: 'pending-id', pid: 'cj-pending', title: 'Pending product', status: 'pending_review' },
  ], rejected, 'تقرير اختبار'), true);

  const text = messages.join('\n');
  assert.match(text, /تم النشر: 1 · بانتظار النشر: 1 · مرفوض: 90/);
  assert.match(text, /CJ points: 856\/50278/);
  assert.match(text, /#\/p\/live-id/);
  assert.doesNotMatch(text, /#\/p\/pending-id/);
  assert.ok(messages.length > 1 && messages.every((message) => message.length <= 3400));
  for (const p of rejected) assert.ok(text.includes(`[CJ: ${p.pid}] — low stock`), p.pid);
});

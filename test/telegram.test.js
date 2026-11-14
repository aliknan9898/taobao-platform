// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Telegram: linking with a one-time code (Telegram API mocked), morning report once a day. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: '123:abc', CAMPAIGNS_JSON: '[]', TELEGRAM_OUTBOX_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tgo-')) });
delete process.env.TELEGRAM_CHAT_ID; delete process.env.CJ_API_KEY; delete process.env.STRIPE_SECRET_KEY;

const sent = []; let UPDATES = []; let REFUSE = 0;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); const body = opts.body ? JSON.parse(opts.body) : {};
  assert.ok(u.hostname === 'api.telegram.org');
  const method = u.pathname.split('/').pop();
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
  if (method === 'getMe') return ok({ username: 'KinanAlertsBot' });
  if (method === 'getUpdates') return ok(UPDATES.filter((x) => x.update_id >= (body.offset || 0)));
  if (method === 'sendMessage') { if (REFUSE > 0) { REFUSE--; return { ok: false, status: 400, json: async () => ({ ok: false }) }; } sent.push(body); return ok({}); }
  throw new Error(method);
};

const db = require('../src/db');
const tg = require('../src/services/telegram');
const push = require('../src/push');
const wait = () => new Promise((r) => setTimeout(r, 1300));

test('Telegram: link with the one-time code only, then a morning report once a day', async () => {
  const s = await tg.status();
  assert.strictEqual(s.bot, 'KinanAlertsBot');
  assert.ok(!s.linked);
  const code = s.link.split('start=')[1];
  assert.match(code, /^[0-9a-f]{8}$/);
  UPDATES = [{ update_id: 5, message: { text: '/start wrong', chat: { id: 666, type: 'private' } } }];
  assert.strictEqual(await tg.poll(), null, 'a stranger cannot link');
  assert.ok(!push.tgOn());
  UPDATES.push({ update_id: 6, message: { text: `/start ${code}`, chat: { id: 4242, type: 'private', first_name: 'Ali' } } });
  assert.strictEqual(await tg.poll(), true);
  assert.ok(push.tgOn());
  await wait();
  assert.strictEqual(sent[0].chat_id, '4242');
  assert.match(sent[0].text, /connected/);
  // the report: before 9:00 Malta nothing, at 9:00 once
  db.orders.insert({ buyer_id: 'u1', status: 'delivered', paid_at: Date.now() - 3600e3, total: 25, channel: 'ebay', lines: [] });
  const morning = (h) => Date.UTC(2026, 10, 20, h - 1, 5); // Malta = UTC+1 in November
  assert.strictEqual(await tg.tick(morning(8)), null);
  assert.strictEqual(await tg.tick(morning(9)), true);
  assert.strictEqual(await tg.tick(morning(10)), null, 'once a day');
  await wait();
  const rep = sent[sent.length - 1].text;
  assert.match(rep, /Kinan — 2026-11-20/);
  assert.match(tg.report(), /1 paid order\(s\), 25 .* \(1 from eBay\)/);
  assert.match(rep, /Product safety \(GPSR\)/);
  await wait();
  // a report Telegram did not take is tried again later the same day (not lost until tomorrow)
  const nextDay = (h, m = 5) => Date.UTC(2026, 10, 21, h - 1, m);
  REFUSE = 1;
  assert.strictEqual(await tg.tick(nextDay(9)), false);
  assert.strictEqual(await tg.tick(nextDay(9, 20)), null, 'not again right away');
  assert.strictEqual(await tg.tick(nextDay(9, 40)), true, 'sent on the next try');
  assert.strictEqual(await tg.tick(nextDay(11)), null);
  assert.match(sent[sent.length - 1].text, /Kinan — 2026-11-21/);
  tg.unlink(); assert.ok(!push.tgOn());
});

test('Telegram outbox: each file is sent once, long ones split into parts', async () => {
  UPDATES = []; const code = (await tg.status()).link.split('start=')[1];
  UPDATES.push({ update_id: 50, message: { text: `/start ${code}`, chat: { id: 77, type: 'private' } } }); await tg.poll(); await wait();
  const dir = process.env.TELEGRAM_OUTBOX_DIR;
  fs.writeFileSync(path.join(dir, '2026-11-14-review.txt'), `Report\n\n${'x'.repeat(3000)}\n\n${'y'.repeat(3000)}`);
  const before = sent.length;
  assert.strictEqual(await tg.sendOutbox(), 1);
  await wait(); await wait(); await wait();
  assert.strictEqual(sent.length - before, 2, 'split in two');
  assert.strictEqual(await tg.sendOutbox(), 0, 'not again');
  tg.unlink();
});

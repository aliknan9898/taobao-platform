// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Brevo domain setup: add domain, then switch the sender to noreply@domain once authenticated. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'));
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://kinan.example', BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'owner@gmail.com', CONTACT_EMAIL: 'support@kinan.example' });

let exists = false, authed = false; const calls = []; let sent = null;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); const m = opts.method || 'GET'; calls.push(`${m} ${u.pathname}`);
  const res = (status, j) => ({ ok: status < 300, status, text: async () => JSON.stringify(j) });
  if (u.pathname === '/v3/senders/domains/kinan.example' && m === 'GET') return exists ? res(200, { domain: 'kinan.example', authenticated: authed, verified: authed, dns_records: { dkim_record: { type: 'TXT', host_name: 'mail._domainkey', value: 'k=rsa;p=X' } } }) : res(404, { code: 'document_not_found' });
  if (u.pathname === '/v3/senders/domains' && m === 'POST') { exists = true; return res(201, { id: 1 }); }
  if (u.pathname.endsWith('/authenticate')) return res(200, { message: 'checking' });
  if (u.pathname === '/v3/senders' && m === 'GET') return res(200, { senders: [] });
  if (u.pathname === '/v3/senders' && m === 'POST') return res(201, { id: 2 });
  if (u.pathname === '/v3/smtp/email') { sent = JSON.parse(opts.body); return res(201, { messageId: 'x' }); }
  throw new Error(`unexpected ${m} ${u.pathname}`);
};

const db = require('../src/db');
const mailer = require('../src/mailer');

test('domain setup and sender switch', async () => {
  await db.init();
  const d1 = await mailer.setupDomain();
  assert.strictEqual(d1.authenticated, false);
  assert.ok(calls.includes('POST /v3/senders/domains'));
  assert.strictEqual(mailer.sender().email, 'owner@gmail.com', 'keeps MAIL_FROM until DNS is verified');

  authed = true; calls.length = 0;
  const d2 = await mailer.setupDomain();
  assert.strictEqual(d2.authenticated, true);
  assert.ok(calls.includes('POST /v3/senders'), 'adds noreply sender');
  assert.strictEqual(mailer.sender().email, 'noreply@kinan.example');

  await mailer.send({ to: 'a@b.com', subject: 'Hi', lines: ['x'] });
  assert.deepStrictEqual(sent.sender, { email: 'noreply@kinan.example', name: 'Kinan' });
  assert.deepStrictEqual(sent.replyTo, { email: 'support@kinan.example' });

  calls.length = 0;
  await mailer.setupDomain();
  assert.deepStrictEqual(calls, [], 'nothing more to do');
});

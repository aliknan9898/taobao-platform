'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mail = require('../src/services/adminMail');

test('Admin mail reads only KINAN recipients and sends only from verified addresses', async (t) => {
  Object.assign(process.env, {
    ADMIN_MAIL_GOOGLE_CLIENT_ID: 'test-client',
    ADMIN_MAIL_GOOGLE_CLIENT_SECRET: 'test-secret',
    ADMIN_MAIL_GMAIL_REFRESH_TOKEN: 'test-refresh'
  });
  const address = 'support@kinan.shop';
  let verified = false;
  let sent;
  t.mock.method(global, 'fetch', async (input, options) => {
    const url = new URL(input);
    const response = (data) => ({ ok: true, json: async () => data });
    if (url.hostname === 'oauth2.googleapis.com') return response({ access_token: 'test', expires_in: 3600 });
    if (url.pathname.endsWith('/settings/sendAs')) return response({
      sendAs: [{ sendAsEmail: address, verificationStatus: verified ? 'accepted' : 'pending' }]
    });
    if (url.pathname.endsWith('/messages/send')) {
      sent = Buffer.from(JSON.parse(options.body).raw, 'base64url').toString();
      return response({ id: 'sent' });
    }
    if (url.pathname.endsWith('/messages')) return response({ messages: [{ id: 'work' }, { id: 'personal' }] });
    const work = url.pathname.endsWith('/work');
    return response({ id: work ? 'work' : 'personal', payload: {
      mimeType: 'text/plain', headers: [{ name: 'To', value: work ? address : 'personal@example.com' }],
      body: { data: Buffer.from('message body').toString('base64url') }
    } });
  });
  assert.deepEqual((await mail.inbox(address)).messages.map((message) => message.id), ['work']);
  assert.equal((await mail.read(address, 'work')).text, 'message body');
  await assert.rejects(mail.read(address, 'personal'), { status: 404 });
  const draft = { from: address, to: 'customer@example.com', subject: 'Test', text: 'Hello' };
  await assert.rejects(mail.send(draft), { status: 409 });
  await assert.rejects(mail.send({ ...draft, to: 'bad@example.org\r\nBcc: other@example.com' }), { status: 400 });
  verified = true;
  assert.equal((await mail.send(draft)).id, 'sent');
  assert.match(sent, /From: support@kinan.shop\r\nTo: customer@example.com/);
});

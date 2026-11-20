// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
'use strict';

const { httpError } = require('../auth');
const addresses = ['hello', 'info', 'sellers', 'support'].map((name) => name + '@kinan.shop');
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/i;
let access;

function enabled() {
  return Boolean(process.env.ADMIN_MAIL_GOOGLE_CLIENT_ID && process.env.ADMIN_MAIL_GOOGLE_CLIENT_SECRET && process.env.ADMIN_MAIL_GMAIL_REFRESH_TOKEN);
}

function mailbox(value) {
  if (!addresses.includes(value)) throw httpError(400, 'Choose a KINAN email address');
  return value;
}

async function token() {
  if (!enabled()) throw httpError(503, 'Connect the Gmail account that receives KINAN email first');
  if (access?.expires > Date.now()) return access.value;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: process.env.ADMIN_MAIL_GOOGLE_CLIENT_ID,
      client_secret: process.env.ADMIN_MAIL_GOOGLE_CLIENT_SECRET, refresh_token: process.env.ADMIN_MAIL_GMAIL_REFRESH_TOKEN
    }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw httpError(502, 'Gmail authorization needs attention');
  access = { value: data.access_token, expires: Date.now() + Math.max(0, (Number(data.expires_in) || 0) - 60) * 1000 };
  return access.value;
}

async function gmail(path, body) {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + await token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw httpError(response.status === 404 ? 404 : 502, 'Gmail could not complete this request');
  return response.json();
}

const header = (message, name) => message.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value || '';
const recipients = (message) => ['to', 'cc', 'delivered-to', 'x-original-to']
  .flatMap((name) => header(message, name).toLowerCase().split(/[\s<>,;]+/));
const view = (message) => ({
  id: message.id, from: header(message, 'from'), subject: header(message, 'subject'),
  at: Number(message.internalDate) || 0, snippet: message.snippet || ''
});

async function inbox(address, pageToken) {
  const from = mailbox(address);
  const params = new URLSearchParams({ q: '{to:' + from + ' cc:' + from + ' deliveredto:' + from + '} -in:sent', maxResults: '10' });
  if (pageToken) params.set('pageToken', pageToken);
  const result = await gmail('messages?' + params);
  const messages = await Promise.all((result.messages || []).map(({ id }) => gmail('messages/' + encodeURIComponent(id) + '?format=metadata')));
  return {
    messages: messages.filter((message) => recipients(message).includes(from)).map(view),
    next_page_token: result.nextPageToken || null
  };
}

function plainText(part) {
  if (!part || part.filename || part.mimeType === 'message/rfc822') return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  return (part.parts || []).map(plainText).filter(Boolean).join('\n');
}

async function read(address, id) {
  const from = mailbox(address);
  const message = await gmail('messages/' + encodeURIComponent(id) + '?format=full');
  if (!recipients(message).includes(from)) throw httpError(404, 'Message not found for this address');
  return { ...view(message), text: (plainText(message.payload) || message.snippet || '').slice(0, 30000) };
}

async function send(body) {
  const from = mailbox(body?.from);
  const to = String(body.to || '').trim();
  const subject = String(body.subject || '').trim();
  const text = String(body.text || '').trim();
  if (to.length > 254 || !emailPattern.test(to) || !subject || subject.length > 140 || /[\r\n]/.test(subject) || !text || text.length > 30000) {
    throw httpError(400, 'Enter one valid recipient, a subject and a message');
  }
  const { sendAs = [] } = await gmail('settings/sendAs');
  if (!sendAs.some((entry) => entry.sendAsEmail.toLowerCase() === from && (entry.isPrimary || entry.verificationStatus === 'accepted'))) {
    throw httpError(409, 'Verify this address in Gmail Send mail as before sending');
  }
  const raw = [
    'From: ' + from, 'To: ' + to, 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(text).toString('base64').match(/.{1,76}/g).join('\r\n')
  ].join('\r\n');
  return { id: (await gmail('messages/send', { raw: Buffer.from(raw).toString('base64url') })).id };
}

module.exports = { enabled, inbox, read, send };

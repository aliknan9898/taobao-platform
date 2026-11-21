'use strict';
/* When Anthropic says the credit is used up, Claude is skipped for 6 hours and Gemini answers straight away. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aicredit-'));
delete process.env.DATABASE_URL;
Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-test-key-0000000000000000', GEMINI_API_KEY: 'g-test' });
delete process.env.AI_PROVIDER;
const ai = require('../src/services/ai');

test('credit used up: one Claude attempt, then Gemini only', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('anthropic.com')) { calls.push('claude'); return { ok: false, status: 400, json: async () => ({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) }; }
    calls.push('gemini');
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: {} }) };
  });
  const req = { system: 's', name: 'answer', schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, text: 'hello' };
  assert.deepEqual(await ai.structured(req), { ok: true });
  assert.deepEqual(await ai.structured(req), { ok: true });
  assert.deepEqual(calls, ['claude', 'gemini', 'gemini']);
  assert.deepEqual(ai.providers(), ['gemini']);
  ai._claudeOff(0);
  assert.deepEqual(ai.providers(), ['claude', 'gemini']);
});

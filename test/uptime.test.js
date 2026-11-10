// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.PUBLIC_BASE_URL = 'https://kinan.example';
process.env.UPTIMEROBOT_API_KEY = 'u1-abc';
const calls = []; let monitors = [];
global.fetch = async (url, opts) => {
  const m = String(url).split('/').pop(); const b = new URLSearchParams(opts.body); calls.push(m);
  assert.strictEqual(b.get('api_key'), 'u1-abc');
  const ok = (j) => ({ json: async () => ({ stat: 'ok', ...j }) });
  if (m === 'getMonitors') return ok({ monitors });
  if (m === 'getAlertContacts') return ok({ alert_contacts: [{ id: '11' }, { id: '22' }] });
  if (m === 'newMonitor') { assert.strictEqual(b.get('url'), 'https://kinan.example/healthz'); assert.strictEqual(b.get('alert_contacts'), '11_0_0-22_0_0'); monitors = [{ id: 9, url: b.get('url') }]; return ok({ monitor: { id: 9 } }); }
  throw new Error(m);
};
const uptime = require('../src/services/uptime');
test('creates the monitor once', async () => {
  assert.deepStrictEqual(await uptime.setup(), { ok: true, id: 9, created: true, contacts: 2 });
  assert.deepStrictEqual(await uptime.setup(), { ok: true, id: 9, created: false });
  assert.deepStrictEqual(calls, ['getMonitors', 'getAlertContacts', 'newMonitor', 'getMonitors']);
});

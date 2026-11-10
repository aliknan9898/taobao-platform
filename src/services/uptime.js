// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Outside monitoring with UptimeRobot (UPTIMEROBOT_API_KEY): makes sure a monitor checks
 * <site>/healthz every 5 minutes and alerts every contact on the account (email by default) if the
 * site goes down. The regular check also keeps a free Render service from going to sleep.
 */
const { config } = require('../config');

const API = 'https://api.uptimerobot.com/v2';
async function call(method, params = {}) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ api_key: process.env.UPTIMEROBOT_API_KEY, format: 'json', ...params })
  });
  const j = await r.json().catch(() => ({}));
  if (j.stat !== 'ok') throw new Error(`UptimeRobot ${method}: ${j.error?.message || j.error?.type || r.status}`);
  return j;
}

async function setup() {
  if (!process.env.UPTIMEROBOT_API_KEY) return { skipped: 'no key' };
  if (!/^https:\/\//.test(config.publicBaseUrl)) return { skipped: 'no public https address' };
  const url = `${config.publicBaseUrl}/healthz`;
  const list = await call('getMonitors', { search: new URL(url).hostname });
  const existing = (list.monitors || []).find((m) => m.url === url);
  if (existing) return { ok: true, id: existing.id, created: false };
  const contacts = (await call('getAlertContacts')).alert_contacts || [];
  const out = await call('newMonitor', {
    type: '1', url, friendly_name: 'Kinan — kinan.shop', interval: '300',
    ...(contacts.length ? { alert_contacts: contacts.map((c) => `${c.id}_0_0`).join('-') } : {})
  });
  console.log(`[uptime] monitor created for ${url} (alerts to ${contacts.length} contact(s))`);
  return { ok: true, id: out.monitor?.id, created: true, contacts: contacts.length };
}

module.exports = { setup };

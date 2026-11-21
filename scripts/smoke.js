#!/usr/bin/env node
// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Read-only smoke check of a running Kinan: pages and public APIs answer, fast enough, with the right content.
 *   node scripts/smoke.js https://staging.example.com      (or SMOKE_URL=…)
 * Sends only GET requests: safe against production too. Exit code 1 when a check fails.
 */
const base = String(process.argv[2] || process.env.SMOKE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const SLOW_MS = Number(process.env.SMOKE_SLOW_MS) || 5000;
const checks = [
  ['/healthz', (r, t) => r.status === 200 && t.trim() === 'ok'],
  ['/', (r, t) => r.status === 200 && /<html/i.test(t) && /Kinan/i.test(t)],
  ['/seller', (r, t) => r.status === 200 && /<html/i.test(t)],
  ['/admin', (r, t) => r.status === 200 && /<html/i.test(t)],
  ['/warehouse', (r, t) => r.status === 200 && /<html/i.test(t)],
  ['/api/config/public', (r, t) => r.status === 200 && JSON.parse(t).brand === 'Kinan'],
  ['/api/catalog?limit=2', (r, t) => r.status === 200 && Array.isArray(JSON.parse(t).items ?? JSON.parse(t))],
  ['/api/admin/users', (r) => r.status === 401], // must refuse without sign-in
  ['/api/buyer/orders', (r) => r.status === 401]
];

(async () => {
  let failed = 0; const rows = [];
  for (const [p, ok] of checks) {
    const t0 = Date.now(); let pass = false; let note = '';
    try {
      const r = await fetch(base + p, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const text = await r.text(); const ms = Date.now() - t0;
      pass = ok(r, text); note = `${r.status} ${ms} ms ${text.length} B`;
      if (pass && ms > SLOW_MS) { pass = false; note += ' (slow)'; }
    } catch (e) { note = e.message; }
    if (!pass) failed++;
    rows.push(`${pass ? 'PASS' : 'FAIL'}  ${p.padEnd(24)} ${note}`);
  }
  console.log(`Smoke check ${base}\n${rows.join('\n')}\n${failed ? `${failed} failed` : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})();

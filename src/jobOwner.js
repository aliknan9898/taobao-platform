// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Who runs the scheduled jobs (supplier imports, order sync, payouts, Telegram reports…).
 *
 * Exactly one process must run them. Two layers:
 *  1. Configuration (safe default):
 *       RUN_JOBS=0  never run jobs here (e.g. a preview or a second web service)
 *       RUN_JOBS=1  always eligible
 *       unset       eligible only on the Render service listed in JOBS_SERVICE (names or ids; default the kinan
 *                   service: "kinan", its slug "kinan-17ma" and its id), or locally
 *                   (no RENDER_SERVICE_NAME). A copy of the app under another Render name stays web-only.
 *  2. With PostgreSQL, an eligible process must also hold a session-level advisory lock, so two instances of
 *     the same service (or an overlapping deploy) never run the jobs twice. The lock is released automatically
 *     when the process or its connection ends; the others retry every minute and take over.
 */
const LOCK_KEY = 0x4b494e41; // "KINA"

function eligible(env = process.env) {
  if (env.RUN_JOBS === '0') return { ok: false, why: 'RUN_JOBS=0' };
  if (env.RUN_JOBS === '1') return { ok: true, why: 'RUN_JOBS=1' };
  // Render's RENDER_SERVICE_NAME is the service slug (kinan → "kinan-17ma"); RENDER_SERVICE_ID is stable.
  const owners = String(env.JOBS_SERVICE || 'kinan,kinan-17ma,srv-dbpdpl08v5cc73dvt3bg').split(',').map((x) => x.trim()).filter(Boolean);
  const name = env.RENDER_SERVICE_NAME; const id = env.RENDER_SERVICE_ID;
  if (!name && !id) return { ok: true, why: 'local process' };
  if ((name && owners.includes(name)) || (id && owners.includes(id))) return { ok: true, why: `Render service "${name || id}"` };
  return { ok: false, why: `Render service "${name || id}" is not the jobs owner (${owners.join(', ')})` };
}

/**
 * Start `start()` once this process owns the jobs. Resolves to a handle: { owner, stop() }.
 * `pool` is a pg Pool (or null in JSON mode, where the process is alone with its files).
 */
async function run(start, { pool = null, env = process.env, retryMs = 60e3, log = console } = {}) {
  const handle = { owner: false, client: null, timer: null, stopped: false };
  handle.stop = async () => {
    handle.stopped = true; clearTimeout(handle.timer);
    if (handle.client) { try { await handle.client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* connection gone: lock gone */ } handle.client.release(); handle.client = null; }
  };
  const e = eligible(env);
  if (!e.ok) { log.log(`[jobs] not running scheduled jobs here: ${e.why}`); return handle; }
  if (!pool) { handle.owner = true; log.log(`[jobs] running scheduled jobs (${e.why}, no shared database)`); start(); return handle; }
  const attempt = async () => {
    if (handle.stopped || handle.owner) return;
    let client = null;
    try {
      client = await pool.connect();
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
      if (rows[0] && rows[0].got) {
        handle.client = client; handle.owner = true;
        // if this connection dies, the lock is gone: stop counting as owner and compete again
        client.on?.('error', () => { handle.owner = false; handle.client = null; log.warn('[jobs] lock connection lost'); });
        log.log(`[jobs] running scheduled jobs (${e.why}, lock held)`);
        start();
        return;
      }
      client.release(); client = null;
      log.log('[jobs] another instance runs the scheduled jobs; checking again in a minute');
    } catch (err) {
      if (client) client.release();
      log.warn('[jobs] lock check failed:', err.message);
    }
    if (!handle.stopped) { handle.timer = setTimeout(attempt, retryMs); handle.timer.unref?.(); }
  };
  await attempt();
  return handle;
}

module.exports = { eligible, run, LOCK_KEY };

'use strict';
/* Scheduled jobs run in exactly one process (src/jobOwner.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { eligible, run } = require('../src/jobOwner');

const quiet = { log() {}, warn() {} };

/** A pg Pool double whose advisory lock is shared by every pool made from the same "database". */
function database() {
  const state = { holder: null };
  let n = 0;
  return {
    state,
    pool() {
      return {
        async connect() {
          const me = ++n;
          return {
            async query(sql) {
              if (/pg_try_advisory_lock/.test(sql)) { if (state.holder === null) { state.holder = me; return { rows: [{ got: true }] }; } return { rows: [{ got: state.holder === me }] }; }
              if (/pg_advisory_unlock/.test(sql)) { if (state.holder === me) state.holder = null; return { rows: [{}] }; }
              return { rows: [] };
            },
            release() {}, on() {}
          };
        }
      };
    }
  };
}

test('configuration: only the kinan service (or a local run) is eligible by default', () => {
  assert.equal(eligible({ RENDER_SERVICE_NAME: 'kinan' }).ok, true);
  assert.equal(eligible({ RENDER_SERVICE_NAME: 'kinan-17ma', RENDER_SERVICE_ID: 'srv-dbpdpl08v5cc73dvt3bg' }).ok, true); // what Render really sets
  assert.equal(eligible({ RENDER_SERVICE_NAME: 'taobao-platform', RENDER_SERVICE_ID: 'srv-dbpd2dmc6qcc73ab5g30' }).ok, false);
  assert.equal(eligible({ RENDER_SERVICE_NAME: 'taobao-platform' }).ok, false);
  assert.equal(eligible({}).ok, true);
  assert.equal(eligible({ RENDER_SERVICE_NAME: 'kinan', RUN_JOBS: '0' }).ok, false);
  assert.equal(eligible({ RENDER_SERVICE_NAME: 'other', RUN_JOBS: '1' }).ok, true);
  assert.equal(eligible({ RENDER_SERVICE_NAME: 'kinan-eu', JOBS_SERVICE: 'kinan-eu' }).ok, true);
});

test('two instances on one database: the jobs start once; the other takes over when the first stops', async () => {
  const db = database();
  let starts = 0;
  const env = { RENDER_SERVICE_NAME: 'kinan' };
  const a = await run(() => starts++, { pool: db.pool(), env, retryMs: 20, log: quiet });
  const b = await run(() => starts++, { pool: db.pool(), env, retryMs: 20, log: quiet });
  assert.equal(starts, 1);
  assert.equal(a.owner, true);
  assert.equal(b.owner, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(starts, 1); // still once while the first holds the lock
  await a.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(starts, 2); // the second instance took over
  assert.equal(b.owner, true);
  await b.stop();
});

test('a second web service on the same repository never runs the jobs', async () => {
  const db = database();
  let starts = 0;
  const h = await run(() => starts++, { pool: db.pool(), env: { RENDER_SERVICE_NAME: 'taobao-platform' }, log: quiet });
  assert.equal(starts, 0);
  assert.equal(db.state.holder, null);
  await h.stop();
});

test('JSON mode (no shared database): an eligible process runs the jobs', async () => {
  let starts = 0;
  const h = await run(() => starts++, { pool: null, env: {}, log: quiet });
  assert.equal(starts, 1);
  await h.stop();
});

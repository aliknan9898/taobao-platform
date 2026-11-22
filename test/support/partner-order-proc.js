'use strict';
/* Child process for the partner order tests: sends the same order N times concurrently against the shared test
   PostgreSQL, or crashes right after COMMIT (mode "crash"). Prints one JSON line with the outcomes. */
const [, , dataDir, storeJson, key, bodyJson, count, mode] = process.argv;
process.env.DATA_DIR = dataDir; process.env.PARTNER_ORDERS_ENABLED = '1'; process.env.NODE_ENV = 'test';
const { Pool } = require('./minipg');
require('../../src/partner/pg').setPool(Pool({ user: 'kinan_test', database: 'kinan_test', host: process.env.KINAN_TEST_PG_HOST || '127.0.0.1' }));
const orders = require('../../src/partner/orders');
const ctx = { env: 'sandbox', store: JSON.parse(storeJson) };
const body = JSON.parse(bodyJson);
(async () => {
  if (mode === 'crash') {
    await orders.createOrder(ctx, body, key, { afterCommit: () => { process.stdout.write(JSON.stringify({ crashed: true }) + '\n'); process.exit(3); } });
    return;
  }
  const res = await Promise.allSettled(Array.from({ length: Number(count) }, () => orders.createOrder(ctx, body, key)));
  process.stdout.write(JSON.stringify(res.map((r) => (r.status === 'fulfilled' ? { ok: r.value.status, id: r.value.body.order_id, replayed: r.value.replayed } : { err: r.reason.code || r.reason.message }))) + '\n');
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ fatal: e.message }) + '\n'); process.exit(1); });

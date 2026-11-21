'use strict';
/* Task 04: encrypted off-site backups, retention, and a restore into an empty staging store that reconciles
   a product, its photo and an order. Synthetic data, fake R2. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
delete process.env.DATABASE_URL;
const KEY = crypto.randomBytes(32).toString('base64');
Object.assign(process.env, { BACKUP_ENCRYPTION_KEY: KEY, R2_ACCOUNT_ID: 'acc', BACKUP_R2_ACCESS_KEY_ID: 'kid', BACKUP_R2_SECRET_ACCESS_KEY: 'sec' });

const db = require('../src/db');
const backup = require('../src/services/backup');

// fake private bucket
const bucket = new Map();
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  assert.equal(u.hostname, 'acc.r2.cloudflarestorage.com');
  assert.match(opts.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=kid\//);
  const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'));
  if (opts.method === 'PUT') { bucket.set(key, Buffer.from(opts.body)); return { ok: true, status: 200, text: async () => '' }; }
  if (opts.method === 'DELETE') { bucket.delete(key); return { ok: true, status: 204, text: async () => '' }; }
  if (opts.method === 'GET' && u.searchParams.get('list-type') === '2') {
    return { ok: true, status: 200, text: async () => `<ListBucketResult>${[...bucket.keys()].map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>` };
  }
  throw new Error(`unexpected ${opts.method} ${url}`);
};

function seed() {
  const seller = db.sellers.insert({ shop_name: 'Atlas', status: 'active' });
  const l = db.listings.insert({ seller_id: seller.id, title: 'Table Lamp', status: 'active', images: ['https://supplier.example/lamp.jpg'], skus: [{ mp_sku_id: '1', price: 20, stock: 5 }] });
  db.media.insert({ url: 'https://supplier.example/lamp.jpg', hosted: 'https://img.kinan.shop/p/lamp.jpg' });
  const o = db.orders.insert({ buyer_id: 'usr_x', status: 'paid', total: 25, currency: 'usd', lines: [{ line_no: 1, listing_id: l.id, qty: 1, price: 20, seller_id: seller.id }] });
  db.ledger.insert({ order_id: o.id, seller_id: seller.id, type: 'sale', gross: 20, commission: 2, net: 18 });
  db.kyc_docs?.insert?.({ seller_id: seller.id, kind: 'id', data: 'private' });
  return { l, o };
}

test('the file is encrypted: unreadable without the key, and a changed byte is detected', () => {
  seed();
  const snap = backup.snapshot();
  const file = backup.encrypt(snap, KEY);
  assert.ok(file.subarray(0, 4).equals(Buffer.from('KNB1')));
  assert.ok(!file.includes(Buffer.from('Table Lamp')), 'no plain text inside');
  assert.equal(backup.decrypt(file, KEY).collections.listings[0].title, 'Table Lamp');
  assert.throws(() => backup.decrypt(file, crypto.randomBytes(32).toString('base64')));
  const bad = Buffer.from(file); bad[bad.length - 1] ^= 1;
  assert.throws(() => backup.decrypt(bad, KEY));
});

test('retention: every day for 30 days, then the first of each month for 12 months', () => {
  const keys = [];
  for (let d = 0; d < 500; d++) { const day = new Date(Date.parse('2026-11-21') - d * 86400e3).toISOString().slice(0, 10); keys.push(`db/${day}/kinan-${day}.knb`); }
  const gone = new Set(backup.expired(keys, Date.parse('2026-11-21T12:00:00Z'), { keepDays: 30, keepMonths: 12 }));
  const kept = keys.filter((k) => !gone.has(k));
  assert.ok(kept.includes('db/2026-11-21/kinan-2026-11-21.knb'));
  assert.ok(kept.includes('db/2026-10-23/kinan-2026-10-23.knb')); // 29 days
  assert.ok(gone.has('db/2026-10-15/kinan-2026-10-15.knb'));
  assert.ok(kept.includes('db/2026-03-01/kinan-2026-03-01.knb')); // first of a month, within 12 months
  assert.ok(gone.has('db/2025-08-01/kinan-2025-08-01.knb')); // over 12 months
  assert.equal(kept.length, 30 + 12 - 1); // November's first is inside the 30 days
});

test('a backup run uploads one encrypted file to the private bucket and records its age', async () => {
  const r = await backup.run({ reason: 'manual' });
  assert.ok(r.key.startsWith('db/') && r.key.endsWith('.knb'));
  assert.ok(bucket.has(r.key));
  assert.equal(crypto.createHash('sha256').update(bucket.get(r.key)).digest('hex'), r.sha256);
  const st = backup.status();
  assert.equal(st.enabled, true);
  assert.ok(st.age_hours < 0.1);
  assert.equal(st.last.counts.orders, 1);
});

test('restore into an empty staging store reconciles the product, its photo and the order (script, timed)', async () => {
  const key = backup.status().last.key;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bkf-')), 'latest.knb');
  fs.writeFileSync(file, bucket.get(key));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
  const env = { ...process.env, DATA_DIR: target, RESTORE_CONFIRM: 'staging', BACKUP_ENCRYPTION_KEY: KEY };
  delete env.DATABASE_URL;
  const out = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore-backup.js'), file], { env, encoding: 'utf8' }).replace(/^\[db\].*\n/m, ''));
  assert.equal(out.reconcile.ok, true, JSON.stringify(out.reconcile.problems));
  assert.equal(out.reconcile.product.title, 'Table Lamp');
  assert.equal(out.reconcile.product.photos[0].kinan_copy, 'https://img.kinan.shop/p/lamp.jpg');
  assert.equal(out.reconcile.order.total_ok, true);
  assert.equal(out.reconcile.order.ledger_ok, true);
  assert.ok(out.restore_ms >= 0 && out.backup_age_hours >= 0);
  // a second restore into the same (now full) store is refused
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore-backup.js'), file], { env, encoding: 'utf8', stdio: 'pipe' }), /not empty/);
  // the production database is refused, and so is a run without RESTORE_CONFIRM
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore-backup.js'), file], { env: { ...env, DATABASE_URL: 'postgres://u:p@dpg-dbpgoi08v5cc73e7cvo0-a.virginia-postgres.render.com/kinan_db' }, stdio: 'pipe' }), /production/);
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore-backup.js'), file], { env: { ...env, RESTORE_CONFIRM: '' }, stdio: 'pipe' }), /RESTORE_CONFIRM/);
});

test('off until configured: no key, no upload', async () => {
  const saved = process.env.BACKUP_ENCRYPTION_KEY; delete process.env.BACKUP_ENCRYPTION_KEY;
  assert.equal(backup.enabled(), false);
  assert.ok((await backup.run()).skipped);
  process.env.BACKUP_ENCRYPTION_KEY = saved;
});

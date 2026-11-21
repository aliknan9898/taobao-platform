'use strict';
/* Task 03: a retried checkout, a replayed payment and a crash in the middle of a save never create a second order
   or a second money movement. Synthetic data, demo payments, fake PostgreSQL. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paydur-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', PUBLIC_BASE_URL: 'https://kinan.example', AI_AUTO_REVIEW: 'off', CAMPAIGNS_JSON: '[]', XMAS_AUTO: '0' });
for (const k of ['STRIPE_SECRET_KEY', 'CJ_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL']) delete process.env[k];

const auth = require('../src/auth');
const db = require('../src/db');
const orders = require('../src/services/orders');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const login = async (e, p) => (await api('POST', '/api/auth/login', { email: e, password: p })).body.token;
const addr = { name: 'C', phone: '+966', country_code: 'SA', city: 'Riyadh', line1: 'St 1' };
let cust; let items;

test('setup: a seller product and a customer', async () => {
  const boss = await login('boss@x.com', 'adminpass1');
  const reg = (await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email: 'sel@x.com', password: 'sellerpass', shop_name: 'Atlas' })).body;
  await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, boss);
  const sel = await login('sel@x.com', 'sellerpass');
  const p = (await api('POST', '/api/seller/products/manual', { title: 'Table Lamp', category: 'home', weight_kg: 1, images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], variants: [{ name: 'One', price: 20, stock: 10 }] }, sel)).body;
  await api('POST', `/api/admin/listings/${p.id}/approve`, null, boss);
  await api('POST', '/api/auth/register', { role: 'buyer', email: 'c@x.com', password: 'buyerpass1', name: 'C' });
  cust = await login('c@x.com', 'buyerpass1');
  items = [{ listing_id: p.id, mp_sku_id: db.listings.get(p.id).skus[0].mp_sku_id, qty: 1 }];
});

test('checkout retried after a restart (key token lost): the same order comes back, no second order', async () => {
  const key = 'retry-after-restart-1';
  const first = await api('POST', '/api/buyer/checkout', { items, shipping_address: addr }, cust, { 'Idempotency-Key': key });
  assert.ok([200, 201].includes(first.status), JSON.stringify(first.body));
  const before = db.orders.all().length;
  // restart between "order saved" and "key token saved": the token is gone, the in-memory map is empty
  for (const t of db.tokens.all((x) => x.kind === 'idem')) db.tokens.remove(t.id);
  const again = await api('POST', '/api/buyer/checkout', { items, shipping_address: addr }, cust, { 'Idempotency-Key': key });
  assert.ok([200, 201].includes(again.status));
  assert.equal(again.body.id, first.body.id);
  assert.equal(db.orders.all().length, before);
  // the same key with a different cart is refused
  const other = await api('POST', '/api/buyer/checkout', { items: [{ ...items[0], qty: 2 }], shipping_address: addr }, cust, { 'Idempotency-Key': key });
  assert.equal(other.status, 409);
});

test('double tap: two checkouts with one key at the same time make one order', async () => {
  const key = 'double-tap-key-1';
  const n = db.orders.all().length;
  const [a, b] = await Promise.all([1, 2].map(() => api('POST', '/api/buyer/checkout', { items, shipping_address: addr }, cust, { 'Idempotency-Key': key })));
  assert.equal(a.body.id, b.body.id);
  assert.equal(db.orders.all().length, n + 1);
});

test('payment replayed after a partial save: the seller is credited once, the wallet debited once', async () => {
  const o = (await api('POST', '/api/buyer/checkout', { items, shipping_address: addr }, cust)).body;
  await orders.markPaid(o.id, { provider: 'demo' });
  assert.equal(db.ledger.all((x) => x.order_id === o.id).length, 1);
  // a crash saved the ledger line but not the order's "paid" status; the payment event comes again
  db.orders.update(o.id, (x) => ({ ...x, status: 'pending_payment', paid_at: undefined }));
  await orders.markPaid(o.id, { provider: 'demo' });
  assert.equal(db.ledger.all((x) => x.order_id === o.id).length, 1);
  assert.equal(db.orders.get(o.id).status === 'pending_payment', false);
  // replays of the event on a paid order change nothing
  await orders.markPaid(o.id, { provider: 'demo' });
  assert.equal(db.ledger.all((x) => x.order_id === o.id).length, 1);
});

test('PostgreSQL save is all-or-nothing: a failure in the middle commits nothing, the retry commits everything', async () => {
  const table = new Map(); let failAt = 0; let calls = 0;
  class TxPool {
    async query(sql, p) { return this._q(sql, p, null); }
    async _q(sql, p, tx) {
      if (/^CREATE TABLE/.test(sql)) return { rows: [] };
      if (/^SELECT coll, doc/.test(sql)) return { rows: [...table.values()].map(([coll, doc]) => ({ coll, doc: JSON.parse(doc) })) };
      const target = tx || table;
      if (/^INSERT INTO kinan_docs/.test(sql)) { calls++; if (failAt && calls === failAt) throw new Error('connection reset'); target.set(`${p[0]}/${p[1]}`, [p[0], p[2]]); return { rows: [] }; }
      if (/^DELETE FROM kinan_docs/.test(sql)) { target.delete(`${p[0]}/${p[1]}`); return { rows: [] }; }
      throw new Error(`unexpected SQL ${sql}`);
    }
    async connect() {
      let tx = null; const self = this;
      return {
        async query(sql, p) {
          if (sql === 'BEGIN') { tx = new Map(table); return { rows: [] }; }
          if (sql === 'COMMIT') { table.clear(); for (const [k, v] of tx) table.set(k, v); tx = null; return { rows: [] }; }
          if (sql === 'ROLLBACK') { tx = null; return { rows: [] }; }
          return self._q(sql, p, tx);
        },
        release() {}
      };
    }
    async end() {}
  }
  for (const k of Object.keys(require.cache)) if (/src[\\/](db|config)\.js$/.test(k)) delete require.cache[k];
  process.env.DATABASE_URL = 'postgres://kinan:x@dpg-test.frankfurt-postgres.render.com/kinan';
  const pdb = require('../src/db');
  await pdb.init({ Pool: TxPool });
  // one change = order paid + seller ledger line (written in the same tick → one batch)
  calls = 0; failAt = 2;
  pdb.orders.insert({ id: 'ord_t', status: 'paid' });
  pdb.ledger.insert({ id: 'led_t', order_id: 'ord_t', net: 10 });
  const saving = pdb.flush();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(table.size, 0, 'the first write was rolled back with the failed second one');
  failAt = 0;
  await saving; // retried after a back-off
  assert.ok(table.has('orders/ord_t') && table.has('ledger/led_t'));
  delete process.env.DATABASE_URL;
  for (const k of Object.keys(require.cache)) if (/src[\\/](db|config)\.js$/.test(k)) delete require.cache[k];
});

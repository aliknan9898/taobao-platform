// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Paying sellers: settings, fees, payout days, PayPal Payouts and Stripe Connect (both faked). */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payouts-'));
Object.assign(process.env, { PAYPAL_CLIENT_ID: 'pp_id', PAYPAL_CLIENT_SECRET: 'pp_secret', PAYPAL_ENV: 'sandbox', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PAYOUT_CURRENCY: 'usd', SALE_CURRENCY: 'usd', PUBLIC_BASE_URL: 'https://kinan.example' });
delete process.env.TELEGRAM_BOT_TOKEN;

const calls = []; let ppItem = 'PENDING';
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); calls.push({ host: u.hostname, path: u.pathname, method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} });
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.hostname === 'api-m.sandbox.paypal.com') {
    if (u.pathname === '/v1/oauth2/token') return ok({ access_token: 'ppt', expires_in: 3600 });
    if (u.pathname === '/v1/payments/payouts' && opts.method === 'POST') return ok({ batch_header: { payout_batch_id: `B${calls.length}` } });
    if (u.pathname.startsWith('/v1/payments/payouts/')) return ok({ items: [{ transaction_status: ppItem, payout_item_fee: { value: '0.25' } }] });
  }
  if (u.hostname === 'api.stripe.com') {
    if (u.pathname === '/v1/accounts' && opts.method === 'POST') return ok({ id: 'acct_1' });
    if (u.pathname === '/v1/account_links') return ok({ url: 'https://connect.stripe.com/setup/x' });
    if (u.pathname === '/v1/accounts/acct_1') return ok({ id: 'acct_1', payouts_enabled: true, details_submitted: true, capabilities: { transfers: 'active' }, external_accounts: { data: [{ object: 'card', brand: 'Visa', last4: '4242' }] } });
    if (u.pathname === '/v1/transfers') return ok({ id: 'tr_1' });
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const db = require('../src/db');
const P = require('../src/services/payouts');
const money = require('../src/services/money');

function seller(extra = {}) {
  const u = db.users.insert({ email: `s${Math.random()}@x.com`, role: 'seller', name: 'S' });
  return db.sellers.insert({ user_id: u.id, shop_name: 'Lina Shop', status: 'active', kyc: { details: { full_name: 'Lina Borg', country: 'MT' } }, ...extra });
}

test('settings: days, minimums and fees per method; the fee is shown and taken from the withdrawal', () => {
  assert.deepStrictEqual(P.settings().days, [1, 4]);
  assert.throws(() => P.save({ days: [] }), /at least one payout day/);
  const v = P.save({ days: [5, 1, 1, 9], hour: 30, methods: { paypal: { fee_pct: 2, fee_fixed: 0.3, min: 25 }, wise: { enabled: false } } });
  assert.deepStrictEqual(v.days, [1, 5]); assert.strictEqual(v.hour, 23);
  assert.deepStrictEqual(v.day_names, ['Monday', 'Friday']); assert.ok(v.next && v.next.weekday);
  assert.strictEqual(v.paypal, true); assert.strictEqual(v.paypal_env, 'sandbox'); assert.strictEqual(v.stripe_connect, true);
  assert.deepStrictEqual(P.feeFor('paypal', 100), { fee: 2.3, net: 97.7, min: 25, enabled: true });
  assert.strictEqual(P.feeFor('wise', 50).enabled, false);
  assert.strictEqual(P.feeFor('bank', 50).fee, 0);
  // the smallest minimum of the methods that are on
  assert.strictEqual(money.minWithdrawal(), 10);
  // next payout day: a Monday-only schedule on a Tuesday is next Monday
  P.save({ days: [1], hour: 10 });
  assert.strictEqual(P.nextPayoutDay(Date.parse('2026-11-17T12:00:00Z')).day, '2026-11-23');
  assert.strictEqual(P.nextPayoutDay(Date.parse('2026-11-23T08:00:00Z')).day, '2026-11-23', 'today before the payout hour');
});

test('PayPal: one tap sends the withdrawal (net of fee); it is paid when PayPal says SUCCESS, back to waiting if it fails', async () => {
  const s = seller();
  const p = db.payouts.insert({ seller_id: s.id, amount: 100, fee: 2.3, net: 97.7, currency: 'usd', details: { method: 'paypal', email: 'lina@pp.test' }, status: 'requested' });
  const out = await P.send(p.id, { id: 'admin1' });
  assert.strictEqual(out.status, 'processing'); assert.strictEqual(out.provider, 'paypal'); assert.match(out.reference, /^PayPal B/);
  const sentBody = JSON.parse(calls.find((c) => c.path === '/v1/payments/payouts' && c.method === 'POST').body);
  assert.deepStrictEqual(sentBody.items[0].amount, { value: '97.70', currency: 'USD' }); assert.strictEqual(sentBody.items[0].receiver, 'lina@pp.test');
  await assert.rejects(P.send(p.id), /not waiting/);
  assert.ok(money.sellerBalance(s.id).requested >= 100, 'still counted while sending');
  await P.checkProcessing();
  assert.strictEqual(db.payouts.get(p.id).status, 'processing');
  ppItem = 'SUCCESS'; await P.checkProcessing();
  assert.strictEqual(db.payouts.get(p.id).status, 'paid'); assert.strictEqual(db.payouts.get(p.id).provider_fee, '0.25');
  // a failed payout goes back to waiting with the reason
  const p2 = db.payouts.insert({ seller_id: s.id, amount: 30, net: 30, currency: 'usd', details: { method: 'paypal', email: 'lina@pp.test' }, status: 'requested' });
  await P.send(p2.id); ppItem = 'FAILED'; await P.checkProcessing();
  assert.strictEqual(db.payouts.get(p2.id).status, 'requested'); assert.match(db.payouts.get(p2.id).send_error, /FAILED/);
  // bank transfers are paid by hand
  const p3 = db.payouts.insert({ seller_id: s.id, amount: 30, currency: 'usd', details: { method: 'bank', iban: 'X' }, status: 'requested' });
  await assert.rejects(P.send(p3.id), /paid by hand/);
  assert.strictEqual(db.payouts.get(p3.id).status, 'requested');
});

test('PayPal test payment for a new PayPal account', async () => {
  const s = seller({ payout_methods: [{ id: 'pm_a', type: 'paypal', holder: 'Lina Borg', email: 'lina@pp.test', status: 'pending_test', test_amount: 0.37, test_currency: 'USD', created_at: Date.now() }] });
  await P.sendTest(s.id, 'pm_a', { id: 'admin1' });
  assert.strictEqual(db.sellers.get(s.id).payout_methods[0].status, 'test_sent');
  const body = JSON.parse(calls.filter((c) => c.path === '/v1/payments/payouts' && c.method === 'POST').pop().body);
  assert.strictEqual(body.items[0].amount.value, '0.37');
});

test('Stripe Connect: onboarding link, a confirmed card account, transfers paid at once', async () => {
  const s = seller();
  const { url } = await P.stripeOnboard(s);
  assert.match(url, /connect\.stripe\.com/);
  const acc = calls.find((c) => c.path === '/v1/accounts' && c.method === 'POST');
  assert.match(decodeURIComponent(acc.body), /type=express/); assert.strictEqual(acc.headers['Idempotency-Key'], `acct_${s.id}`);
  const link = decodeURIComponent(calls.find((c) => c.path === '/v1/account_links').body);
  assert.match(link, /return_url=https:\/\/kinan\.example\/seller\?stripe=done#\/earnings/);
  const info = await P.stripeRefresh(db.sellers.get(s.id));
  assert.strictEqual(info.payouts_enabled, true); assert.strictEqual(info.destination, 'Visa •••• 4242');
  const m = db.sellers.get(s.id).payout_methods.find((x) => x.type === 'stripe');
  assert.strictEqual(m.status, 'verified'); assert.strictEqual(m.is_default, true);
  await P.stripeRefresh(db.sellers.get(s.id));
  assert.strictEqual(db.sellers.get(s.id).payout_methods.filter((x) => x.type === 'stripe').length, 1, 'not added twice');
  const p = db.payouts.insert({ seller_id: s.id, amount: 40, net: 40, currency: 'usd', details: { method: 'stripe', account: 'acct_1' }, status: 'requested' });
  const out = await P.send(p.id);
  assert.strictEqual(out.status, 'paid'); assert.match(out.reference, /Stripe tr_1/);
  const tr = calls.find((c) => c.path === '/v1/transfers'); tr.body = String(tr.body);
  assert.match(tr.body, /amount=4000/); assert.match(tr.body, /destination=acct_1/); assert.strictEqual(tr.headers['Idempotency-Key'], `tr_${p.id}`);
});

test('payout day: sends PayPal/Stripe automatically when switched on, lists the rest, once a day', async () => {
  for (const p of db.payouts.all((x) => x.status === 'requested')) db.payouts.update(p.id, { status: 'declined' });
  const s = seller();
  const a = db.payouts.insert({ seller_id: s.id, amount: 20, net: 20, currency: 'usd', details: { method: 'stripe', account: 'acct_1' }, status: 'requested' });
  const b = db.payouts.insert({ seller_id: s.id, amount: 20, currency: 'usd', details: { method: 'bank', iban: 'X' }, status: 'requested' });
  P.save({ days: [1], hour: 10, auto: true });
  assert.strictEqual(await P.tick(Date.parse('2026-11-24T12:00:00Z')), null, 'Tuesday: not a payout day');
  assert.strictEqual(await P.tick(Date.parse('2026-11-23T07:00:00Z')), null, 'Monday before 10:00 Malta');
  const r = await P.tick(Date.parse('2026-11-23T10:30:00Z'));
  assert.deepStrictEqual(r, { sent: 1, hand: 1 });
  assert.strictEqual(db.payouts.get(a.id).status, 'paid'); assert.strictEqual(db.payouts.get(b.id).status, 'requested');
  assert.strictEqual(await P.tick(Date.parse('2026-11-23T11:30:00Z')), null, 'once a day');
});

// Regression: a network timeout may occur after the provider accepted a transfer.
test('ambiguous Stripe transfer failure remains in reconciliation, never automatically requeued', async () => {
  const s = seller();
  const p = db.payouts.insert({ seller_id: s.id, amount: 40, net: 40, currency: 'usd', details: { method: 'stripe', account: 'acct_1' }, status: 'requested' });
  const original = global.fetch;
  let attempted = 0;
  global.fetch = async (url, opts) => {
    if (new URL(url).pathname === '/v1/transfers') { attempted++; throw new Error('network timeout after request'); }
    return original(url, opts);
  };
  try {
    await assert.rejects(P.send(p.id, { id: 'admin' }), /network timeout/);
    assert.strictEqual(db.payouts.get(p.id).status, 'processing');
    assert.strictEqual(db.payouts.get(p.id).reconciliation_required, true);
    await assert.rejects(P.send(p.id, { id: 'admin' }), /not waiting/);
    assert.strictEqual(attempted, 1, 'must not attempt another transfer');
  } finally { global.fetch = original; }
});

#!/usr/bin/env node
// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Local staging server for the KINAN Shop mobile pilot (apps/shop-mobile).
   Starts the normal Shop API on an empty temporary data folder (no PostgreSQL, no scheduled jobs) and seeds synthetic
   fixtures: two sellers, approved products, one product that cannot be delivered to Malta, a buyer and a warehouse user.

   Usage:  npm run pilot:staging              (demo payments, labelled MOCK in the app)
           STRIPE_SECRET_KEY=sk_test_… STRIPE_PUBLISHABLE_KEY=pk_test_… STRIPE_WEBHOOK_SECRET=whsec_… npm run pilot:staging
   Only Stripe TEST keys are accepted. Never point this at production data. */
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3999;
if (process.env.DATABASE_URL) { console.error('Refusing to start: DATABASE_URL is set. The pilot staging server only uses a temporary JSON data folder.'); process.exit(1); }
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY']) {
  const v = process.env[k] || '';
  if (v && !/^(sk|pk)_test_/.test(v)) { console.error(`Refusing to start: ${k} is not a Stripe test-mode key.`); process.exit(1); }
}
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-pilot-'));
Object.assign(process.env, {
  NODE_ENV: 'staging', RUN_JOBS: '0', PORT: String(PORT),
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`,
  ADMIN_EMAIL: 'admin@pilot.test', ADMIN_PASSWORD: 'pilot-admin-1'
});

const FIXTURE = {
  buyer: { email: 'buyer@pilot.test', password: 'pilot-buyer-1' },
  sellerA: { email: 'seller-a@pilot.test', password: 'pilot-seller-1', shop: 'Pilot Store A' },
  sellerB: { email: 'seller-b@pilot.test', password: 'pilot-seller-1', shop: 'Pilot Store B' },
  warehouse: { email: 'warehouse@pilot.test', password: 'pilot-warehouse-1' }
};
// A tiny valid JPEG so listings have a photo.
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

async function main() {
  const auth = require('../src/auth');
  const db = require('../src/db');
  const { server } = require('../src/server');
  auth.bootstrapAdmin();
  await new Promise((r) => server.listen(PORT, '0.0.0.0', r));
  const base = `http://127.0.0.1:${PORT}`;
  const api = async (method, p, body, token) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(j)}`);
    return j;
  };
  const login = async (email, password, app) => (await api('POST', '/api/auth/login', { email, password, app })).token;
  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  const seller = async ({ email, password, shop }) => {
    const reg = await api('POST', '/api/auth/register', { role: 'seller', accept_terms: true, email, password, shop_name: shop });
    await api('PATCH', `/api/admin/sellers/${reg.seller_id}`, { status: 'active', verified_manually: true }, admin);
    return login(email, password, 'seller');
  };
  const a = await seller(FIXTURE.sellerA); const b = await seller(FIXTURE.sellerB);
  const product = async (token, title, title_ar, category, variants) => {
    const p = await api('POST', '/api/seller/products/manual', { title, title_ar, category, weight_kg: 0.8, images: [PHOTO], variants }, token);
    await api('POST', `/api/admin/listings/${p.id}/approve`, null, admin);
    return p.id;
  };
  const ids = {
    lamp: await product(a, 'Pilot Desk Lamp', 'مصباح مكتب تجريبي', 'home', [{ name: 'Red', price: 20, stock: 10 }, { name: 'Blue', price: 22, stock: 0 }]),
    mug: await product(a, 'Pilot Mug', 'كوب تجريبي', 'home', [{ name: 'Standard', price: 9.5, stock: 50 }]),
    vase: await product(b, 'Pilot Vase', 'مزهرية تجريبية', 'home', [{ name: 'White', price: 15, stock: 10 }, { name: 'Green', price: 16, stock: 3 }]),
    heater: await product(a, 'Pilot Heater (not for Malta)', 'مدفأة تجريبية (لا تصل إلى مالطا)', 'electronics', [{ name: 'One', price: 30, stock: 10 }])
  };
  for (let i = 1; i <= 24; i++) await product(i % 2 ? a : b, `Pilot Item ${i}`, `منتج تجريبي ${i}`, 'home', [{ name: 'Standard', price: 5 + i, stock: 5 }]);
  // The heater behaves like a supplier (CJ) product with a fresh "cannot deliver to MT" answer.
  db.listings.update(ids.heater, (l) => ({ ...l, source: 'cj', last_synced_at: Date.now() + 365 * 86400e3, skus: l.skus.map((s) => ({ ...s, cj_vid: 'vid_pilot_heater' })), cj_ship: { MT: { none: true, at: Date.now() + 365 * 86400e3, vid: 'vid_pilot_heater' } } }));
  await api('POST', '/api/auth/register', { role: 'buyer', email: FIXTURE.buyer.email, password: FIXTURE.buyer.password, name: 'Pilot Buyer' });
  await api('POST', '/api/admin/staff', { name: 'Pilot Warehouse', email: FIXTURE.warehouse.email, password: FIXTURE.warehouse.password, role: 'warehouse' }, admin);
  await db.flush();

  const payments = (await api('GET', '/api/config/public')).payments;
  console.log(`
KINAN Shop mobile pilot staging is running on port ${PORT} (temporary data: ${process.env.DATA_DIR}, removed on Ctrl+C).
  Android emulator API base URL : http://10.0.2.2:${PORT}
  iOS simulator / desktop       : http://127.0.0.1:${PORT}
  Real device on the same Wi-Fi : http://<this computer's LAN IP>:${PORT}
  Payments                      : ${payments === 'demo' ? 'MOCK (demo mode — no Stripe keys)' : 'Stripe TEST mode'}

  Buyer      ${FIXTURE.buyer.email} / ${FIXTURE.buyer.password}
  Seller A   ${FIXTURE.sellerA.email} / ${FIXTURE.sellerA.password}   → ${base}/seller
  Seller B   ${FIXTURE.sellerB.email} / ${FIXTURE.sellerB.password}
  Warehouse  ${FIXTURE.warehouse.email} / ${FIXTURE.warehouse.password}   → ${base}/warehouse
  Admin      ${process.env.ADMIN_EMAIL} / ${process.env.ADMIN_PASSWORD}   → ${base}/admin

  Products: ${JSON.stringify(ids)}
  "Pilot Heater (not for Malta)" is hidden for MT and refused at checkout to MT; choose SA to buy it.
Press Ctrl+C to stop.`);
}
process.on('SIGINT', () => { try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });

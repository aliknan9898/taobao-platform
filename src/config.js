// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const e = process.env;

const config = {
  // Taobao Global Open Platform (ONE app; every seller authorizes it with their own distribution account)
  appKey: e.TAOBAO_APP_KEY || '',
  appSecret: e.TAOBAO_APP_SECRET || '',
  apiUrl: e.TAOBAO_API_URL || 'https://api.taobao.global/rest',
  authUrl: e.TAOBAO_AUTH_URL || 'https://api.taobao.global/oauth/authorize',
  channelOrderType: 'PANAMA_DG',

  // Stripe (no SDK — REST over fetch). Empty key = demo mode (test payments only)
  stripeSecretKey: e.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET || '',
  googleClientId: e.GOOGLE_CLIENT_ID || '',          // Google sign-in (OAuth 2.0 Web client)
  googleClientSecret: e.GOOGLE_CLIENT_SECRET || '',
  stripePublishableKey: e.STRIPE_PUBLISHABLE_KEY || '', // pk_… for Stripe.js on the buyer website
  stripeApiUrl: e.STRIPE_API_URL || 'https://api.stripe.com/v1',
  currency: (e.SALE_CURRENCY || 'usd').toLowerCase(),
  cnyRate: Number(e.CNY_PER_SALE_UNIT || 7.2), // 1 USD ≈ 7.2 CNY, for margin display
  shippingFlat: Number(e.SHIPPING_FLAT_FEE || 0), // international shipping charged per order

  publicBaseUrl: (e.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  port: Number(e.PORT || 3000),
  dataDir: e.DATA_DIR || path.join(__dirname, '..', 'data'),
  orderSyncMinutes: Number(e.ORDER_SYNC_MINUTES || 15),
  defaultCommissionPct: Number(e.PLATFORM_COMMISSION_PCT || 10),

  // Legal identity shown on the sites (footer, Terms, Privacy, Legal notice)
  operator: {
    name: e.OPERATOR_NAME || 'Ali Almadhoun Mohammed Kinan',
    tradingName: e.TRADING_NAME || 'Kinan',
    country: e.OPERATOR_COUNTRY || 'Malta',
    address: e.OPERATOR_ADDRESS || '',       // business address required before public launch
    companyNumber: e.COMPANY_NUMBER || '',   // set once the company is registered
    vatNumber: e.VAT_NUMBER || '',
    email: e.CONTACT_EMAIL || ''
  },

  // First admin is created on startup if no admin exists
  bootstrapAdminEmail: e.ADMIN_EMAIL || '',
  bootstrapAdminPassword: e.ADMIN_PASSWORD || '',

  // Your China warehouse — every Taobao purchase order ships here
  warehouse: {
    name: e.WAREHOUSE_NAME || '', mobile: e.WAREHOUSE_MOBILE || '',
    state: e.WAREHOUSE_STATE || '', city: e.WAREHOUSE_CITY || '',
    district: e.WAREHOUSE_DISTRICT || '', detail_address: e.WAREHOUSE_DETAIL || '',
    zip: e.WAREHOUSE_ZIP || '', country: 'China'
  }
};
config.redirectUri = `${config.publicBaseUrl}/oauth/callback`;
config.googleRedirectUri = `${config.publicBaseUrl}/auth/google/callback`;

function configProblems() {
  const p = [];
  if (!config.appKey || !config.appSecret) p.push('TAOBAO_APP_KEY / TAOBAO_APP_SECRET');
  if (!config.stripeSecretKey) p.push('STRIPE_SECRET_KEY (demo mode)');
  if (config.stripeSecretKey && !config.stripeWebhookSecret) p.push('STRIPE_WEBHOOK_SECRET');
  if (config.stripeSecretKey && !config.stripePublishableKey) p.push('STRIPE_PUBLISHABLE_KEY (buyer website card payments)');
  const w = config.warehouse;
  if (!w.name || !w.mobile || !w.city || !w.detail_address) p.push('WAREHOUSE_*');
  if (!config.operator.email) p.push('CONTACT_EMAIL (legal pages)');
  if (!config.operator.address) p.push('OPERATOR_ADDRESS (legal notice)');
  return p;
}

module.exports = { config, configProblems };

// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Kinan's own Taobao account is used for every seller; sellers never connect Taobao. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tbk-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1' });
const db = require('../src/db');
const ta = require('../src/taobao/sellerAuth');

test('Kinan account: used for every seller, adopted from the owner shop, auto-pay setting', async () => {
  const owner = db.users.insert({ email: 'boss@x.com', role: 'seller', status: 'active', google_sub: 'g-boss' }); // the owner has signed in with Google
  const os1 = db.sellers.insert({ user_id: owner.id, shop_name: 'Ali', taobao: { access_token: 'OWNER', refresh_token: 'r', expires_at: Date.now() + 90 * 86400e3, refresh_expires_at: Date.now() + 200 * 86400e3, account: 'kinan_tb' } });
  const other = db.sellers.insert({ user_id: 'u2', shop_name: 'Other', taobao: null });
  assert.strictEqual(ta.platformConnected(), false);
  await assert.rejects(() => ta.tokenFor(other.id), /Kinan’s Taobao account is not connected/);
  assert.strictEqual(ta.adoptOwnerToken(), true);
  assert.strictEqual(ta.platformConnected(), true);
  assert.strictEqual(await ta.tokenFor(other.id), 'OWNER', 'a seller without Taobao uses Kinan’s account');
  assert.strictEqual(await ta.tokenFor(os1.id), 'OWNER');
  assert.strictEqual(ta.platformStatus().account, 'kinan_tb');
  assert.strictEqual(ta.prefs().auto_pay, true);
  assert.strictEqual(ta.savePrefs({ auto_pay: false }).auto_pay, false);
  ta.disconnectPlatform(); assert.strictEqual(ta.platformConnected(), false);
});

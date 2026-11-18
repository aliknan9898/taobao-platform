// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-security-'));
process.env.DATABASE_URL = '';
const auth = require('../src/auth');

test('malformed password hashes are rejected rather than throwing', () => {
  for (const pass of ['scrypt$bad$bad', 'scrypt$' + 'aa'.repeat(16) + '$01', 'pbkdf2$' + 'aa'.repeat(16) + '$' + 'bb'.repeat(64)]) {
    const db = require('../src/db');
    const u = db.users.insert({ email: 'bad-' + Math.random() + '@example.com', role: 'buyer', status: 'active', pass });
    assert.throws(() => auth.login(u.email, 'password', 'shop'), { status: 401 });
  }
});

test('valid scrypt hashes still authenticate', () => {
  const db = require('../src/db');
  const u = db.users.insert({ email: 'valid@example.com', role: 'buyer', status: 'active', pass: auth.hashPassword('securepass123') });
  const session = auth.login(u.email, 'securepass123', 'shop');
  assert.equal(session.user.id, u.id);
  assert.ok(session.token);
});

test('PostgreSQL external TLS verifies server certificates', async () => {
  const db = require('../src/db');
  const { config } = require('../src/config');
  const previous = config.databaseUrl;
  config.databaseUrl = 'postgres://test:pass@db.example.com/kinan?sslmode=require';
  let options;
  class FakePool {
    constructor(o) { options = o; }
    async query(sql) { return { rows: [] }; }
    async end() {}
  }
  try {
    await db.init({ Pool: FakePool });
    assert.deepEqual(options.ssl, { rejectUnauthorized: true });
    await db.close();
  } finally { config.databaseUrl = previous; }
});

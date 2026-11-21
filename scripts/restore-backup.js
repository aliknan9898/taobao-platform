#!/usr/bin/env node
// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Restore an encrypted Kinan backup (.knb) into an EMPTY STAGING store, then reconcile it.
 *
 *   RESTORE_CONFIRM=staging BACKUP_ENCRYPTION_KEY=… DATABASE_URL=<staging postgres> node scripts/restore-backup.js <file.knb>
 *   RESTORE_CONFIRM=staging BACKUP_ENCRYPTION_KEY=… DATA_DIR=/tmp/kinan-restore     node scripts/restore-backup.js <file.knb>
 *
 * Refuses the production database (PRODUCTION_DB_HOSTS, default the kinan-db host) and any non-empty target.
 * Prints per-collection counts, a sample product with its photos and an order checked against the backup, and the time taken.
 */
const fs = require('fs');

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/restore-backup.js <backup.knb>');
  if (process.env.RESTORE_CONFIRM !== 'staging') throw new Error('Set RESTORE_CONFIRM=staging: this tool only restores into a staging store');
  const prod = String(process.env.PRODUCTION_DB_HOSTS || 'dpg-dbpgoi08v5cc73e7cvo0').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.DATABASE_URL && prod.some((h) => process.env.DATABASE_URL.includes(h))) throw new Error('DATABASE_URL points at production: refused');
  if (!process.env.DATABASE_URL && !process.env.DATA_DIR) throw new Error('Set DATABASE_URL (staging PostgreSQL) or DATA_DIR (empty folder)');
  const t0 = Date.now();
  const backup = require('../src/services/backup');
  const snap = backup.decrypt(fs.readFileSync(file), process.env.BACKUP_ENCRYPTION_KEY);
  const db = require('../src/db');
  await db.init();
  const counts = await backup.restoreInto(db, snap);
  const report = require('../src/services/backupCheck').reconcile(db, snap);
  console.log(JSON.stringify({ backup_at: snap.at, backup_age_hours: Math.round((Date.now() - Date.parse(snap.at)) / 36e5 * 10) / 10, restore_ms: Date.now() - t0, counts, reconcile: report }, null, 2));
  await db.close();
  if (!report.ok) process.exitCode = 2;
}
main().catch((e) => { console.error(`[restore] ${e.message}`); process.exit(1); });

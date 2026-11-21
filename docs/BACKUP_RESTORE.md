# Backups and restore

## What is backed up, and where

| Copy | Where | Contents | Encrypted | Frequency |
|---|---|---|---|---|
| Off-site backup (`src/services/backup.js`) | Private Cloudflare R2 bucket `kinan-backups`, folder `db/YYYY-MM-DD/` | Every collection, including identity-document photos | Yes: AES-256-GCM | Daily at 02:00 UTC, plus on demand |
| Email backup (`ops.dailyBackup`) | The owner's inbox | Every collection except identity-document photos | No: a `.zip` file | Daily at 02:00 UTC |
| Admin download (`GET /api/admin/backup`) | The owner's device | Every collection | No | On demand |
| Product photos | R2 bucket `R2_BUCKET` (public, e.g. `img.kinan.shop`) | Image files. The backup holds only the link map (`media`) | — | Copied as products are imported |

The off-site file is portable. It holds the JSON `{ app, version, at, collections }`, gzipped and encrypted with this layout:
`"KNB1" | iv (12 bytes) | GCM tag (16 bytes) | ciphertext`. Reading it needs Node.js and the key, not Kinan's code.

## Setup (owner, one time)

1. **Create the bucket.** In Cloudflare, go to **R2 → Create bucket** and name it `kinan-backups`. Keep it **private**: no public access and no custom domain.
2. **Create a token.** Go to **R2 → Manage API tokens** and create a token with **Object Read & Write** on `kinan-backups` only.
3. **Create the encryption key on your own computer:**
   ```
   openssl rand -base64 32
   ```
4. **Add the settings on Render.** In **kinan → Environment**, add:
   - `BACKUP_ENCRYPTION_KEY`: the key from step 3
   - `BACKUP_R2_ACCESS_KEY_ID` and `BACKUP_R2_SECRET_ACCESS_KEY`: the token from step 2
   - `R2_ACCOUNT_ID`: already set if product photos use R2
   - `BACKUP_R2_BUCKET`: optional, default `kinan-backups`
5. **Run the first backup.** In Admin, call `POST /api/admin/backup/offsite`. Then check `GET /api/admin/backup/offsite`: it shows the last backup and its age.

## Key custody

- The key exists in only two places:
  - Render's environment
  - An offline copy kept by the owner, in a password manager **and** on paper in a safe place
- It is never sent by email, Telegram or chat, and never committed to the repository.
- Without the key, no backup can be read. Losing the key means the off-site backups are lost.
- **Changing the key:**
  1. Make a new key and set it on Render.
  2. Run a manual backup.
  3. Keep the old key until every backup made with it has expired: 12 months.

## Retention

- **Every daily backup** is kept for `BACKUP_KEEP_DAYS` (default 30).
- **After that, the first backup of each month** is kept for `BACKUP_KEEP_MONTHS` (default 12).
- Older backups are deleted after each successful backup.
- **Recommended:** add an R2 lifecycle rule that deletes objects older than 400 days, as a second limit in case the app stops deleting.

## Monitoring

- **Failed backup:** a Telegram alert is sent with the error.
- **Old backup:** if the newest backup is more than **26 hours** old, a Telegram alert is sent, at most once per day.
- **Status:** `GET /api/admin/backup/offsite` returns `{ enabled, bucket, last, age_hours }`.

## Before any migration or risky change

1. Run `POST /api/admin/backup/offsite`. It is saved with the reason `manual`.
2. Write down the `key` it returns: that is the restore point.
3. Download the file and check that it opens. In a staging environment, run a restore, as below.

## Restore (staging only)

1. **Download the file** from the R2 bucket: `db/<date>/kinan-<time>-<reason>.knb`.
2. **Restore it into an empty staging store.** Choose one:
   ```
   # staging PostgreSQL (must be a new, empty database — never production)
   RESTORE_CONFIRM=staging BACKUP_ENCRYPTION_KEY=… DATABASE_URL=<staging> npm run backup:restore -- kinan-….knb
   # or a local folder
   RESTORE_CONFIRM=staging BACKUP_ENCRYPTION_KEY=… DATA_DIR=/tmp/kinan-restore npm run backup:restore -- kinan-….knb
   ```
3. **Read the result.** The script prints:
   - `backup_age_hours`
   - `restore_ms`
   - Counts per collection
   - A reconcile report for one product (its prices, its photos, and the Kinan copy of each photo) and the last order (its total, its lines and its ledger lines)

   The script exits with code `2` if the restored data does not match the backup.

**Built-in protections:**
- It refuses to run without `RESTORE_CONFIRM=staging`.
- It refuses the production database host, `dpg-dbpgoi08v5cc73e7cvo0` (set with `PRODUCTION_DB_HOSTS`).
- It refuses any target that already has data.

**Restoring production:** this is an owner decision. Suspend the web service, create a new database, restore into it, run the reconcile, then point `DATABASE_URL` at it. Never overwrite the live database in place.

## Measured (synthetic data, 21 Nov 2026)

| | Result |
|---|---|
| Records | 4,000 (3,000 products, 500 orders, 500 ledger lines) |
| Encrypted file | 104 KB |
| Encryption | 84 ms |
| Restore into a local JSON store, with reconcile | 21.1 s, reconcile OK |

The JSON store rewrites its file on every insert, so this time is an upper bound. A restore into PostgreSQL is written in batches and was not measured here: the `pg` package cannot be installed in this environment. Measure it on the first staging restore.

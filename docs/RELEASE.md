# Releasing Kinan: staging, checks, production and rollback

## How deployment works today

- **Production service:** Render web service **kinan** (`srv-dbpdpl08v5cc73dvt3bg`). It builds from branch `main` with `autoDeploy: true`, so **every push or merge to `main` goes live within about 2 minutes.**
- **Database:** PostgreSQL `kinan-db`, the only database in the account. A deploy changes code only, never the data.
- **CI:** GitHub Actions runs two workflows:
  - `test.yml` on every push and pull request: tests, syntax checks and the local staging smoke check.
  - `quality-gate.yml` on `main`: tests again.
- **Deploy gate:** Render does not wait for CI. A red test does not stop a deploy, so merge only commits whose checks are green.
- **Development branch:** `fix/chatgpt-security-db-ci-20261118`. Changes reach `main` only with the owner's approval for that change.

## Staging

### Level 1: local isolated copy (every change, no cost)

```
npm test
npm run staging:local
```

`staging:local` starts the app in an empty temporary folder with a clean environment:
- no production keys
- `RUN_JOBS=0`, so nothing calls suppliers, Stripe, email or Telegram
- `DATA_DIR`, so no PostgreSQL

It then runs `scripts/smoke.js` against the copy and deletes it. CI runs the same steps on every push.

### Level 2: hosted staging (optional, for payment and supplier flows)

A second Render web service built from the development branch, with:
- its own new PostgreSQL database, never `kinan-db`
- `RUN_JOBS=0`
- Stripe **test** keys (`sk_test_…`) only
- no CJ, AliExpress, eBay, Taobao, Brevo or Telegram keys, unless a test needs one in sandbox mode
- `PUBLIC_BASE_URL` set to the staging address

**Data:** fill it from an encrypted backup with `npm run backup:restore` (see `BACKUP_RESTORE.md`). The restore tool refuses the production database. Real customer data in staging is an owner decision; prefer synthetic data.

## Release checklist (each change going to production)

1. **Owner approval** for this specific change, in writing.
2. **Branch green:** `npm test` passes, `npm run staging:local` passes, and the GitHub checks are green.
3. **Risk note.** Does the change touch money, orders, stock, identity or the data format?
   - **Data format:** new collections or fields are additive. A field that is renamed or removed needs a migration plan and a backup first.
   - **Money or orders:** take an off-site backup first: Admin → Backup & Data → **Back up now**, or `POST /api/admin/backup/offsite`.
4. **Merge to `main`:** one focused commit, written so it can be undone with a single revert.
5. **Watch the deploy** (Render → kinan → Events). After it shows *Deploy succeeded*:
   - `npm run smoke -- https://kinan.shop`: read-only, safe on production.
   - The logs show `[db] PostgreSQL connected` and `[jobs] running scheduled jobs (… lock held)` within about a minute.
   - No `[error]` lines in the first 10 minutes.
6. **Record** the commit, the time and the smoke result in the change report.

## Rollback

| Situation | Action | Time |
|---|---|---|
| A deploy breaks the site | Render → kinan → **Deploys** → the last good deploy → **Rollback** (or **Redeploy**). Then `npm run smoke -- https://kinan.shop` | 2–3 min |
| Keep `main` in line with what runs | `git revert <bad commit>` → push to `main`. This auto-deploys the reverted code | 3–5 min |
| A deploy hangs (seen on 21 Nov) | Render → kinan → **Cancel deploy** → **Manual Deploy → Deploy latest commit**. The previous version keeps serving meanwhile | 2–5 min |
| Data damaged | Never overwrite `kinan-db`. Restore the last good backup into a **new** database (`BACKUP_RESTORE.md`), reconcile it, then point `DATABASE_URL` at it. Owner decision | 15–30 min |

**Notes:**
- A Render rollback turns auto-deploy off for the service. Turn it back on after `main` is fixed.
- Rolling back code does not undo data written by the bad version. Changes so far only add fields and collections (`audit`, `idem_key_hash`, …), so older code ignores them safely.

**Rehearsed, 21 Nov 2026:** the previous `main` (`38b6928`) was checked out and started with `staging:local`. All 9 smoke checks passed. This shows that rolling back one commit gives a working app.

## Recommended Render settings (owner approval needed)

- **Health check path → `/healthz`** on kinan. It is empty today. With it, Render waits until the new version answers before switching traffic, and restarts an instance that stops answering.
- **Optional: auto-deploy off.** Releases would then go through **Manual Deploy** after the checklist. The trade-off is one extra click per release.
- **Remove the duplicate service** `taobao-platform`. It builds every commit and has no domain or database.

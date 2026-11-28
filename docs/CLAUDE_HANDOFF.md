# KINAN — Claude Code engineering handoff

**Prepared:** 2026-11-18  
**Repository:** `aliknan9898/kinan-platform` (renamed from `taobao-platform`; GitHub redirects the old address)  
**Authorized development branch:** `fix/chatgpt-security-db-ci-20261118`  
**Production:** NO changes authorized.

## Objective
Stabilize the existing marketplace before adding major features. Preserve customer/seller/admin/warehouse flows, Arabic RTL, supplier integrations, and the existing API contract. This is an engineering queue, not permission to deploy.

## Current verified facts
- `package.json`: Node >=18; tests via `node --test test/*.test.js`; dependency `pg`.
- `src/server.js` serves APIs and HTML; `public/shop.html` is a large inline-script storefront.
- `src/db.js` uses in-memory collection caches and queued PostgreSQL writes; financial consistency requires special care.
- `render.yaml` points to `main` with `autoDeploy: true`; avoid merges without owner signoff.
- CI workflow `.github/workflows/test.yml` runs `npm test` and syntax checks.
- This development branch contains preliminary TLS, password-hash, queue retry, CI, template cache, and homepage request-prioritization changes. Verify all of them; none are automatically approved for production.

## Work queue and acceptance criteria

### P0 — verify existing branch and establish baseline
1. Fetch latest branch and inspect all changes relative to `main`.
2. Run `npm install --no-audit --no-fund`, `npm test`, and syntax checks; record exact test counts and failures.
3. Add safe local performance benchmarks for storefront HTML and `GET /api/catalog`; record p50/p95 latency, payload size, and CPU/memory under a documented fixture. No production load tests without owner permission.
4. Verify current homepage concurrency change does not break navigation, category chips, Arabic RTL, or product listing.
**Accept:** reproducible test and benchmark commands with documented results; zero unexpected regressions.

### P0 — data durability and payments
1. Audit `src/db.js` write queue and collection operations for crash loss, stale reads, race conditions, and partial updates.
2. Propose transactional PostgreSQL storage for money/orders/ledger with constraints, migrations, and a safe backfill plan; do not run migrations against production.
3. Audit `src/webhooks.js`, Stripe service, `src/services/payouts.js`, and order transitions for signature verification, idempotency, event replay, and double transfer risk.
4. Add isolated tests for duplicate webhooks, concurrent payment events, process interruption, and retry behavior.
**Accept:** no duplicate money movement under retries; deterministic tests; migration plan reviewed separately before any production execution.

### P1 — performance and reliability
1. Measure JS/CSS/image transfer sizes, render-blocking assets, first meaningful product render, catalog query cost, and Render cold-start behavior.
2. Reduce critical-path work; avoid blocking compression and repeated full-collection scans where possible.
3. Design bounded background worker execution and job deduplication for multi-instance deployment.
4. Assess static asset caching and Cloudflare R2/CDN without changing production DNS or credentials.
**Accept:** before/after benchmark numbers from the same environment and passing regression tests.

### P1 — security and CI
1. Review authorization on every admin, seller, warehouse, and buyer API endpoint; add negative tests.
2. Review CSRF, XSS/HTML insertion, SSRF, rate limits, secrets, TLS, webhook signatures, and input size limits.
3. Add dependency audit and reproducible installs if a lockfile exists; evaluate `npm ci` safely.
4. Prepare branch protection recommendations and a manual-release checklist; no automatic deployment changes without approval.
**Accept:** documented severity, evidence, fix, and tests for each finding.

### P2 — integrations and mobile readiness
1. Verify Taobao, AliExpress, CJ, courier, email, Stripe Connect contracts against available docs/sandbox.
2. Inventory incomplete integrations and API contract mismatches; do not assume credentials exist.
3. Prepare React Native + Expo API readiness plan (buyer and seller) after backend stability.
**Accept:** endpoint matrix, missing fields, sandbox tests, and explicit owner decisions.

## Pull request format
- **Scope** / **risk level** / **changed files**
- **Evidence**: exact command outputs, screenshots or benchmark data when relevant
- **Migration impact**: yes/no, rollback plan
- **Security/financial impact**
- **Owner approval required**: list actions explicitly
- **No deployment, no merge** until owner separately authorizes

## Do not claim
Do not claim that GitHub CI success proves production readiness, that all integrations are live, or that any performance optimization improved live `kinan.shop` before measured deployment.

# CLAUDE.md — KINAN development handoff

> Proprietary project. Follow the repository LICENSE and NOTICE. This file guides Claude Code and other coding agents.

## Project
KINAN is a Node.js (>=18) multi-seller marketplace. Entry point: `src/server.js`; persistence: `src/db.js` (PostgreSQL / JSON fallback); web PWAs: `public/shop.html`, seller, admin, warehouse; business logic: `src/services/`; supplier clients: `src/taobao/`, `src/aliexpress/`, `src/cj/`; API reference: `docs/API.md`; tests: `test/*.test.js`. See `README.md` for current feature descriptions; do not assume every described integration is production-ready.

## Owner-approved boundaries (mandatory)
- Work ONLY on the explicitly approved development branch `fix/chatgpt-security-db-ci-20261118`, or another development branch after the owner approves it. Never commit directly to `main`.
- NEVER merge to `main`, deploy/redeploy/restart Render services, change production environment variables, migrate or write production databases, trigger live supplier orders, execute Stripe payments/transfers/refunds, or delete resources without explicit owner approval for the specific action.
- Use mock/sandbox integrations and temporary databases for tests. Never use real customer data or production credentials in tests.
- Do not print, commit, or request secret tokens in chat. Use GitHub/Render secret stores only when explicitly authorized.
- Before any change: inspect relevant code and tests. Keep commits focused, add regression tests, run tests, and report exact results and limitations. A passing unit suite does not establish production readiness.
- If a task may affect money, stock, orders, identity, privacy, or persistent data, explain risks and get owner authorization before production action.

## Local workflow
```bash
npm install --no-audit --no-fund
npm test
node --check src/server.js
node --check src/db.js
node --check src/auth.js
npm start  # local only, with safe nonproduction environment
```

## Architecture / risk priorities
1. **P0 data durability:** `src/db.js` caches collections in memory and flushes writes asynchronously. Validate crash recovery, concurrent updates, unique constraints, and transaction boundaries before handling financial state at scale. Do not treat queue fixes as full durability.
2. **P0 payment safety:** inspect Stripe webhook acknowledgement, durable event processing, idempotency, ledger consistency, and seller payouts. Never exercise live transfers.
3. **P1 storefront performance:** `public/shop.html` contains a large inline client application. Measure page/API/image timings, then optimize initial render and catalog routes. Verify mobile behavior, Arabic RTL, and checkout.
4. **P1 deployment safety:** `render.yaml` points at `main` with auto-deploy. A merge could deploy automatically. Keep branch-only changes until the owner explicitly approves a release.
5. **P1 security:** authentication, role checks, untrusted HTML, rate limiting, TLS verification, and webhook signatures.

## Required report after every task
Summarize: files changed, commit SHAs, tests executed (pass/fail), remaining risks, production impact (must be none unless explicitly authorized), and decisions requiring owner approval. Explain results to the owner in Arabic; use professional English for code comments and developer instructions.

## Handoff
See `docs/CLAUDE_HANDOFF.md` for the work queue and acceptance criteria. Coordinate via small PRs; never infer approval to merge from approval to edit a branch.

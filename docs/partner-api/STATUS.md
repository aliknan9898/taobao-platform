# Partner API — status, reuse map and gaps

Baseline reviewed: `main` at `b69b7ed6616a8323eda241f47c5c251e0d803c4c` (22 Nov 2026).
Batch 1 was built on the development branch `fix/chatgpt-security-db-ci-20261118`.

## Verified existing capabilities (reuse)

| Need | Existing code | Used in Batch 1? | Notes |
|---|---|---|---|
| Curated KINAN catalogue with costs | `src/services/kinanCatalog.js` (`lineCost`, reviewed CJ/AliExpress listings) | Yes, live projection only (switched off) | The live catalogue needs `partner_publication = 'eligible'` per listing before partners see it. There is no evidence workflow for that yet. |
| Landed cost and delivery | `src/services/landed.js`, `shipping.js` | No | For Batch 2 quotes. |
| Orders, procurement, warehouse, tracking | `orders.js`, `warehouse.js`, `tracking.js`, `money.js` | No | Batch 2 and 3 link through an explicit partner order record. Buyer checkout is never called for partners. |
| Audit trail | `src/audit.js` | Yes | Admin partner routes are under `/api/admin/` and are audited automatically. |
| Kill switches | `src/services/appControl.js` | Yes | The partner API is not held by shop maintenance. It has a per-store pause (503) instead. |
| eBay mapping pattern | `src/services/ebay.js` | No | Reference for the Shopify and WooCommerce adapters (Batch 4). |
| Persistence | `src/db.js` document store: in-memory, with a transactional write-behind to PostgreSQL per batch | Yes | Fine for catalogue state and keys. **Not** sufficient for orders, idempotency or reservations: see `BATCH2_DESIGN.md`. |

## Batch 1 — delivered

- **Endpoints** under `/api/partner/v1`:
  - `GET /me`
  - `GET /catalog/products` (paged snapshot plus `sync_cursor`)
  - `GET /catalog/products/{id}`
  - `GET /catalog/changes`
  - `GET /openapi.json`
- **Keys:**
  - `knp_test_`/`knp_live_` + 32 base62 characters, stored as a SHA-256 hash and a lookup prefix.
  - Shown once, with scopes, revocation and last-used time.
  - Live keys are blocked unless `PARTNER_LIVE_ENABLED=1`.
- **Entitlements per store:** markets, categories, excluded products, locales, and a price-list markup over the 30% floor (with a version).
- **Change feed:**
  - Per-environment sequence; upsert and withdraw events per market.
  - Store-scoped events when that store's entitlements or price list change.
  - An upsert for a product the store is not entitled to is delivered as a withdraw.
  - 30-day retention (`PARTNER_CHANGE_RETENTION_DAYS`); older cursors get `410`.
- **Cursors:**
  - HMAC-signed, bound to store, environment, market, locale and operation.
  - The secret comes from `PARTNER_CURSOR_SECRET`, or a random value generated once and stored in settings.
- **Sandbox:**
  - 12 synthetic products (DE/GB, en/de) in their own collection; real listings are never read.
  - Admin simulator to change stock, cost or availability, or reset.
- **Pricing:** `src/partner/pricing.js`.
  - Floor = `F / (1 − m − r)`, or `F / (1 − m − r·(1+t))` when the fee is charged on the gross amount; rounded up.
  - Default target `PARTNER_TARGET_MARGIN=0.30`. Worked example from the brief: €16.25 → €23.22, and €24.00 → 32.29%.
- **Errors:** RFC 9457 problem+json and an `X-Request-Id` on every response. Per-store token-bucket rate limit (`PARTNER_RATE_PER_MIN`, default 120) with `Retry-After`.
- **Admin:** Admin → Suppliers & channels → Partner API (B2B), in English and Arabic.
  - Organisations and stores
  - Entitlements
  - Issue or revoke keys
  - Pause or resume a store
  - Sandbox simulator
  - Feed health
- **Tests:** `test/partner-api.test.js` checks every response against the OpenAPI schemas, covering:
  - two-store isolation
  - convergence for initial import, changed item, stock update, withdrawal and restore
  - a write during the snapshot
  - entitlement revocation and grant, and price-list changes
  - tampered, foreign and expired cursors
  - scopes and revoked keys
  - pause and rate limit
  - the 30% floor
  - public API regression

## Batch 2 — delivered (sandbox, behind `PARTNER_ORDERS_ENABLED=1`)

- **Endpoints:**
  - `POST /quotes`
  - `POST /orders` (Idempotency-Key)
  - `GET /orders` (keyset paging, filter by `external_order_ref`)
  - `GET /orders/{id}`
- **Admin:** a sandbox order list with "mark settled (test)".
- **Storage:** real PostgreSQL tables (`src/partner/migrations/001_partner_core.sql`, additive). They are applied under an advisory lock the first time ordering is used. Rollback is in `001_partner_core.down.sql`, run by the owner only.
- **Order creation** is one transaction:
  1. idempotency record
  2. quote check: expiry, country and postal code
  3. order (unique store + reference)
  4. reservation of controlled stock (conditional `UPDATE`)
  5. outbox event and history
  6. the stored answer
- **Supporting jobs:**
  - Fulfilment intents use `FOR UPDATE SKIP LOCKED` and a unique order id, so there is exactly one per order.
  - A sweeper releases unpaid reservations after `PARTNER_RESERVATION_MIN` (default 60) minutes.
  - Idempotency records are purged after 30 days.
- **Recipient data:** AES-256-GCM at rest. Live needs `PARTNER_PII_KEY`; the sandbox derives a key.
- **Pricing:**
  - Quotes per origin: DE warehouse and CN direct with import handling. Shipping and handling are priced to the floor.
  - The basket contribution is checked against `PARTNER_TARGET_MARGIN` (30%) with `PARTNER_FEE_RATE`; quotes below it are refused.
  - `PARTNER_QUOTE_TTL_MIN` defaults to 15.
- **Tests:** `test/partner-orders.test.js` runs on a real, isolated PostgreSQL 16: locally with `KINAN_TEST_PG=1`, and in CI through a postgres service. It covers:
  - 30 concurrent identical requests
  - two Node processes × 25 retries
  - a crash after COMMIT
  - key/body conflict, reused reference, expired quote, postcode mismatch, stock race
  - 30% floor with a 3% fee and two origins
  - reservation timeout
  - store isolation and scopes
  - the off switch
  - OpenAPI validation of every answer

  The test-only wire-protocol client is `test/support/minipg.js`. Production uses `pg`.

## Batch 3 — delivered (sandbox, behind the same `PARTNER_ORDERS_ENABLED=1`)

- **Migration** `002_partner_fulfilment.sql` (additive): shipments, cancellations, returns, webhook endpoints and
  deliveries, plus new nullable columns on the fulfilment intent and the order. Rollback is
  `002_partner_fulfilment.down.sql` (owner only; run it before 001's).
- **Handoff** (`src/partner/fulfilment.js`):
  - A worker claims confirmed orders with SKIP LOCKED and a 2-minute lease.
  - It calls the adapter **outside** SQL transactions with a deterministic `handoff_ref` (`kh_` + hash of the order id).
  - It records `processing`, or the error so the next run retries.
  - If the order was cancelled while the submission was in flight, the adapter is told to withdraw it.
  - Sandbox: a simulated adapter. **Live: no adapter.** Live intents stay pending and the admin shows "manual".
- **Shipments:**
  - One per ship-from origin, so `partially_shipped` then `shipped`, then `delivered`, plus `exception`.
  - Controlled reservations are committed (on hand goes down) when an origin ships.
  - `GET /orders/{id}/shipments`.
- **Cancellations:**
  - Before handoff: accepted at once. Reservations are released, the intent is closed, and a settled payment becomes credited.
  - After handoff: requested, and KINAN accepts or rejects it (admin or sandbox simulator).
  - After shipping: 409.
  - At most one open cancellation per order (unique partial index). Idempotency-Key as for orders.
- **Returns (RMA):**
  - Only for delivered parcels, within `PARTNER_RETURN_WINDOW_DAYS` (30), up to the delivered quantity minus earlier non-rejected returns.
  - States: requested → approved (instructions + RMA) / rejected → received → credited. Payment becomes `partially_credited` or `credited`.
- **Documents** (`src/partner/documents.js`):
  - PDFs: pro-forma invoice, packing slip (only document with the recipient) and credit notes.
  - Sandbox banner on every page. Live answers 503.
- **Webhooks** (`src/partner/webhooks.js`):
  - Endpoints:
    - HTTPS on public addresses only. Private, loopback, link-local, CGNAT, multicast and documentation ranges are refused, including IPv4-mapped and NAT64 IPv6.
    - DNS is checked at creation, at verification and on every delivery, and the connection is pinned to the checked address.
    - A signed challenge is required before activation. At most 5 per store. The secret is encrypted at rest and shown once.
  - Delivery:
    - The outbox is fanned out to one delivery row per endpoint and event (unique), then claimed with a 60 s lease.
    - Each event is POSTed with `KINAN-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`.
    - No redirects, 10 s timeout.
    - Failed deliveries are retried with backoff and jitter for 24 h, then dead. Replay keeps the event id.
    - 50 failures in a row disable the endpoint.
  - The background worker runs every 15 s while ordering is on.
- **Sandbox simulator:** `POST /sandbox/orders/{id}/simulate` for partners. The admin gets the same buttons:
  Hand off / Ship / Deliver, cancellation and return decisions, webhook health and "Send again".
- **Tests:** `test/partner-fulfilment.test.js` (real PostgreSQL 16, 16 checks plus the address-guard unit test). It covers:
  - handoff exactly once with three workers, and a handoff failure with lease and retry
  - partial and full shipping with stock commit, and exception
  - cancellations before and after payment and handoff (reject and accept, supplier withdrawal) and after shipping
  - returns: window, quantities, full flow, credit states
  - documents and store isolation
  - webhooks: SSRF guard, verification, signatures, no PII, exactly one delivery with three dispatchers, backoff, redirect, dead after 24 h, replay, auto-disable, delete
  - scopes and the off switch
  - OpenAPI validation of every answer

### Fixed in Batch 2 while building Batch 3

- **jsonb parameters:** `pg` sends JavaScript arrays as PostgreSQL arrays, so writing quote `lines` and `charges` to `jsonb` would have failed the first time ordering was switched on in production.
  - Every jsonb value is now sent as JSON text.
  - The test client (`test/support/minipg.js`) now serialises arrays the way `pg` does, so this class of bug fails the tests.
  - Production was not affected: ordering has never been switched on.

## Batch 4 — delivered (sandbox, behind `PARTNER_SHOPIFY_ENABLED=1`)

**KINAN for Shopify**, run by KINAN (`src/partner/connectors/`). Setup, dev-store round trip and support are in `SHOPIFY_RUNBOOK.md`.

- **Admin GraphQL `2026-10`** (pinned, `SHOPIFY_API_VERSION`).
- **Install:**
  - Authorization code grant with expiring offline tokens; refresh tokens rotate.
  - Client credentials grant for KINAN's own development stores.
- **Migration** `003_partner_connectors.sql` (additive): connections, OAuth state, product, variant, order and fulfilment mappings, webhook de-duplication and privacy requests.
- **What it does:**
  - Catalogue → draft products (`productSet` keyed by handle) with stock (`inventorySetQuantities` + `@idempotent`). Merchant price and content are kept.
  - Paid orders → Partner API orders exactly once (webhook + polling share one claim row).
  - Shopify cancellations → KINAN cancellations.
  - KINAN shipments → Shopify fulfilments with tracking (never twice).
  - Uninstall, revoked access and privacy webhooks are handled.
- **Admin → Partner API → Shopify stores** (EN/AR): install link, dev-store connect, sync now, pause/resume, disconnect, settings, orders that need attention, privacy requests.
- **Tests:** `test/partner-shopify.test.js` (real PostgreSQL + a fake Shopify that enforces tokens, idempotency keys and remaining quantities). It covers:
  - install checks, sealed tokens, webhook registration
  - drafts with stock and metafields
  - the merchant publishes and reprices; stock still syncs and price and status are kept
  - withdraw/restore, and a crash during creation
  - a repeated webhook, parallel imports and polling all give one order; unsigned webhooks are refused
  - a lost webhook is picked up by polling
  - split tracking write-back, and a crash after fulfilment
  - cancellation, an order KINAN cannot accept, token refresh, revoked access and reinstall
  - settings, privacy and uninstall webhooks, the dev store and the off switch

## Known limits (honest list)

- **Batches 2–3:**
  - Live quotes are refused: real tariffs, VAT treatment and duties need owner decisions.
  - Tax is 0 and labelled `sandbox_no_tax`.
  - **No live handoff adapter:**
    - Nothing is ever sent to a real supplier or the warehouse.
    - Connecting `orders.js`/`warehouse.js` or a supplier needs the owner's approval, because it can trigger real purchases.
  - Shipments are simulated in the sandbox. Live carrier tracking would map from `tracking.js` once the handoff exists.
  - Return credits and cancellation credits are states and credit-note PDFs only. No money moves, and there is no ledger entry for partners yet.
  - Live documents (tax invoices, credit notes) wait for the invoicing entity, VAT registration and numbering.
  - **Webhooks:**
    - Delivery order is not guaranteed (use `data.version`).
    - Catalogue changes are not pushed (poll `/catalog/changes`).
    - Rotating a secret means creating a new endpoint.

- **Restarts and multiple processes:** the change sequence and state live in the document store. A restart keeps them, because they are written to PostgreSQL by the same write-behind as everything else. Two processes writing the feed at once are not supported: the app runs as a single instance (the job owner uses a Postgres advisory lock). Batch 2 moves commands to real SQL tables.
- **Live projection:**
  - Markets are DE only.
  - There are no dimensions, GTINs or manufacturer and responsible-person data yet.
  - Publication is `review_required` until a listing is marked eligible.
  - Do not enable live keys before that evidence exists.
- **Lookups:** `db.get` is a linear scan. Fine for the sandbox (12 products) and a pilot assortment. It needs an index or SQL before thousands of live products.
- **Not built yet:**
  - Partner portal (self-service keys, endpoints and logs)
  - WooCommerce adapter (Shopify delivered in Batch 4, tested against a fake Shopify only; see `SHOPIFY_RUNBOOK.md` §5)
  - Live fulfilment handoff
  - Partner ledger and settlement
- **No production effect:** there are no live keys and no live catalogue, and nothing is merged to `main` without owner approval.

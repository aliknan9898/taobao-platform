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

## Known limits (honest list)

- **Batch 2:**
  - Live quotes are refused: real tariffs, VAT treatment and duties need owner decisions.
  - Tax is 0 and labelled `sandbox_no_tax`.
  - Fulfilment intents are recorded but not yet handed to suppliers or the warehouse (Batch 3).
  - There is no shipment, cancellation, return or document API yet.
  - The outbox fills but nothing dispatches it yet (webhooks are Batch 3).

- **Restarts and multiple processes:** the change sequence and state live in the document store. A restart keeps them, because they are written to PostgreSQL by the same write-behind as everything else. Two processes writing the feed at once are not supported: the app runs as a single instance (the job owner uses a Postgres advisory lock). Batch 2 moves commands to real SQL tables.
- **Live projection:**
  - Markets are DE only.
  - There are no dimensions, GTINs or manufacturer and responsible-person data yet.
  - Publication is `review_required` until a listing is marked eligible.
  - Do not enable live keys before that evidence exists.
- **Lookups:** `db.get` is a linear scan. Fine for the sandbox (12 products) and a pilot assortment. It needs an index or SQL before thousands of live products.
- **Not built yet:**
  - Webhooks
  - Partner portal
  - Quotes, orders, shipments, returns and documents
  - Shopify and WooCommerce adapters
- **No production effect:** there are no live keys and no live catalogue, and nothing is merged to `main` without owner approval.

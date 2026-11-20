# Etsy × KINAN — BlushPromise integration plan (development only)

Status: design/preparation. No Etsy authorization, live API call, production deployment, or data mutation has occurred.

## Existing architecture
- Node.js 22 server in `src/server.js`; services in `src/services/`; PostgreSQL/JSON storage in `src/db.js`.
- eBay integration provides a useful reference, but must not be copied blindly.
- No Etsy code was found by the default-branch code search for `etsy`; verify full tree before implementation.

## Required API setup
- Register Etsy Open API v3 application under the account authorized to manage BlushPromise.
- Configure OAuth 2.0 authorization-code + PKCE, strict redirect URI, state verification, minimal scopes, refresh-token rotation, encrypted storage, revocation/disconnect.
- Never commit credentials; use isolated test secrets and do not configure production without approval.
- Validate exact API endpoint contracts, permission scopes, quotas, and webhook availability against current Etsy documentation.

## Data flow and safeguards
1. Read-only connection test: shop identity, listing pages, receipts/orders (only if scopes approved).
2. Map Etsy listing/variation/sku/inventory to internal listing identifiers; persist external IDs and sync cursors.
3. Map Etsy paid receipts to KINAN external orders with unique key (platform, shop_id, receipt_id); do not trigger fulfillment or payments during import.
4. Idempotent incremental pull with pagination, bounded retries, backoff, rate-limit handling, audit logs, and dead-letter queue.
5. Conflict policy: Etsy owns Etsy listing state until explicitly configured otherwise; manual review for conflicts; no automatic overwrites/deletions.
6. Before any Etsy writes: enforce handmade/designed/vintage/craft-supply eligibility and Etsy policy review; no indiscriminate CJ/AliExpress dropshipping.
7. Tracking updates only after explicit authorization and successful nonproduction tests; no financial operations.
8. Admin UI: connection status, last sync, counts, errors, dry-run preview, pause/resume, manual retry, disconnect.

## Implementation sequence
- Phase A: tests with mock Etsy responses for OAuth state/PKCE, pagination, rate limits, token expiry, deduplication, partial failures.
- Phase B: read-only Etsy client, connection management and dry-run import previews.
- Phase C: external-order staging and safe product mapping, with audit trails.
- Phase D: gated bidirectional updates after owner approval and policy review.

## Acceptance criteria
- No production effects; no writes to main or Render.
- Tests pass locally with fake tokens and synthetic orders.
- Re-running an import creates zero duplicate orders.
- Failed sync can resume safely and never triggers a payment, refund, or shipment.
- UI reports accurate dry-run vs applied status.

## Decisions pending
- Whether BlushPromise listings should stay Etsy-only or be imported into KINAN storefront.
- Whether KINAN may eventually update Etsy prices/stock and submit fulfillment tracking.
- Etsy app approval and authorization by shop owner.

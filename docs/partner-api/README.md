# KINAN Partner API v1 — quickstart (Batch 1: catalogue)

Server-to-server API for approved partner stores. The contract is `docs/partner-api/openapi.json`
(OpenAPI 3.1.1), also served at `GET /api/partner/v1/openapi.json`.

**Status:** sandbox only. Live keys cannot be issued until the owner sets `PARTNER_LIVE_ENABLED=1`.
Quotes, orders, shipments, cancellations, returns, documents and webhooks are later batches (see `BATCH2_DESIGN.md`).

## 1. Get a key

A KINAN admin creates your organisation and store (Admin → Suppliers & channels → Partner API) and issues a
**sandbox key** (`knp_test_…`). The key is shown once. KINAN stores only a SHA-256 hash.

To rotate a key, ask KINAN for a second key, switch to it, then have the old one revoked. Keys work until they are revoked.

```bash
export KINAN=https://kinan.shop/api/partner/v1
export KEY=knp_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # never commit this
curl -s -H "Authorization: Bearer $KEY" $KINAN/me
```

`/me` tells you:
- the environment (`sandbox`), your organisation and store
- your scopes, enabled markets and locales
- your currencies and price-list version

## 2. Import: snapshot

```bash
curl -s -H "Authorization: Bearer $KEY" "$KINAN/catalog/products?market=DE&locale=de-DE&limit=50"
```

Keep calling with `cursor=<next_cursor>` until `next_cursor` is `null`. The last page returns `sync_cursor`,
which is bound to the feed position when page 1 was read. Save it.

- IDs are opaque and stable. Map KINAN `product_id` and `variant_id` to your own IDs:
  - `kp_…` is a product
  - `kv_…` is a variant
- Publish to your storefront as drafts first and review them.
- `wholesale_unit_price_ex_tax` is indicative: goods only, before tax and delivery. The quote (Batch 2) is binding.
- You set your own retail price.
- `availability.state` is one of `in_stock`, `out_of_stock` or `unknown`.
  - `sellable_quantity` appears only where KINAN controls the stock.
  - The sandbox's numbers are synthetic.

## 3. Stay current: change feed

```bash
curl -s -H "Authorization: Bearer $KEY" "$KINAN/catalog/changes?market=DE&locale=de-DE&cursor=$SYNC_CURSOR"
```

Apply events in `seq` order and store `next_cursor` **in the same transaction** as their effects. Repeat while
`has_more` is `true`, then poll every few minutes.

| type | what to do |
|---|---|
| `upsert` | Create or update the product from `product` if its `version` is greater than or equal to the one you hold. |
| `withdraw` | Stop selling and unpublish the product. Ignore it if you never had the product. |

- **Reasons:**
  - `created`, `updated`, `inventory`, `restored`
  - `withdrawn`, `market_removed`
  - `entitlement_granted`, `entitlement_revoked`
  - `price_list`, `not_entitled`
- **Versions only grow.** If you are unsure about a product, `GET /catalog/products/{product_id}` gives its current state.
- **Writes during your snapshot** reach you through the feed. You do not need to pause anything.
- **`410 CURSOR_EXPIRED`** means changes older than 30 days were dropped: build a fresh snapshot.
- **Cursors are tied** to your store, the market and the locale. Reusing one for another query answers `400 CURSOR_SCOPE_MISMATCH`.

## 4. Errors

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) `application/problem+json` with `type`, `title`,
`status`, `code` and `request_id`. They can also carry `detail` and `errors` (field errors).
Every response has an `X-Request-Id` header: quote it to KINAN support.

| status | code | meaning |
|---|---|---|
| 400 | `INVALID_INPUT`, `INVALID_CURSOR`, `CURSOR_SCOPE_MISMATCH` | Fix the request. For a bad cursor, start again from a snapshot. |
| 401 | `INVALID_CREDENTIAL` | The key is missing, unknown or revoked. |
| 403 | `INSUFFICIENT_SCOPE` | The key lacks the scope this call needs. |
| 404 | `RESOURCE_NOT_FOUND` | The product is unknown, or your store is not entitled to it in this market. |
| 410 | `CURSOR_EXPIRED` | Rebuild from a new snapshot. |
| 422 | `UNSUPPORTED_DESTINATION` | The market is not enabled for your store. |
| 429 | `RATE_LIMITED` | Wait for the number of seconds in `Retry-After`. The default limit is 120 requests per minute per store. |
| 503 | `TEMPORARILY_UNAVAILABLE` | KINAN paused your store's access. |

## 5. Sandbox

The sandbox serves 12 **fictional** products in Germany and the UK, with German and English text. Images use `assets.example.com` placeholders.

KINAN can change sandbox products (stock, cost, withdraw or restore) from the admin simulator, so you can test your sync.
The sandbox never contains real products, suppliers or customers.

## 6. Change policy

- Within v1, changes are additive only: new fields, new enum values (handle unknown `reason` values) and new endpoints.
- Breaking changes go to a new version with notice.
- The changelog is kept in this folder.

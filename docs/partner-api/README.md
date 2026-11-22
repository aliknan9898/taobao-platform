# KINAN Partner API v1 — quickstart

Server-to-server API for approved partner stores. The contract is `docs/partner-api/openapi.json`
(OpenAPI 3.1.1), also served at `GET /api/partner/v1/openapi.json`.

**Status:** sandbox only.
- Live keys cannot be issued until the owner sets `PARTNER_LIVE_ENABLED=1`.
- Quotes, orders and everything after them (shipments, cancellations, returns, documents, webhooks) answer `503`
  until the owner sets `PARTNER_ORDERS_ENABLED=1`. They need PostgreSQL.

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

## 4. Quote, then order

```bash
curl -s -X POST $KINAN/quotes -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"currency":"EUR","destination":{"country":"DE","postal_code":"10115"},"items":[{"variant_id":"kv_sbx_lamp_white","quantity":2}]}'
```

The answer is a locked quote (`201`):
- It expires after 15 minutes.
- The totals are integer cents: items, shipping, duties, handling, tax and the payable amount.
- `charges` says who pays each charge.
- `fulfillment_estimate` gives the origins and the delivery range in business days.
- A quote does **not** reserve stock.

Check the quote before you take your customer's payment where you can. If you charge your customer and KINAN then refuses the order, refunding your customer is your responsibility.

```bash
curl -s -X POST $KINAN/orders -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: mystore-1001-create' \
  -d '{"quote_id":"pq_…","external_order_ref":"STORE-1001","shipping_address":{"recipient":"…","line1":"…","city":"Berlin","postal_code":"10115","country":"DE"}}'
```

**Idempotency-Key** (required, 8–128 characters):
- Use one per new order and the same one for every retry of that order.
- Same key and same body: the original answer comes back (`Idempotent-Replayed: true`).
- Same key, different body: `409 IDEMPOTENCY_CONFLICT`.
- An `external_order_ref` can be used once per store. A new key with the same reference gets `409 ORDER_REFERENCE_CONFLICT`.
- KINAN keeps keys for 30 days.

**Conflicts:** `409 QUOTE_EXPIRED`, `QUOTE_MISMATCH` (country or postal code differ from the quote) and `STOCK_CHANGED` mean: request a fresh quote.

**What the order does:**
- It reserves stock KINAN controls.
- Its status has two independent parts:
  - `payment`: `pending` → `settled` or `approved_terms`
  - `fulfillment`: `received` → `confirmed` → …
- Fulfilment starts only after settlement under your B2B agreement. In the sandbox, KINAN marks the payment by hand.
- If it is not paid within the reservation window (60 minutes by default), the reservation is released and the order is cancelled.
- Recipient data is encrypted at rest. Send only the fields the parcel needs. Never send card or payment details.

**Reading orders:** use `GET /orders/{order_id}` and `GET /orders?external_order_ref=STORE-1001`. Paging works the same way as the catalogue.

## 5. After the order: fulfilment and shipments

After KINAN marks the payment, the order moves on by itself:

| `status.fulfillment` | meaning |
|---|---|
| `confirmed` | Paid or on approved terms. Waiting to be handed to the supplier or warehouse. |
| `processing` | Handed off. From now on a cancellation needs KINAN's decision. |
| `partially_shipped` / `shipped` | One shipment per ship-from origin (for example one from DE, one from CN). |
| `delivered` | Every parcel delivered. Returns open now. |
| `exception` | A carrier reported a problem. KINAN follows up. |
| `cancelled` | Cancelled. Reserved stock is released. |

```bash
curl -s -H "Authorization: Bearer $KEY" $KINAN/orders/po_…/shipments
```

Each shipment has `carrier`, `tracking_number`, `items` and `events` (`label_created`, `in_transit`, `delivered`…).
Show the tracking number to your customer.

## 6. Cancellations

```bash
curl -s -X POST $KINAN/orders/po_…/cancellations -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: mystore-1001-cancel' -d '{"reason_code":"customer_request"}'
```

- **Before handoff** (`received`, `confirmed`): `accepted` at once. Stock is released. A settled payment becomes `credited`.
- **After handoff** (`processing`): `requested`. KINAN accepts or rejects it, and you get a `cancellation.updated` event.
- **After shipping**: `409 ORDER_NOT_CANCELLABLE`. Wait for delivery and request a return.
- Reasons: `customer_request`, `duplicate_order`, `address_issue`, `payment_issue`, `other`.
- Same Idempotency-Key rules as orders.

## 7. Returns (RMA)

```bash
curl -s -X POST $KINAN/orders/po_…/returns -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: mystore-1001-return-1' -d '{"reason_code":"damaged","items":[{"variant_id":"kv_sbx_lamp_white","quantity":1}]}'
```

- Only delivered items, within **30 days of delivery**, up to the quantity not already returned. Otherwise
  `409 RETURN_NOT_ALLOWED` with one entry per line in `errors`.
- States: `requested` → `approved` (with `instructions` and the `rma_number` to write on the parcel) or `rejected`
  → `received` → `credited`.
- The credit is the goods value ex tax from your order. Shipping is not credited. The order's payment becomes
  `partially_credited`, or `credited` once everything has come back.

## 8. Documents

`GET /orders/{order_id}/documents` lists the PDFs available now; `links.download` fetches one.

- `proforma`: pro-forma invoice, from the moment the order exists.
- `packing_slip`: once handed off. The only document that shows the recipient.
- `credit_…`: a credit note per credited return, or for a credited cancellation.

Sandbox documents say **SANDBOX — NOT A TAX DOCUMENT**. Live tax documents start when KINAN's invoicing entity is set up.

## 9. Webhooks

Webhooks tell you that something changed; you can always poll instead.

1. `POST /webhook-endpoints` with `{"url": "https://…", "events": [...]}`.
   - Events: `order.updated`, `shipment.updated`, `cancellation.updated`, `return.updated`. The default is all four.
   - HTTPS on a public address only. At most 5 endpoints per store.
   - Copy the `secret` (`whsec_…`): it is shown once.
2. `POST /webhook-endpoints/{id}/verify`. KINAN sends a signed `endpoint.verification` event: answer `200` with
   `{"challenge": "<data.challenge>"}`. Nothing is delivered before this succeeds.
3. Check every request:

```js
// Node.js: rawBody is the exact bytes you received
const [t, v1] = header.split(',').map((x) => x.split('=')[1]);
const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
const ok = Math.abs(Date.now() / 1000 - Number(t)) < 300 && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v1));
```

- Answer any 2xx within 10 seconds and do the work afterwards.
- Failures are retried with growing gaps (30 s, 1 min, 2 min … at most 1 h apart) for 24 hours. After that the delivery
  is `dead`.
- `GET /webhook-endpoints/{id}/deliveries?state=dead` lists dead deliveries. `POST /webhook-endpoints/{id}/replay`
  with `{"event_id": "evt_…"}` sends one again with the same event id.
- 50 failures in a row disable the endpoint.
- An event can arrive twice or out of order:
  - Store the event `id` and ignore repeats.
  - Apply `data` only if `data.version` is newer than yours.
- Payloads never contain your customer's address or contact details.
- To rotate the secret, create a new endpoint, verify it, then delete the old one.

## 10. Testing in the sandbox

`POST /sandbox/orders/{order_id}/simulate` with `{"action": "…"}` moves a sandbox order on, so you can test every
state and webhook without waiting for KINAN:

- `handoff`
- `ship` (optionally with `"ship_from": "CN"`), `deliver`, `exception`
- `accept_cancellation`, `reject_cancellation`
- `approve_return`, `reject_return`, `receive_return`, `credit_return`

Payment is still marked by KINAN. It works with sandbox keys only.

## 11. Errors

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) `application/problem+json` with `type`, `title`,
`status`, `code` and `request_id`. They can also carry `detail` and `errors` (field errors).
Every response has an `X-Request-Id` header: quote it to KINAN support.

| status | code | meaning |
|---|---|---|
| 400 | `INVALID_INPUT`, `INVALID_CURSOR`, `CURSOR_SCOPE_MISMATCH` | Fix the request. For a bad cursor, start again from a snapshot. |
| 401 | `INVALID_CREDENTIAL` | The key is missing, unknown or revoked. |
| 403 | `INSUFFICIENT_SCOPE` | The key lacks the scope this call needs. |
| 404 | `RESOURCE_NOT_FOUND` | The product is unknown, or your store is not entitled to it in this market. |
| 409 | `QUOTE_EXPIRED`, `QUOTE_MISMATCH`, `STOCK_CHANGED`, `IDEMPOTENCY_CONFLICT`, `ORDER_REFERENCE_CONFLICT` | Read the code. For quote and stock problems, request a fresh quote. |
| 409 | `ORDER_NOT_CANCELLABLE`, `CANCELLATION_PENDING`, `RETURN_NOT_ALLOWED`, `INVALID_STATE`, `LIMIT_REACHED` | The order or resource is not in a state that allows this step. See `detail` and `errors`. |
| 422 | `ENDPOINT_VERIFICATION_FAILED` | Your endpoint did not echo the challenge. |
| 410 | `CURSOR_EXPIRED` | Rebuild from a new snapshot. |
| 422 | `UNSUPPORTED_DESTINATION`, `BASKET_NOT_ELIGIBLE` | The market is not enabled, or a line cannot be supplied (see `errors`). |
| 429 | `RATE_LIMITED` | Wait for the number of seconds in `Retry-After`. The default limit is 120 requests per minute per store. |
| 503 | `TEMPORARILY_UNAVAILABLE` | KINAN paused your store's access. |

## 12. Sandbox

The sandbox serves 12 **fictional** products in Germany and the UK, with German and English text. Images use `assets.example.com` placeholders.

The electronics ship from CN (direct, with import handling) and everything else ships from a DE warehouse, so you can test baskets with two parcels.

KINAN can change sandbox products (stock, cost, withdraw or restore) from the admin simulator, so you can test your sync.
The sandbox never contains real products, suppliers or customers.

## 13. Change policy

- Within v1, changes are additive only: new fields, new enum values (handle unknown `reason` values) and new endpoints.
- Breaking changes go to a new version with notice.
- The changelog is in `CHANGELOG.md` in this folder.

# Partner API v1 — changelog

Within v1 changes are additive only. Handle unknown fields, enum values and event types.

## Connectors — KINAN for WooCommerce (sandbox)
- No change to the Partner API contract.
- KINAN-run WooCommerce connector. WooCommerce calls `/api/partner/connect/woocommerce/callback`, `/return` and `/webhooks/{connection}`. See `WOOCOMMERCE_RUNBOOK.md`.

## Batch 4 — KINAN for Shopify (sandbox)
- No change to the Partner API contract.
- New KINAN-run Shopify connector. Shopify calls KINAN on `/api/partner/connect/shopify/callback` and `/webhooks`. See `SHOPIFY_RUNBOOK.md`.

## 1.2.0 — Batch 3 (sandbox)
- New endpoints:
  - `GET /orders/{order_id}/shipments`
  - `POST/GET /orders/{order_id}/cancellations`
  - `POST/GET /orders/{order_id}/returns`
  - `GET /orders/{order_id}/documents[/{document_id}]`
  - `/webhook-endpoints` (create, list, delete, verify, deliveries, replay)
  - `POST /sandbox/orders/{order_id}/simulate`
- `Order.links` gains `shipments`, `cancellations`, `returns` and `documents`.
- New problem codes: `ORDER_NOT_CANCELLABLE`, `CANCELLATION_PENDING`, `RETURN_NOT_ALLOWED`, `ENDPOINT_VERIFICATION_FAILED`, `LIMIT_REACHED`.
- New webhook events: `order.updated`, `shipment.updated`, `cancellation.updated`, `return.updated` (signed, see README §9).
- Keys issued from now on carry every scope. Older keys keep the four Batch 1–2 scopes; ask KINAN for a new key to use returns, documents and webhooks.

## 1.1.0 — Batch 2 (sandbox)
- `POST /quotes`, `POST /orders` (Idempotency-Key), `GET /orders`, `GET /orders/{order_id}`.

## 1.0.0 — Batch 1
- `GET /me`, catalogue snapshot, product, change feed, OpenAPI.

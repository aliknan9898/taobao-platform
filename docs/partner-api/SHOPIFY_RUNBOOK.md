# KINAN for Shopify — setup and support runbook (Batch 4)

KINAN runs the connector itself. A partner store connects its Shopify shop to its KINAN partner store, then:

| Direction | What happens | Code |
|---|---|---|
| KINAN → Shopify | Entitled products are created as **drafts** with live stock, `kinan.product_id`/`kinan.variant_id` metafields and the wholesale price (`kinan.wholesale_price`). Withdrawn products go to 0 stock with the tag `kinan-withdrawn`. | `syncCatalog`, `upsertProduct`, `withdrawProduct` |
| Shopify → KINAN | Paid orders (webhook `orders/paid` plus polling for lost webhooks) become Partner API orders for the KINAN lines only. Each Shopify order gives one KINAN order (`SHOPIFY-<order id>`). | `importOrder`, `pollOrders` |
| Shopify → KINAN | A cancellation in Shopify requests a KINAN cancellation. | `handleCancelled` |
| KINAN → Shopify | Each KINAN shipment becomes a Shopify fulfillment with carrier and tracking number. Shopify emails the buyer when **Email the buyer when it ships** is on. | `writeBack` |

**The partner's retail price, title and description are never changed after creation** unless the admin switches on
**Update retail prices automatically** (`auto_price`) or `update_content`.

## 1. One-time setup (owner)

1. In the [Shopify Dev Dashboard](https://dev.shopify.com), create the app **KINAN for Shopify** (public distribution, unlisted is fine for the pilot).
   - Redirect URL: `https://kinan.shop/api/partner/connect/shopify/callback`
   - Access scopes: `read_products, write_products, read_inventory, write_inventory, read_locations, read_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders`
   - Compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`): `https://kinan.shop/api/partner/connect/shopify/webhooks`
   - Request access to **protected customer data**. Orders carry the buyer's name and address, which KINAN needs to ship. Shopify reviews this before the app can be used on shops outside KINAN's organisation.
2. In Render, set these yourself (Claude never handles secrets):
   - `SHOPIFY_API_KEY` = the app's client ID
   - `SHOPIFY_API_SECRET` = the app's client secret
   - `PARTNER_SHOPIFY_ENABLED=1`
   - Optionally `SHOPIFY_API_VERSION` (default `2026-10`, verified when Batch 4 was built; Shopify supports each version for 12 months).
   - Also needed: `PARTNER_ORDERS_ENABLED=1`, which applies migration 003 together with 001–002.
3. `PUBLIC_BASE_URL` must be `https://kinan.shop`. If it is not https, KINAN does not register webhooks and relies on polling (every minute).

## 2. Development-store round trip (acceptance before any pilot)

1. In the Dev Dashboard, create a **development store** in the same organisation as the app and install the app there.
2. Admin → Suppliers & channels → Partner API → **Shopify stores**: choose the sandbox partner store, enter `name.myshopify.com`
   and press **Connect KINAN dev store**. This uses the client credentials grant, so there is no redirect.
3. Press **Sync now**. In Shopify → Products you should see the sandbox products as **Draft**, vendor KINAN, tag `kinan`.
4. Publish one product in Shopify and change its price. Change its stock in the Partner API sandbox simulator.
   - After the next sync the Shopify stock follows.
   - The price and the Active status stay as they are.
5. Place a test order in the dev store (Shopify's Bogus Gateway) with a DE address.
   - It appears in **Partner orders (sandbox)** as `SHOPIFY-<id>`.
6. Press **Mark settled (test)**, then **Hand off (test)**, then **Ship (test)**.
   - After the next sync the Shopify order is fulfilled, with the sandbox carrier and tracking number.
7. Cancellation: place a second order, then cancel it in Shopify. The KINAN order becomes `cancelled`.
8. Lost webhook: temporarily set `PUBLIC_BASE_URL` to an http URL, or delete the webhook subscription in Shopify, then place an order. It still arrives within a minute through polling.
9. Duplicate order: in Shopify → Settings → Notifications → Webhooks, send the same `orders/paid` again. There is still exactly one KINAN order.
10. Revoked credential: uninstall the app in the dev store.
    - The connection shows **Removed** and the token is deleted.
    - Install again to reconnect. Product mappings are kept.

Real partner shops use the **Get install link** button: send the link to the shop owner (valid 10 minutes). They approve
the scopes in Shopify and land on a KINAN confirmation page.

## 3. Statuses and what to do

| Status | Meaning | Action |
|---|---|---|
| Connected | Syncing every minute | — |
| Paused | Admin paused it | **Resume** |
| Access lost (`auth_failed`) | Shopify refused the token or the token refresh (app removed, permissions changed, or the 90-day refresh token expired) | Send a new install link. Mappings are kept. |
| Removed (`uninstalled`) | The merchant uninstalled the app, or an admin pressed **Disconnect**. The token is deleted. | New install link if the partner wants to continue. |

**Shopify orders that need you** lists orders KINAN could not take. The reason codes come from the Partner API:

- `UNSUPPORTED_DESTINATION`: the country is not enabled for the partner store.
- `BASKET_NOT_ELIGIBLE`: out of stock or below the 30% target.
- `INVALID_INPUT`: an incomplete address.

Fix the cause (for example enable the market or correct the address in Shopify), then press **Try again**. Reasons
starting with `retry:` are temporary and are retried automatically up to 8 times.

**Privacy requests from Shopify**:
- `customers/data_request`: send the shop the data KINAN holds for those order numbers (recipient data of partner orders) within 30 days.
- `customers/redact`: KINAN keeps recipient data only as long as fulfilment, returns and legal retention need it. Note the decision, then press **Mark answered**.
- `shop/redact` (48 h after uninstall): deletes the connection data automatically. KINAN's own partner order records remain.

## 4. Safety properties (tested in `test/partner-shopify.test.js`)

- **Install:** the HMAC of the redirect is checked, the state is single-use and tied to the shop and lasts 10 minutes, and only `*.myshopify.com` hosts are accepted. Expiring offline tokens (`expiring=1`): the refresh token rotates, and a refused refresh means the merchant must reinstall.
- **Tokens:** stored with AES-256-GCM in `partner_connection.credentials` and never logged or shown.
- **Webhooks:**
  - Base64 HMAC-SHA256 of the raw body with the app secret, checked before parsing; an invalid signature answers 401.
  - The same `X-Shopify-Webhook-Id` is processed once.
- **Orders:**
  - Exactly one KINAN order per Shopify order: a claim row is shared by webhooks, polling and parallel workers.
  - The Partner API idempotency key and the order reference are derived from the Shopify order id.
  - After a crash, the existing KINAN order is found and linked.
- **Fulfilments:** before creating one, KINAN looks for an existing fulfilment with the same tracking number, so a crash cannot fulfil twice. Quantities never exceed what is left to fulfil.
- **Products:**
  - Creation goes through `productSet` keyed by the handle `kinan-<product id>`, so a retried create updates instead of duplicating.
  - Stock uses `inventorySetQuantities` with an `@idempotent` key and `changeFromQuantity: null` (KINAN is the source of truth for these items).
- **Calls to Shopify:** no Shopify call runs inside a SQL transaction. Every request has a 30 s timeout and redirects are refused.

## 5. Limits (honest list)

- **Not tested against a real shop yet:** tested only against a fake Shopify built from the 2026-10 documentation. The development-store round trip above still has to be run once the app exists.
- **Variants:**
  - Up to 100 per product and 3 options.
  - A variant KINAN adds later is not added to an existing Shopify product: it needs a manual resync of that product, by deleting its mapping.
- **Stock:** goes to the shop's first active location unless `location_id` is set.
- **Payment:** the KINAN order still needs B2B settlement (the sandbox has a button). Shopify's own payment from the buyer never reaches KINAN.
- **Live:** sandbox partner stores only until live keys, tax and invoicing are approved.
- **WooCommerce:** not built (the next adapter would reuse the same tables and flow).

## 6. Rollback

- **Switch off:** `PARTNER_SHOPIFY_ENABLED=0`. Webhooks are then acknowledged and ignored, nothing syncs, and products already in Shopify stay there.
- **Code:** deploy the previous commit.
- **Data:** `003_partner_connectors.down.sql` drops only the connector tables. The owner runs it, after 003 and before 002 and 001.

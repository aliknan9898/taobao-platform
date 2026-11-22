# KINAN for WooCommerce — setup and support runbook

Same idea as `SHOPIFY_RUNBOOK.md`, run by KINAN, with one connection per partner store (Shopify or WooCommerce).

| Direction | What happens |
|---|---|
| KINAN → WooCommerce | Entitled products are created as **drafts**: simple products, or variable ones with variations. SKUs start with `KINAN-`, so they never collide with the shop's own. Stock is managed by KINAN; meta data holds `kinan_product_id`, `kinan_variant_id` and `kinan_wholesale_price`. Withdrawn products go to stock 0 with `kinan_withdrawn = 1`. |
| WooCommerce → KINAN | Paid orders (status *processing*/*completed* with a payment date) become Partner API orders for the KINAN lines only, exactly once (`WOO-<order id>`). They arrive by webhook (`order.created`, `order.updated`), with polling every minute as the fallback. |
| WooCommerce → KINAN | Status *cancelled* or *refunded* requests a KINAN cancellation. |
| KINAN → WooCommerce | Each KINAN shipment adds an order note with carrier and tracking number. It is a customer note (WooCommerce emails it) when **Email the buyer when it ships** is on. If the *Shipment Tracking* extension is installed, a tracking entry is added as well. When KINAN has shipped everything and the order has only KINAN lines, the order becomes *completed* (`mark_completed`). |

The partner's price, title and description are never changed after creation unless `auto_price` / `update_content` are switched on.

## 1. Setup (owner)

1. In Render, set `PARTNER_WOOCOMMERCE_ENABLED=1` yourself (it needs `PARTNER_ORDERS_ENABLED=1`, which applies migrations 001–004).
2. `PUBLIC_BASE_URL` must be `https://kinan.shop`. WooCommerce only sends keys and webhooks to https.
3. No app registration is needed.

## 2. Connecting a shop

- **Usual way:**
  1. Admin → Partner API → Partner shops → **Connect a WooCommerce shop**. Choose the partner store, enter the shop address (`https://…`, including a sub-folder if WordPress lives in one) and press **Get WooCommerce link**. Send the link to the shop owner; it is valid for 30 minutes.
  2. The shop owner logs in to WordPress and approves **KINAN** with **Read/Write** access.
  3. WooCommerce sends the keys straight to KINAN, and the owner lands on a KINAN confirmation page.
- **If that fails** (old WooCommerce, security plugins, plain permalinks):
  1. The shop owner creates a key in WooCommerce → Settings → Advanced → REST API, with Read/Write access.
  2. They give it to you through a safe channel.
  3. You enter it under **I have API keys**.
  - KINAN checks the key against the shop before saving it.

**Requirements on the shop:**
- HTTPS.
- Pretty permalinks (anything but "Plain").
- The REST API not blocked by a security plugin or firewall for KINAN's server.
- The shop address must resolve to a public address. KINAN never calls private or internal addresses.

## 3. Test round trip (before any pilot)

Use a staging WordPress with WooCommerce, test payments (for example *Cash on delivery* or a payment plugin's test mode) and a German address:

1. Connect the shop and press **Sync now**. Products → Drafts shows the sandbox products with `KINAN-` SKUs.
2. Publish one product and change its price. Change its stock in the Partner API sandbox simulator.
   - After the next sync the WooCommerce stock follows.
   - The price stays as it is.
3. Place and pay an order. It appears under **Partner orders (sandbox)** as `WOO-<id>`.
4. Press **Mark settled (test)**, then **Hand off (test)**, then **Ship (test)**.
   - The order gets a customer note with the tracking number and becomes *Completed*.
5. Cancel a second order in WooCommerce. The KINAN order becomes *cancelled*.
6. Lost webhook: in WooCommerce → Settings → Advanced → Webhooks, pause the KINAN webhooks and place an order. It still arrives through polling.
   - KINAN re-activates its webhooks within the hour, because WooCommerce disables a webhook after repeated failures.
7. Revoked key: delete the KINAN key in WooCommerce. The connection shows **Access lost**. Reconnect with a new link or key; product mappings are kept.

## 4. Support

The statuses and the **Shop orders that need you** list work as in the Shopify runbook §3.

**Disconnect** deletes KINAN's webhooks from the shop and the stored keys. Also ask the shop owner to revoke the KINAN key in WooCommerce → Settings → Advanced → REST API.

## 5. Safety properties (tested in `test/partner-woocommerce.test.js`)

- **Connecting:**
  - The key callback must carry a single-use state that is tied to the shop and lasts 30 minutes.
  - Read-only keys are refused, and keys are verified against the shop before they are stored.
  - Keys are encrypted at rest (AES-256-GCM).
- **Calls to the shop:**
  - https only, and the host must resolve to public addresses only (checked on every call).
  - The connection is pinned to the checked address.
  - No redirects, 30 s timeout, answers capped at 5 MB.
- **Webhooks:**
  - Each connection has its own secret. Signatures (`X-WC-Webhook-Signature`) are checked in constant time.
  - The unsigned creation ping is answered.
  - Repeated delivery ids are ignored.
- **Orders:** exactly one KINAN order per WooCommerce order (the shared claim row with Shopify, plus a derived Idempotency-Key and reference).
- **Products and notes:**
  - Products are looked up by KINAN SKU before they are created.
  - Tracking notes are matched by tracking number, so a crash never duplicates them.

## 6. Limits (honest list)

- **Not tested against a real shop yet:** tested against a fake WooCommerce built from the wc/v3 documentation. The test round trip above still has to be run on a staging shop.
- **Variations:** up to 100 per product.
- **Stock location:** WooCommerce has a single stock location.
- **Tracking:** WooCommerce has no built-in fulfilment object, so tracking arrives as a note, or through the extension when installed.
- **Payment:** the buyer's payment to the shop never reaches KINAN. The B2B settlement is separate.
- **Live:** sandbox partner stores only until live is approved.

## 7. Rollback

- **Switch off:** `PARTNER_WOOCOMMERCE_ENABLED=0`. Webhooks are acknowledged and ignored, and nothing syncs.
- **Data:** `004_partner_woocommerce.down.sql` (owner only) removes WooCommerce connections and narrows the platform check again.

# Libya market (LY)

Part 2 of the Delivery Country handoff, covering sections 8–11 of the brief. Libya stays **closed to customers** until the owner opens it (Admin → Libya → Settings, or `PATCH /api/admin/ly/config { enabled: true }`, owner only). While Libya is closed, a customer who chooses Libya sees the Part 1 behaviour.

## Storefront

- **Libya's own catalogue.** Choosing Libya opens a catalogue that shows only published Libya offers, priced in LYD. Products from other markets never appear, and Libya offers never appear in other markets: they are absent from search, return 404 on their detail page, get the `libya_only` reason in the cart check, and cannot be bought through the main checkout.
- **Language.** Arabic RTL is the default for Libya, unless the customer has chosen a language themselves.
- **Filters and labels.** Customers can filter by route: All / متوفر داخل ليبيا (local stock) / يُشحن من الصين (ships from China). Each product card shows its route label.
- **City.** The header asks for a city (*اختر مدينتك للتحقق من التوصيل المحلي*).
  - Before a city is chosen, every Libya offer with coverage somewhere is shown, with that prompt.
  - After a city is chosen, the catalogue is filtered by that city's route coverage and by stock at the locations that serve it.
- **Product page.** Shows the route, LYD price, options, the delivery fee and estimate for the chosen city, what the price includes, and any amount still payable on delivery.
- **Checkout** (`#/ly-checkout`):
  - Asks for the recipient's name and a validated Libyan mobile number (stored as +2189x…), then city, service area, address and an optional landmark. A map pin is requested only when the city requires one.
  - Each route is a separate delivery with its own charge. The order total is in LYD.
  - Payment is cash on delivery when the area, route, order value and carrier all allow it. Online payment stays off until a provider is verified for Libya.
  - The server revalidates everything before the order is created. If the total changed, it returns `TOTAL_CHANGED` and the customer confirms the new total.
- **Orders.** The customer's Libya orders appear on the Orders page, with their delivery status, tracking reference and payment method.

## Data model

All collections live in `kinan_docs`, so no schema migration is needed.

| Collection | What it holds |
|---|---|
| `ly_offers` | Libya offers: Arabic and English copy, photos, category, collections, featured flag. Variants have an LYD price, a cost (finance only) and an optional `sku_ref` to a shared product. Each offer also has its route (`local`, `china` or `direct`), status (`draft`, `published` or `paused`), content approval, China quote or supplier confirmation (each with evidence), and a change history with actor and time. It can link to a shared product (`product_id`) and to a seller (`seller_id`). |
| `ly_cities` | Cities, with Arabic and English names, aliases, service areas (each can switch COD off) and routes. Each route has: enabled, verified, fee, delivery days, COD, COD limit, carrier, includes, amount payable on delivery, and the serving locations (local route). Plus the map-pin requirement and a carrier reference. |
| `ly_locations` | Stock locations: Kinan's, or a seller's (`seller_id`). |
| `ly_stock` | Available and reserved units per offer variant × location. |
| `ly_moves` | Every stock change, with its reason, reference and actor. |
| `ly_reservations` | Stock held for an order: `active`, then `consumed` (at dispatch) or `released` (on cancellation or expiry), each exactly once. |
| `ly_orders` | LYD orders: the price and quote breakdown, one delivery per route, independent delivery, payment and settlement statuses, and an event log. |
| `ly_cash` | Cash on delivery entries: `expected`, `collected` (with the carrier fee) and `remitted` (with the settlement reference). Idempotent by key. |
| `ly_returns` | Returns: the lines, an inspection per line (approved / rejected units), restocking done once, and the refund (finance only). |

**Why Libya orders are stored separately.** Libya orders are not written to `db.orders`. That keeps them out of the Stripe, supplier-ordering, payout and China-warehouse jobs, so a Libya order can never trigger a card charge or a supplier order.

## Rules enforced on the server

- **Publishing** an offer needs four things:
  - every active variant has a valid LYD price;
  - the content is approved (an Arabic title and at least one photo);
  - a verified route covers at least one city;
  - China offers have a quote with its evidence, and direct offers have the supplier's confirmation and a quote.

  Changing an offer's content takes away its approval. An offer that stops meeting these rules is paused.
- **Routes:**
  - Local delivery uses its own delivery limit; the limit is not applied by default.
  - China and direct routes must be marked verified, and the international limit applies (30 and 21 days by default, configurable).
- **Reservations are all or nothing.** The check and the write run synchronously, so no other request can run in between. As a result, two customers cannot both get the last unit. Orders that are not confirmed release their stock after `reservation_hours` (48 by default; the job runs every 15 minutes).
- **Cash on delivery:**
  - is off for China and direct (imported) orders unless the owner enables `cod_imported`;
  - also needs: COD on the route, COD allowed in the area, a carrier on the route, and the order within the global and route COD limits.
- **Statuses are independent:**
  - delivery: pending_confirmation → confirmed → packed → dispatched → delivery_attempted / rescheduled → delivered, refused, returned_to_sender, cancelled or returned;
  - payment: due_on_delivery → collected;
  - settlement: expected → collected → remitted, or discrepancy.
- **Every order event needs a unique `key`.** The same key sent again changes nothing, so it cannot cause a second stock movement or a second cash entry. A carrier integration will use the same endpoint.
- **Returns.** Only the units approved at inspection go back to sellable stock, and only once. Refunds need the finance function, happen once, and are written to the audit log.
- **Audit.**
  - Changes to price, stock, visibility, coverage, order status, settlement and refunds are written to `db.audit` (`libya.kind`) with the actor and the time.
  - Every Admin call by Libya staff is audited, refused ones included.

## Permissions

| Function | What it covers | Who has it |
|---|---|---|
| catalog | offers, content approval, prices, collections, bulk edits (with a preview and the affected count) | owner, admin, procurement |
| stock | locations, stock adjustments, return inspection | owner, admin, procurement, warehouse |
| orders | orders, delivery updates, returns, orders export | owner, admin, support, warehouse, finance |
| coverage | cities, areas, routes, reservation hours, route limits | owner, admin |
| finance | margins (cost), COD settlement, refunds, COD and payment settings, financial exports | owner and finance staff only |

- **Libya staff (`ly_staff`)** see only the Admin → Libya section, with the functions the owner ticks. Every other Admin route refuses them.
- **Opening Libya to customers** is for the owner only.

## Rollout (staging first)

1. **Set up coverage:** a stock location and one city with a local route and a carrier.
2. **Set up an offer:** a local-stock offer, approved and published, with stock received.
3. **Open Libya (staging).** Place one complete COD order: confirm, pack, dispatch, deliver, then remit. Then one return: inspect it and refund it.
4. **China consolidation, separately:** a verified route, a China quote and an order. The existing China warehouse receiving and packing steps are not yet connected to Libya orders, so they are handled by hand from the Libya order list.
5. **Carrier APIs:** only after their credentials and behaviour are verified. They use the same idempotent events endpoint.
6. **Production:** the owner opens Libya.

## Not done yet (needs owner decisions or live verification)

- Automatic hand-off of China-route Libya orders to the warehouse app (receiving, inspection, packing).
- Carrier integrations, and an online payment provider for Libya.
- Seller-app screens for seller-owned Libya stock. Admin can already create seller locations and seller offers.
- LYD exchange-rate tooling: prices are entered in LYD by hand.

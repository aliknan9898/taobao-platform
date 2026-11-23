# Delivery country selection and product availability

Part 1 of the Delivery Country handoff: covers sections 1–7. The Libya market (sections 8–11) comes in a separate release.

## What customers see

- **First visit.** Before any catalogue page loads, the shop asks: *Where should we deliver your order?* / *أين تريد استلام طلبك؟*
  - The list is searchable by English name, Arabic name or ISO code, and grouped by region. The phone's time-zone guess is preselected as *Suggested*.
  - **Use my location** asks for permission only when tapped. It suggests a country and waits for confirmation.
  - Manual choice stays available when location is denied, fails, or finds a country Kinan does not serve.
  - Keyboard: arrows, Home/End, Enter. Escape is disabled on the first visit.
- **Header.** *Deliver to [country]* opens the same selector. The choice is saved on the device (`localStorage.kinan_country`) and, for signed-in customers, on the account (`users.delivery_country`).
  - Choices made before this release count as confirmed: an explicit country, the account's country, or a saved address.
- **Changing country.**
  - The catalogue reloads. Answers to requests sent for the previous country are dropped.
  - The cart is checked again. Lines that cannot be delivered stay in the cart with their reason, and checkout is blocked until they are removed or the country changes.
- **Product links.** A direct link to a product that cannot be delivered still opens. It shows the reason and a *Change country* button, and add-to-cart is disabled.
- **Empty catalogue.** A market with nothing eligible shows *No products currently ship to this country.*
- **Checkout.**
  - The real address decides, whatever country the customer browsed. The server revalidates country, postal code (in enforced markets), variant, quantity, stock and shipping quote before creating an order.
  - The shop sends the total it showed. If the server's total differs, no order is created (`409 TOTAL_CHANGED`); the customer sees the new total and confirms it.

## Data model

- **Collection `eligibility`** (table `kinan_docs`, so no schema migration): one document per listing × country, with id `<listing_id>|<CC>`.

```
{ id, listing_id, country, v: { <mp_sku_id>: { <route>: {
    state, reason, supplier, origin, method, min_days, max_days, fee, currency,
    verified_at, expires_at, attempts, next_retry_at, last_error, legacy? } } } }
```

- **States:** `eligible`, `unavailable`, `over_limit`, `pending_verification`.
  - `over_limit` and expiry are worked out when a record is read, from the stored upper delivery estimate and the country's current limit. Changing a limit therefore needs no new supplier calls.
  - A missing estimate counts as pending.
  - An expired record counts as pending and is queued again.
- **Routes:**

| Listings | Route | How eligibility is decided |
|---|---|---|
| CJdropshipping | `cj_direct` | Verified per variant (vid) and country with CJ `freightCalculate`. Tries the listing's warehouse, then its storage, then China. |
| AliExpress | `ae_direct` | Verified per variant (sku) and country with `aliexpress.ds.freight.query`. |
| Banggood | `banggood_direct` | Existing rule: the countries in Banggood's own list (`src/banggood/countries.js`). No call. |
| Kinan warehouse / seller listings | `kinan_warehouse`, `seller_direct` | Existing rule: Kinan's zone price list (`services/shipping.js`) covers every market. No call. These routes keep their current delivery estimates and are not subject to the supplier transit limit. |
| Any listing, Libya (LY) | — | `market_not_open` until the Libya release. |

- **Free shipping** is only shown where a quote confirms a zero fee. The storefront's existing price display is unchanged.

## Verification queue

- **When it runs:** `services/eligibility.js` `tick()` runs every 5 minutes on the scheduled-jobs instance. It is bounded by `eligibility_config.batch` (default 40 checks a pass) and is safe against overlapping runs: a second call returns `skipped: running`, and in-flight keys are deduplicated.
- **Order of work:**
  - Countries: enforced markets first, then the markets customers choose most (`POST /api/country/confirm`), then the rest.
  - Within a country: first the cheapest in-stock variant of each listing that has nothing eligible yet, so a listing appears as soon as one variant passes. Then the remaining variants.
- **Freshness:** results last 14 days when eligible and 7 days when unavailable (`ttl_days`). They are re-checked a day before they expire.
- **Failures:**

| Failure | Effect |
|---|---|
| CJ points or background budget (`quota`) | CJ paused until `cj/client.retryAt()`. The client's customer reserve (`CJ_POINTS_RESERVE`) is respected because checks run as background work. |
| Throttling | Supplier paused 2 minutes. |
| Authentication | Supplier paused 1 hour. |
| Timeout or malformed reply | Per-check exponential backoff, from 15 minutes up to 24 hours. |

In every case the previous valid result is kept until it expires. Only `attempts`, `next_retry_at` and `last_error` change.

- **Catalogue requests never call suppliers.** They read the in-memory index. The cache keys include the country and an eligibility version that changes only when a variant's state flips or the configuration changes.

## Imports

- **AliExpress builder:** each of the checked destinations (GB, US, DE, FR, ES, IT, PL, MT) is checked on its own. An option is kept when it reaches at least one market within the limit, and every answer is written as an eligibility record straight away.
- **CJ builder (EU/UK warehouses):** a product is kept when it reaches the EU country or the UK in time (previously it needed both).
- **Duplicates:** imports stay idempotent. The existing duplicate checks are unchanged (`ae_product_id`, `cj_pid` and the `tried` sets).
- **Delivery audit:** the old audit (`services/deliveryAudit.js`) paused products for the whole shop when the UK/EU delivery time was too long. It stops doing so once any market is enforced, because each country decides for itself.

## Rollout

1. **Deploy.** Every market starts in **shadow**, so the shop is unchanged. The selector and header chip go live, and the queue starts collecting results.
2. **Shadow backfill.** Admin → Delivery countries → *Shadow backfill report* shows how many earlier results can be reused. Legacy results are reused only when they name the variant and country:
   - CJ `cj_ship[CC]` reuses the variant whose `vid` was quoted.
   - AliExpress `sourcing.delivery_by_country` (or `gb_days` / `eu_days` → GB/DE) is reused only when the listing has a single option.
3. **Apply the backfill (owner only).** *Apply legacy backfill* writes those records. It never overwrites a newer check, and running it twice writes nothing the second time.
4. **Check readiness.** Wait until the market's *Pending* count is low. Then compare *Shown today* with *Available* for the market. The report template is below.
5. **Enforce one market at a time (owner only).** *Enforce*, starting with the markets customers choose most.
6. **Watch:** the empty-state rate, `NOT_DELIVERABLE` checkouts and pending counts.

## Rollback

- Admin → *Roll back: all markets to shadow*, or `PATCH /api/admin/eligibility/config { "rollback": true }`. A single market can also be put back.
- Customers' country choices and every verification record are kept, so re-enforcing is instant.

## Market coverage report (template)

| Market | Mode | Shown today | Available | Unavailable | Over limit | Pending | CJ A/U/O/P | AliExpress A/U/O/P | Kinan A/U/O/P | Customers choosing | Decision |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GB | shadow | | | | | | | | | | enforce / wait |

The numbers come from `GET /api/admin/eligibility` (`markets[].totals`, `markets[].by_supplier`, `markets[].demand`).

## API

| Method | Path | Who | Purpose |
|---|---|---|---|
| any catalogue GET | `?country=CC` or header `X-Kinan-Country` | public | Country-filtered results in enforced markets |
| POST | `/api/cart/check` `{ country, items }` | public | Per-line `{ ok, reason }` |
| POST | `/api/country/confirm` `{ country }` | public | Counts demand (queue priority) |
| GET | `/api/geo/country?lat&lon` | public | Country of rounded coordinates (OpenStreetMap, then `CF-IPCountry`); only Kinan markets |
| PATCH | `/api/buyer/profile` `{ delivery_country }` | buyer | Saves the choice on the account |
| GET | `/api/admin/eligibility` | admin | Coverage report and configuration |
| GET | `/api/admin/eligibility/listing/:id` | admin | Variant × country detail |
| POST | `/api/admin/eligibility/retry` `{ listing_ids, country? }` | admin | Up to 50 listings, through the same queue |
| POST | `/api/admin/eligibility/run` | admin | One bounded pass now |
| POST | `/api/admin/eligibility/backfill` `{ apply }` | admin (apply: owner) | Shadow report or write |
| PATCH | `/api/admin/eligibility/config` | owner | `markets`, `default_max_days`, `max_days`, `rollback`, `batch` |

The checkout errors return `code` and `details`:

| Code | Status | Details |
|---|---|---|
| `NOT_DELIVERABLE` | 409 | `{ country, lines: [{ listing_id, mp_sku_id, title, reason }] }` |
| `TOTAL_CHANGED` | 409 | `{ total, subtotal, shipping_fee, packaging_fee, discount, currency }` |
| `POSTAL_CODE_REQUIRED` | 400 | — |
| `POSTAL_CODE_INVALID` | 400 | — |

## Markets and territory exceptions

- **One list:** `src/countries.js`. It is used by the storefront (`/api/config/public.countries` gives code, English, Arabic and region), the API, Admin and the imports.
- **Included:**
  - every European country, including the United Kingdom as `GB`;
  - Canada, Australia, New Zealand and the United States;
  - Libya;
  - the countries served before this release: Arab markets, Turkey, Malaysia, Indonesia and Pakistan, kept at the owner's request.
- **Not included:**
  - Russia and Belarus (sanctions and supplier restrictions);
  - Kosovo (no ISO 3166-1 code);
  - Crown dependencies and overseas territories (GI, IM, JE, GG, FO, GL, AX);
  - Georgia, Armenia, Azerbaijan and Kazakhstan.
- **Supplier codes** are mapped in `supplierCode()`. All suppliers currently take the ISO codes.

## Still needs live verification (staging or owner-approved)

- AliExpress `freight.query`:
  - whether "no options" always means *no route*, rather than a malformed or partial reply, for every market;
  - whether `GB` or `UK` is the right code.
- CJ `freightCalculate`:
  - answers for the new European markets (AL, BA, MD, ME, MK, RS, UA, IS, LI, AD, MC, SM, VA);
  - point cost at full catalogue scale. At about 10 points a call, the full catalogue × ~70 markets × variants takes several days of background points. The queue order puts enforced and popular markets first.
- `/api/geo/country`: OpenStreetMap Nominatim usage limits, and whether Cloudflare sends `CF-IPCountry` to the origin.
- Postal-code patterns for the enforced markets.

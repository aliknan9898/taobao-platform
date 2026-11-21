# Tasks 16–24: evidence and blockers (21 Nov 2026)

Each task below says what was **verified** (with a test or production log), what was **built**, and what is **blocked**, with its owner.

## 16 Seller Center
- **Verified (tests):**
  - Two sellers cannot see or change each other's products, orders or messages (`test/roles-audit.test.js`).
  - A seller statement reconciles to the cent (`test/seller-warehouse.test.js`): a sale of 50 with 10 % commission leaves 45; after a partial refund of 20, the seller can withdraw 25.
- **Blocked (owner + payment provider):** payout eligibility by seller country. Stripe Connect is unavailable while the Stripe account review is pending. Live transfers stay off.

## 17 Warehouse
- **Local commits:** `0f22e39`, `258c006` and `05ab3d1` do not exist in this repository or its remote. Nothing was recreated.
- **Verified (test):**
  - Two ready orders of the same customer and exact address share one box.
  - A different address is refused, and so is a different customer.
  - A replayed "ship" call is refused, so there is never a second shipment.
- **Existing:** receiving, QC photos with customer approval, weight-based settlement, storage hold, combined boxes.

## 18 KINAN Libya
- **Blocked:** no Libya branch exists (see 17), and there is no LYD currency, city list or carrier.
- **Needs from the owner:** last-mile carrier and price list, cash-collection partner, and which cities to serve.
- **Model when started:** international and local tracking as two separate legs. The tracking code already handles each parcel separately (task 13 test).

## 19 Suppliers and carriers (production logs, 21 Nov)
| Integration | State | Evidence | Blocker / owner |
|---|---|---|---|
| AliExpress (DS API) | **Working** | Feed and freight calls succeed; products added (`[ae-sourcing] ✓ … added`) | Most candidates fail one of 8 markets within 20 days (task 08) — policy decision, owner |
| CJdropshipping | **Working, throttled** | `CJ: no API points left` several times a day | CJ points budget — owner (CJ plan) |
| Taobao | **Not authorised** | `[taobao] app 504980 … InvalidCode Invalid authorization code` | Distributor onboarding — owner |
| Banggood | **Not connected** | No keys | Apply on api.banggood.com — owner |
| NextSmartShip | Connected, wallet 0 | `[nss] … available_amount: 0` | Top-up before China-warehouse orders — owner |
| eBay | Signed in, `kn-907488` | `[ebay] keys accepted (production)` | Overseas-warehouse whitelist approval — eBay |
| Stripe | Live keys, account under review | `[stripe] ready (live mode)`; checkout paused by `PAYMENTS_PAUSED` | Stripe review — Stripe/owner |
| Parcel tracking | Cainiao public tracking + CJ webhooks | Tests: milestones, two parcels apart | — |
| AI (product review) | **Claude credit used up**; Gemini takes over | `[ai] claude 400 … credit balance is too low` → `trying the other AI` | Top up Anthropic credit, or stay on Gemini — owner |

## 20 Etsy, Printful, eBay
- **eBay:** live listings are blocked until eBay approves the overseas warehouses: the form, the CJ agreement and the warehouse addresses (owner, in progress). 78 EU-warehouse listings are ready in German.
- **Etsy (BlushPromise):** plan in `docs/ETSY_BLUSHPROMISE_INTEGRATION.md`. No build until the shop and API access are confirmed.
- **Printful:** not started. No account confirmed.

## 21 Analytics and ads
- **Fixed:** a purchase is reported **once per order**, including payments that return by redirect (bank app, 3-D Secure). The repeat guard is per order in the browser. It is sent in the currency and amount the customer actually paid. Meta and TikTok get an event id, so a later server-side event can be de-duplicated.
- **Existing:** analytics tools load only after the visitor accepts cookies.
- **Not verified:**
  - Google, Meta and TikTok account access. Campaign changes stay behind owner authorisation.
  - There is no server-side Conversions API yet. That is the next step, and it needs the pixel and access tokens.

## 22 Search, SEO and accessibility
- **Verified (test `seo-index.test.js`):**
  - The sitemap lists live products only.
  - Paused and removed products are left out and carry `noindex` without product data.
  - `robots.txt` closes `/admin`, `/seller`, `/warehouse` and `/api/`.
- **Fixed:** a page for an unavailable product or shop used to serve a copy of the homepage that could be indexed. It now says `noindex`.
- **Checked (Playwright, task 12):** Arabic pages render right to left on phone sizes. Long product text no longer widens the page.

## 23 Pilot market (owner decision)
**Recommendation from the data:** **United Kingdom** first, or **Germany** with EU-warehouse stock.
- Products pass the UK and DE delivery checks more often than Malta and the US (task 08 baseline).
- eBay.de listings are ready.
- Malta alone rejects about 28 % of the AliExpress candidates that pass the seven other markets.

**Before launch:** Stripe review cleared; returns address; support hours; unit economics checked on 20 real orders (landed-cost pricing is in place).

## 24 iOS and Android apps
- **Not started, on purpose:** the plan says the web and API flow must be stable first.
- **Ready already:**
  - mobile API tests (`test/mobile-api.test.js`)
  - an `Idempotency-Key` on checkout, so a restarted app cannot charge twice (task 03)
  - native Google and Apple sign-in endpoints
  - Arabic right-to-left layout
  - web push
- **Next:** an Expo/React Native shell for the Shop only, against the current API. Publishing to the app stores needs the owner's developer accounts and approval.

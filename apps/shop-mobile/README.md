# KINAN Shop — mobile pilot (Flutter, Android + iOS)

Buyer app for the first mobile pilot. Native Flutter screens on top of the **existing** KINAN Shop API
(`src/server.js`); PostgreSQL / the Node API stay the source of truth for products, sellers, prices,
delivery, payments and orders. This folder is isolated: the Render build (`npm install` / `npm start`
at the repository root) never touches it.

> Pilot only. Not approved for production or public stores. Synthetic data and Stripe **test mode** or
> the server's labelled MOCK payment only. Publishing builds, deploying or any real payment needs Ali's
> explicit approval.

## SDK

| Tool | Version |
|---|---|
| Flutter | **3.50.1 stable** (`ae9b586f34a8443573f82ef57c3bf914a908cbf7`) |
| Dart | 3.13 (bundled with Flutter 3.50.1) |
| flutter_stripe | ^15.0.0 · flutter_secure_storage ^10.0.0 · shared_preferences ^2.5.0 · http ^1.5.0 |
| Android | minSdk 24 (Flutter default), compileSdk 36, `FlutterFragmentActivity`, AppCompat theme |
| iOS | 13.0+ (Stripe requirement); Xcode on macOS |

## Run it

```bash
# 1) Backend: local staging API with synthetic fixtures (repository root, Node 22)
npm run pilot:staging              # MOCK payments (no Stripe keys)
# or Stripe TEST mode (test keys only — the script refuses live keys):
STRIPE_SECRET_KEY=sk_test_… STRIPE_PUBLISHABLE_KEY=pk_test_… STRIPE_WEBHOOK_SECRET=whsec_… npm run pilot:staging
#   for webhooks in test mode: stripe listen --forward-to localhost:3999/webhooks/stripe

# 2) App (apps/shop-mobile)
cd apps/shop-mobile
./tool/setup_platforms.sh          # once: flutter create (keeps committed android/ files) + flutter pub get
cp config/local.example.json config/local.json   # API_BASE_URL: 10.0.2.2 = the host from the Android emulator
flutter pub get
flutter analyze
flutter test
flutter run --dart-define-from-file=config/local.json          # Android emulator / device
flutter build apk --debug --dart-define-from-file=config/local.json   # internal test APK (HTTP allowed in debug only)
```

For a real phone use the computer's LAN IP in `config/local.json`. A **release** APK only talks HTTPS, so
build it against an HTTPS staging URL (`config/staging.json`, `APP_ENV=staging`). `APP_ENV=production`
is refused at start-up.

## Configuration

| Name | Where | Notes |
|---|---|---|
| `API_BASE_URL` | `--dart-define-from-file` | Shop API origin, no trailing slash |
| `APP_ENV` | `--dart-define-from-file` | `local` / `staging` (shown in the pilot banner) |
| Stripe publishable key | read at run time from `GET /api/config/public` | only `pk_test_…` is used |
| Server keys (`STRIPE_SECRET_KEY`, webhook secret, DB) | server environment only | never in the app |

## Fixtures (`npm run pilot:staging`)

| Account | Login | Use |
|---|---|---|
| Buyer | `buyer@pilot.test` / `pilot-buyer-1` | app sign-in |
| Seller A | `seller-a@pilot.test` / `pilot-seller-1` | `/seller` — Desk Lamp, Mug, Heater |
| Seller B | `seller-b@pilot.test` / `pilot-seller-1` | `/seller` — Vase |
| Warehouse | `warehouse@pilot.test` / `pilot-warehouse-1` | `/warehouse` — ship with tracking |
| Admin | `admin@pilot.test` / `pilot-admin-1` | `/admin` — mark manual purchase bought |

`Pilot Desk Lamp / Blue` is out of stock. `Pilot Heater (not for Malta)` is hidden for **MT**, listed for
**SA**, and refused at checkout to MT. 28 products give two catalog pages.

## What the app does

1. **Destination + language** — supported countries from `/api/config/public`; Arabic (RTL) or English (LTR).
2. **Catalog** — `GET /api/catalog?country=&limit=20&offset=` with paging, search, loading, empty and retry states.
3. **Product** — images, variants, stock, price + currency; only an in-stock variant deliverable to the destination can be added.
4. **Cart** — add/remove/quantity; on open and whenever the destination changes it re-reads `GET /api/catalog/many` and `POST /api/shipping/quote`, flags price changes (old price struck through), sold-out and undeliverable lines, and blocks checkout until they are removed.
5. **Checkout** — buyer sign-in (`POST /api/auth/login`, `app: "shop"`, token in Keychain/Keystore), address, then `POST /api/buyer/checkout` with a persisted `Idempotency-Key`. The order screen shows the **server** total and currency; a difference from the cart estimate (price or currency) is shown before the pay button.
6. **Payment** — Stripe PaymentSheet with the server client secret, or the server's MOCK `/demo-pay` (labelled everywhere). The app never marks an order paid itself: it polls `GET /api/buyer/orders/:id` and re-reads it when the app resumes. Cancel → order kept, “Try payment again”; failure → reason + retry; or cancel the order.
7. **Orders** — list and detail with status, tracking (`tracking`, `direct[].tracking`) and history.

### Checkout recovery
`lib/src/checkout/checkout_attempt.dart`: one key per logical attempt, saved with the exact request bytes
**before** sending. Timeout / dropped connection / 5xx / restart → the same key and bytes are re-sent (on
start-up, on opening checkout, or on Retry) and the server returns the same order and the same
PaymentIntent. A changed basket first resolves the uncertain attempt, shows that order, and only then gets
a new key. 400/404/409/422 clear the attempt (nothing was created); 401/403/429 never do.

## Tests

| Where | What | Status in this hand-off |
|---|---|---|
| `test/mobile-pilot.test.js` (repo root, `npm test`) | API acceptance criteria end to end: country eligibility, price/stock change before payment, lost response + restart = 1 order + 1 PaymentIntent, payment pending until webhook, cancel/failure, seller isolation, fulfilment step + tracking in the buyer view | **ran, passing** |
| `apps/shop-mobile/test/*.dart` | models vs real response fixtures, checkout recovery logic, cart revalidation, money formatting, RTL/LTR widget test | **written, not yet run** (see Known gaps) |

## API contract notes (verified at `4653259`)

* Amounts are numbers; `currency` is lower case (`"usd"`) → shown upper case. Orders may be charged in EUR/GBP: `GET /api/buyer/orders/:id` already returns amounts in the charge currency.
* `POST /api/shipping/quote` has no currency field; its `fee` is in the base `currency` of `/api/config/public`.
* Images are relative (`/img/l/…`) and resolved against `API_BASE_URL`.
* Backend change made for the pilot (backward compatible): checkout refuses an item the catalog hides for that country; the quote lists such items as `undeliverable`. See `docs/API.md`.

## Known gaps

* **Flutter was not run in the authoring environment** (no Dart/Flutter SDK download, pub.dev blocked). `flutter analyze`, `flutter test`, a device run, screenshots and the APK must be done on a machine with Flutter 3.50.1. Fix anything the analyzer reports before the pilot.
* **Seller-side fulfilment:** the existing Seller web interface has no fulfilment action for KINAN-fulfilled (manual / warehouse) orders; sellers see status only. Fulfilment steps are made by admin (manual purchase bought) and warehouse staff (ship + tracking). Adding a seller fulfilment action is a product decision for Ali.
* Stripe `returnURL` / URL scheme for redirect payment methods is not configured (cards incl. 3-D Secure test cards work in-sheet). Apple Pay / Google Pay not enabled.
* Country names come from the API in English only (also in the Arabic UI).
* Signing out deletes a still-uncertain checkout attempt on this phone; the order (if created) remains visible in “My orders”.
* No push notifications in the pilot (the API supports Expo tokens; the Flutter app would need FCM/APNs work).

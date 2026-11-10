# Kinan — multi-seller marketplace powered by Taobao

**Owner:** Ali Almadhoun Mohammed Kinan · © 2026, all rights reserved. Proprietary software — see [LICENSE](LICENSE). Not open source.

One server powers four interfaces, all in English and installable on phones as apps (PWA):

| Interface | User | Status |
|---|---|---|
| Kinan Shop `/` | Customers: browse all shops, search and filter, one cart across sellers, pay (card or wallet), 6-stage tracking, wallet, item requests | Built |
| Seller Center `/seller` | Merchants: connect Taobao, import and edit products, pay purchase orders, earnings | Built |
| Admin dashboard `/admin` | You | Built |
| Warehouse site `/warehouse` | China warehouse staff | Built |

Each site is a responsive web app with its own manifest and icon, so it can be added to a phone's home screen and runs full-screen like a native app. Native store builds (App Store / Google Play) can be added later on the same API (`docs/API.md`).

```bash
cp .env.example .env   # fill in the values
npm test               # end-to-end test of the full flow
npm start
```
No dependencies. Node.js 18 or newer.

## How it works

1. A **seller** signs up, you approve them in the admin dashboard, and they connect **their own** Distribution Platform account.
2. In the seller app they paste a Taobao link and set a sale price; the product is submitted **for review**.
3. **You approve or reject it in the admin dashboard** (you see cost and margin per variant). Only approved products appear in the buyer app.
4. A **buyer** orders and pays the platform via Stripe.
5. The server creates a Taobao purchase order **with the seller's account**, channel `PANAMA_DG`, shipped to your warehouse.
6. The seller pays Taobao from their app (or automatically if `auto_pay` is on).
7. When Taobao ships, parcels appear as "Expected" in the warehouse. Staff scan the tracking number, inspect, and shelve.
8. When all parcels arrive, the order becomes "Ready to ship"; it is shipped internationally and the buyer sees the tracking number.
9. After delivery, the seller's net (price minus your commission) becomes payable.

## What the system protects

- The buyer's address never reaches the Taobao merchant or the seller; they only see the warehouse address.
- Buyers never see cost or Taobao IDs.
- Photos of `WITHOUT_MATERIAL` items are never copied; sellers upload their own.
- Taobao and Stripe message signatures are verified on the raw body.
- No duplicate orders: `outer_purchase_id` is saved before the API call.
- Passwords hashed with scrypt; Bearer sessions for apps, HttpOnly cookies for the sites; sign-in attempts are rate-limited.

## Kinan Shop ↔ Seller Center ↔ Admin
- **Seller Center → Shop:** the seller's logo, description and return policy (Settings) appear on their shop page and products. Only products the admin approved are shown.
- **Admin → Shop:** wallet credits/deductions (Users → Adjust) appear in the customer's wallet with the reason; replies and prices for item requests (Item requests tab) appear on the customer's request page.
- **Shop → Admin:** new item requests raise an alert on the Overview.
- Wallet refunds: orders paid from the wallet are refunded to the wallet when cancelled.

## Before production

- **Database:** `src/db.js` stores JSON files and is only suitable for testing. Move to PostgreSQL before launch.
- **Seller payouts:** the ledger calculates what each seller is owed, but actual transfers need **Stripe Connect** (one account per merchant).
- **Taobao field names:** some aren't documented in the guides provided; they're all in `src/taobao/apis.js`, marked VERIFY.
- **After-sales (refunds/returns):** not built yet. The endpoints are listed in the Taobao manual §6.1.4.
- **Authorization policy:** your app type must allow multiple users to authorize it ("Allow logged-in users"); check the maximum number of sellers allowed.
- **HTTPS certificate:** OV or EV for the Taobao message webhook URL.

## Native store apps (optional)
API reference in `docs/API.md`. Suggested stack: React Native (Expo) with the Stripe React Native SDK, built with EAS Build. The web apps already cover phones via "Add to Home Screen".

## Card payments on the store
Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PUBLISHABLE_KEY`. Without them the store runs in test mode with a "Pay (test)" button.

## Legal pages
`/terms` (buyers), `/seller-terms`, `/privacy`, `/legal` (legal notice). They are filled from these settings, so update them once the company is registered:

| Variable | Example |
|---|---|
| `OPERATOR_NAME` | `Ali Almadhoun Mohammed Kinan` (later the company name) |
| `TRADING_NAME` | `Kinan` |
| `OPERATOR_COUNTRY` | `Malta` |
| `OPERATOR_ADDRESS` | Business address (required before public launch) |
| `COMPANY_NUMBER`, `VAT_NUMBER` | After registration |
| `CONTACT_EMAIL` | Public support / legal contact address |

## Ownership
Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved. See `LICENSE` and `NOTICE`.

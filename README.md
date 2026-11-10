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

## Sign in with Google
Customers (Kinan Shop) and sellers (Seller Center) can tap **Continue with Google**. The button appears once these are set:

1. Google Cloud Console → APIs & Services → **OAuth consent screen**: app name *Kinan*, support email, scopes `email`, `profile`, `openid`; publish the app.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI: `PUBLIC_BASE_URL/auth/google/callback` (e.g. `https://kinan-17ma.onrender.com/auth/google/callback`).
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server.

A Google account with the same email as an existing customer or seller is linked to it. New Google sellers start as *pending* until you approve them. The admin dashboard accepts Google only for addresses in `ADMIN_EMAIL` or `ADMIN_GOOGLE_EMAILS` (comma-separated); everyone else is refused. Warehouse staff use email and password.

## AliExpress (second source, ships direct)
Sellers can add products from **Taobao** (→ China warehouse → customer) or **AliExpress** (→ straight to the customer). One cart can mix both; the customer sees two deliveries.

- **Manual mode (default):** sellers add AliExpress products by hand. When one sells, the admin order shows *Open on AliExpress* and the customer's address to copy; you order it, then enter the AliExpress order number, the tracking number, and finally *Mark delivered*.
- **API mode:** set `ALIEXPRESS_APP_KEY` / `ALIEXPRESS_APP_SECRET` (an approved app on openservice.aliexpress.com with the Dropshipping APIs; callback `PUBLIC_BASE_URL/oauth/aliexpress/callback`), then *Connect AliExpress account* on the admin Overview. Sellers can then import by link, and paid orders are placed with the customer's address automatically (`aliexpress.ds.order.create`); status and tracking sync every few minutes. You still pay each order in your AliExpress account. API names are in `src/aliexpress/client.js`, marked VERIFY.
- Earnings: for items Kinan buys itself (AliExpress, manual Taobao), the purchase cost is deducted from the seller's earnings with the commission.

## Kinan Shop ↔ Seller Center ↔ Admin
- **Seller Center → Shop:** the seller's logo, description and return policy (Settings) appear on their shop page and products. Only products the admin approved are shown.
- **Admin → Shop:** wallet credits/deductions (Users → Adjust) appear in the customer's wallet with the reason; replies and prices for item requests (Item requests tab) appear on the customer's request page.
- **Shop → Admin:** new item requests raise an alert on the Overview.
- Wallet refunds: orders paid from the wallet are refunded to the wallet when cancelled.

## Data, email and money

- **Database:** set `DATABASE_URL` and everything is stored in PostgreSQL (table `kinan_docs`; loaded at start-up, written in the background). Without it, data is kept in JSON files in `DATA_DIR`, which is lost on every Render restart.
- **Photos:** uploaded product photos and shop logos are served as cacheable links (`/img/...`) instead of being sent inside every page.
- **Email:** with `BREVO_API_KEY` + `MAIL_FROM` customers get order, shipping and delivery emails, sellers get new-order, approval and payout emails, and everyone can reset their password. Without it, emails are logged (Admin → API `/api/admin/mail`) and the admin can create reset links from **Users → Reset link**.
- **Withdrawals:** sellers request a withdrawal (IBAN, Wise or PayPal) from Earnings; the admin pays it by hand and records it in **Withdrawals**.
- **Returns:** customers request a return within `RETURN_DAYS` of delivery; the admin approves, rejects or refunds (wallet or card) in **Returns**, optionally charging the seller.
- **Shipping:** priced by weight and destination zone (Admin → **Shipping**). AliExpress items are not charged. When the warehouse ships with the real weight, overpayments are credited to the customer's wallet; underpayments become an amount due on the order.
- **Categories:** sellers choose a category; Kinan Shop can be browsed by category.
- **Arabic:** Kinan Shop, Kinan Seller, the download and reset pages switch between English and Arabic (right-to-left) with the language button; Arabic phones start in Arabic.

## Before production

- **Database:** set `DATABASE_URL` (PostgreSQL). The free Render database expires after 30 days — upgrade it before then.
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

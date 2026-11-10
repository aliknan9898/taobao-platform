# Taobao multi-seller dropshipping marketplace

One server powers four interfaces:

| Interface | User | Status |
|---|---|---|
| Admin dashboard `/admin` | You | Built and tested |
| Warehouse site `/warehouse` | China warehouse staff | Built and tested |
| Buyer app (Android/iOS) | Customers | API ready — the app itself is not built yet |
| Seller app (Android/iOS) | Merchants | API ready — the app itself is not built yet |

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

## Before production

- **Database:** `src/db.js` stores JSON files and is only suitable for testing. Move to PostgreSQL before launch.
- **Seller payouts:** the ledger calculates what each seller is owed, but actual transfers need **Stripe Connect** (one account per merchant).
- **Taobao field names:** some aren't documented in the guides provided; they're all in `src/taobao/apis.js`, marked VERIFY.
- **After-sales (refunds/returns):** not built yet. The endpoints are listed in the Taobao manual §6.1.4.
- **Authorization policy:** your app type must allow multiple users to authorize it ("Allow logged-in users"); check the maximum number of sellers allowed.
- **HTTPS certificate:** OV or EV for the Taobao message webhook URL.

## Native apps
API reference in `docs/API.md`. Suggested stack: React Native (Expo) with the Stripe React Native SDK, built with EAS Build.

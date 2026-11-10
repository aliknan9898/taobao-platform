# API for the native apps (Buyer and Seller)

- Base URL: `https://YOUR-DOMAIN`
- All requests and responses are JSON.
- After sign-in, send the token on every request: `Authorization: Bearer <token>`
- Errors: `{ "error": "message" }` with an HTTP status (400 / 401 / 403 / 404 / 409 / 422 / 429 / 502).

## Shared

| Method | Path | Body / response |
|---|---|---|
| POST | `/api/auth/register` | `{role:"buyer"|"seller", email, password, name, shop_name?}` |
| POST | `/api/auth/login` | `{email, password}` → `{token, user}` |
| POST | `/api/auth/logout` | — |
| GET | `/api/me` | Current user |
| GET | `/api/config/public` | `{currency, shipping_flat, payments:"stripe"|"demo"}` |

## Buyer app

| Method | Path | Notes |
|---|---|---|
| GET | `/api/catalog?q=&seller_id=&limit=&offset=` | No sign-in needed. Only admin-approved products appear |
| GET | `/api/catalog/:id` | Product details and variants (`skus[].mp_sku_id`, `price`, `in_stock`) |
| POST | `/api/buyer/checkout` | `{items:[{listing_id, mp_sku_id, qty}], shipping_address:{name, phone, country, city, line1, line2?, postal_code?}}` |
| GET | `/api/buyer/orders` | Order list |
| GET | `/api/buyer/orders/:id` | Includes `tracking` once shipped internationally |
| POST | `/api/buyer/orders/:id/cancel` | Only before purchasing starts |
| POST | `/api/buyer/orders/:id/demo-pay` | Demo mode only |

**Stripe payment:** the `checkout` response contains `payment.client_secret`. Pass it to the Stripe Mobile SDK (`PaymentSheet`). Do not treat the order as paid based on the app result; the server confirms payment via the Stripe webhook. Then read `/api/buyer/orders/:id`.

Order statuses: `pending_payment` → `paid` → `procuring` → `awaiting_parcels` → `ready_to_ship` → `shipped` → `delivered` (or `cancelled` / `refunded` / `attention`). A human-readable label is in `status_label`.

## Seller app

| Method | Path | Notes |
|---|---|---|
| GET | `/api/seller/me` | Shop and Taobao connection status (`taobao.connected`, `needs_reauth_soon`) |
| PATCH | `/api/seller/me` | `{shop_name?, default_markup_pct?, auto_pay?}` |
| GET | `/api/seller/taobao/connect?return_to=myapp://taobao-connected` | → `{url}`. Open it in the system browser (ASWebAuthenticationSession / Custom Tabs). After connecting, the user is redirected to `return_to` |
| POST | `/api/seller/products/preview` | `{link}` → product with `skus[].cost_cny` and `suggested_price` |
| POST | `/api/seller/products` | `{link, prices:{mp_sku_id: price}, title?, own_images?, images_rights_confirmed?}` — submits for admin review |
| GET | `/api/seller/products` | My products (with `status` and `review`) |
| PATCH | `/api/seller/products/:id` | `{status:"active"|"paused", prices?}` |
| POST | `/api/seller/products/:id/resync` | Refresh cost and stock from Taobao |
| GET | `/api/seller/orders` | My orders (no buyer address) with `purchase.status` and `pay_deadline` |
| POST | `/api/seller/orders/:id/pay` | Submit payment to Taobao from the seller's account |
| POST | `/api/seller/orders/:id/sync` | Refresh status |
| GET | `/api/seller/earnings` | `{pending, payable, paid, entries}` |

**Admin approval (mandatory):** every product a seller imports starts as `pending_review` and does not appear in the buyer app until you approve it in the admin dashboard.

| `status` | Meaning in the seller app |
|---|---|
| `pending_review` | Awaiting admin approval |
| `active` | Live for buyers |
| `paused` | Paused by the seller (can switch back to `active` without new approval) |
| `rejected` | Rejected — reason in `review.reason`; the seller can edit and resubmit |
| `unavailable` | No longer available on Taobao |

Price changes don't need re-approval. Changing the title or photos sends the product back to `pending_review`. A seller trying to activate an unapproved product gets 409.

**Compliance note:** products with `item_type = WITHOUT_MATERIAL` come without photos. Never show Taobao photos for them; let the seller upload their own (`own_images`) and confirm they own the rights.

## Seller deep link
Register a URL scheme in the app (e.g. `myseller://`) and pass it as `return_to`. The server accepts any custom scheme and rejects `javascript:` and `data:`.


## Kinan Shop additions
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/shops` | public | Active shops with at least one live product |
| GET | `/api/shops/:id` | public | One shop, incl. `return_policy` |
| GET | `/api/catalog?sort=new\|price_asc\|price_desc&min_price=&max_price=&seller_id=&q=` | public | Filters and sorting |
| GET | `/api/buyer/wallet` | buyer | `{ balance, entries[] }` |
| POST | `/api/buyer/orders/:id/pay-wallet` | buyer | Pays the whole order from the wallet |
| GET/POST | `/api/buyer/requests` | buyer | `{ link, note, qty }` — request a Taobao item that isn't listed |
| PATCH | `/api/seller/me` | seller | Also accepts `logo` (data URL ≤ 200 KB), `description`, `return_policy` |
| GET/POST | `/api/admin/wallet/:userId` | admin | POST `{ amount, reason }` — negative to deduct |
| GET | `/api/admin/requests` · PATCH `/api/admin/requests/:id` | admin | `{ status: new\|quoted\|listed\|declined, reply, quote, listing_id }` |

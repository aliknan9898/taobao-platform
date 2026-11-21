# KINAN UI/UX rollout: screen map and stages

Source: the owner's design handoff (`START-HERE-CLAUDE.md` and `KINAN-Interface-Preview.html`, 21 Nov 2026).
The preview's records, numbers and photos are layout material only. Every shipped screen uses the existing
read models, roles and permission checks.

## Stage 1: brand (this branch)

- The KINAN bag artwork replaces the old K mark. The seller apps use the purple version, and every other app uses the emerald version (`public/assets/logo-*.png`, `favicon*-48.png`, PWA icons).
- The product name is live text beside the artwork (`K.brand`): `KINAN.shop` in the shop and `KINAN` + area name elsewhere. It is marked `dir="ltr"` so it stays upright in Arabic.
- Colour tokens:

  | App | Primary | Light accent | Navigation |
  |---|---|---|---|
  | Shop | #036747 | #E8F3EC | White |
  | Seller | #4B319B | #EEE9FB | #2B2050 (sidebar) |
  | Admin | #036747 | #E7F2EC | #172E26 (top bar) |
  | Warehouse | #205F70 | #E1EFF1 | #1A3740 (top bar) |

- Gold is `#FFBD00`, Stripe Elements uses the shop primary, and the manifest `theme_color` is set per app.
- The service worker cache is bumped to `kinan-v4` so installed apps pick up the new artwork.
- Fonts are unchanged (Instrument Sans / Bricolage / project Arabic family). The handoff allows the project fonts, and Inter and Noto Sans Arabic would need self-hosted files added later.

## Existing screens mapped to the handoff

| Handoff area | Exists today | Main gaps |
|---|---|---|
| Shop: home, collections, search, product detail | `/`, `#/c`, `#/search`, `#/p`, `#/s` (shop page), `#/deals` | Serif English hero headline, editorial home layout |
| Shop: bag, checkout, confirmation | `#/cart`, `#/checkout`, `#/pay` | Full cost breakdown (taxes, fees, delivery range) shown together before payment |
| Shop: account, tracking, returns, support | `#/account`, `#/orders` (journey bar), returns in order detail, `#/wallet`, `#/giftcards`, `#/request` | Public "Track order" by order reference with a verification step |
| Seller: overview, catalog, editor, orders, settlements, settings | `#/` dashboard, `#/products`, `#/add`, `#/edit`, `#/orders`, `#/earnings`, `#/settings`, `#/ebay`, KYC | "Needs attention" queue panel, per-variant stock view, payout timeline (expected vs settled) |
| Admin: overview, catalog moderation, sellers, orders, suppliers/jobs, finance, audit | Overview, Product Review, Sellers, Orders, Shipping, Returns, CJ/Live Imports/Integrations, Withdrawals, Backup & Data, `/api/admin/audit` | Single exceptions queue with staff assignment; supplier/job surface filtered by provider and result with retry eligibility; Arabic UI |
| Warehouse: receive, inspection, photos, consolidation, packing, labels, dispatch | Receive (scan + location + weight + QC), Expected / In stock / Orders / Shipments | Step-by-step pack and dispatch flow, duplicate-scan readback, explicit weight units on every field; Arabic UI |
| Shared | Sign-in, theme toggle, empty states, Arabic RTL in shop and seller | Admin and warehouse are English-only; stale and partial-failure states are not uniform |

## Gaps closed on this branch (21 Nov 2026)

| Gap | What shipped | Where |
|---|---|---|
| Public tracking by reference | `#/track`: order reference + email, one answer for every mismatch, counted against the per-IP sign-in limit, no address/amount/supplier/internal ids | `src/services/publicTrack.js`, `POST /api/track`, `public/shop.html` |
| Full cost before payment | Destination, currency, delivery range, subtotal, shipping, EU import duty and a taxes note together in the order summary | `public/shop.html` checkout |
| Seller queues and payouts | Needs-attention list on the dashboard; four payout stages on Earnings | `public/seller.html` |
| Admin exceptions | One queue with area/provider/result/assignee filters, assignment and notes, retry only where `procure` can redo the purchase | `src/services/exceptions.js`, `/api/admin/exceptions`, admin "Exceptions" |
| Warehouse scanning | Duplicate scan never overwrites; readback with next step; grams validated 1–70000; pack steps per order | `src/services/warehouse.js`, `public/warehouse.html` |
| Arabic for staff apps | Admin and warehouse offer English/Arabic only (`data-langs`), RTL, translated shell, navigation, overview, exceptions and the whole warehouse | `public/assets/i18n-staff.js`, `KinanLang.add` |

Still open: Arabic for the deeper admin sections (catalog tools, integrations, reports), the editorial shop home (hero and serif headline), and self-hosted Inter / Noto Sans Arabic files.

## Next stages (each one is a separate PR and needs owner approval)

1. Editorial shop home: hero, featured grid, serif English headline.
2. Arabic for the deeper admin sections (catalog tools, integrations, reports).
3. Self-hosted Inter / Noto Sans Arabic, if the owner wants the handoff fonts instead of the current ones.

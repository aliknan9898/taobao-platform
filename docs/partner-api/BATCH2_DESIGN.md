# Partner API Batch 2 — quotes, orders, idempotency, reservations and outbox

> **Status:** implemented in the sandbox (see `STATUS.md`). The design below is kept as the reference. Differences from it:
> - The quote stores costs per line.
> - Shipping and handling are priced per origin.
> - `partner_fulfillment_intent` was added as its own table.
> - Overrides of the 30% check are not built yet: quotes under the target are refused.

Goal: `POST /quotes` and `POST /orders` with exactly-once order creation across retries, restarts and two processes,
stock reservations for stock KINAN controls, a durable outbox for later webhooks, and per-quote enforcement of the
30% B2B contribution target. Settlement stays simulated in the sandbox. **Nothing here touches production without owner approval.**

## Why real SQL tables

The existing document store keeps collections in memory and writes behind to PostgreSQL in batches. This cannot:
- guarantee uniqueness across processes
- hold a row lock
- make "order + idempotency record + reservation + outbox event" one atomic unit

Batch 2 therefore adds dedicated PostgreSQL tables and talks to them with `db.pgPool()` in explicit transactions.
External calls (suppliers, carriers, Stripe) never run inside a SQL transaction.

## Tables (migration `001_partner_core.sql`, additive only)

```sql
CREATE TABLE partner_quote (
  id            text PRIMARY KEY,                 -- pq_…
  env           text NOT NULL CHECK (env IN ('sandbox','live')),
  store_id      text NOT NULL,
  price_list_version int NOT NULL,
  currency      char(3) NOT NULL,
  dest_country  char(2) NOT NULL,
  dest_postal   text NOT NULL,                    -- normalised
  lines         jsonb NOT NULL,                   -- [{variant_id, qty, unit_ex_tax_minor, cost_minor}]
  totals        jsonb NOT NULL,                   -- items, shipping, duties, handling, tax, payable (minor units)
  charges       jsonb NOT NULL,                   -- who pays each charge and where it is visible
  contribution_minor bigint NOT NULL,
  margin_bp     int NOT NULL,                     -- basis points, >= target unless override_id
  override_id   text,                             -- audited exception with expiry
  expires_at    timestamptz NOT NULL,             -- default now() + 15 min (owner-configurable)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_order (
  id                 text PRIMARY KEY,            -- po_…
  env                text NOT NULL,
  store_id           text NOT NULL,
  external_order_ref text NOT NULL,
  quote_id           text NOT NULL REFERENCES partner_quote(id),
  commercial         jsonb NOT NULL,              -- immutable copy of the accepted quote
  ship_to            jsonb NOT NULL,              -- minimum recipient fields, encrypted at rest (AES-GCM, key from env)
  payment_state      text NOT NULL DEFAULT 'pending',
  fulfillment_state  text NOT NULL DEFAULT 'received',
  version            int  NOT NULL DEFAULT 1,
  kinan_order_id     text,                        -- link to the existing orders collection once fulfilment starts
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (env, store_id, external_order_ref)      -- second line of defence against duplicates under a new key
);

CREATE TABLE partner_idempotency (
  env text NOT NULL, store_id text NOT NULL, operation text NOT NULL, key text NOT NULL,
  request_hash text NOT NULL,                     -- SHA-256 of the canonical JSON body
  status int, response jsonb, resource_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, store_id, operation, key)
);                                                -- retention: 30 days (documented), purge job

CREATE TABLE partner_stock (
  env text NOT NULL, variant_id text NOT NULL,
  on_hand int NOT NULL CHECK (on_hand >= 0),
  reserved int NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  PRIMARY KEY (env, variant_id)
);                                                -- only stock KINAN controls (warehouse); supplier stock is not reserved here

CREATE TABLE partner_reservation (
  id text PRIMARY KEY, order_id text NOT NULL REFERENCES partner_order(id),
  variant_id text NOT NULL, qty int NOT NULL CHECK (qty > 0),
  state text NOT NULL CHECK (state IN ('reserved','committed','released')),
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_outbox (
  id bigserial PRIMARY KEY, env text NOT NULL, store_id text NOT NULL,
  event_id text NOT NULL UNIQUE, type text NOT NULL, resource_id text NOT NULL, resource_version int NOT NULL,
  payload jsonb NOT NULL,                         -- never end-customer address or contact data
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz
);

CREATE TABLE partner_order_history (
  order_id text NOT NULL REFERENCES partner_order(id), at timestamptz NOT NULL DEFAULT now(),
  field text NOT NULL, from_state text, to_state text NOT NULL, reason_code text, actor text
);
```

Rollback for the code: deploy the previous commit. The routes disappear and the tables stay untouched.
Rollback for the data: the migration only adds tables. `DROP TABLE` is listed in `001_partner_core.down.sql` and is run
only by the owner after checking that there are no live rows.

## `POST /quotes`

1. Authorise `quotes:write`. Validate the currency (EUR), the destination (an entitled market plus a postcode) and the lines (entitled, available, `qty ≥ MOQ`).
2. Price each line from the store's price-list version and cost each line from the KINAN cost.
3. Shipping, duties and handling come from `landed.js` / `shipping.js` for the ship-from location. If a necessary charge is unknown, answer `422 BASKET_NOT_ELIGIBLE`. KINAN never guesses.
4. Contribution = net revenue − KINAN costs − fees.
   - If the margin is below the target (30% by default), raise the line prices to the floor, rounded up.
   - The only exception is an audited override with an expiry.
5. Insert `partner_quote` and return `201` with the expiry. **A quote does not reserve stock.**

## `POST /orders` — one transaction

Header `Idempotency-Key` is required. Canonical body hash = SHA-256 of the JSON with sorted keys.

```
BEGIN;
  INSERT INTO partner_idempotency (env, store_id, 'orders.create', key, hash) ON CONFLICT DO NOTHING RETURNING *;
  -- conflict: SELECT … FOR UPDATE; same hash → return the stored response; other hash → 409 IDEMPOTENCY_CONFLICT
  SELECT * FROM partner_quote WHERE id = $quote AND store_id = $store FOR SHARE;
  -- expired → 409 QUOTE_EXPIRED; country/postcode/currency differ → 409 QUOTE_MISMATCH
  INSERT INTO partner_order (...) ;  -- unique (env, store, external_order_ref) → 409 ORDER_REFERENCE_CONFLICT
  UPDATE partner_stock SET reserved = reserved + $qty
    WHERE env = $env AND variant_id = $v AND on_hand - reserved >= $qty;   -- per controlled line
  -- 0 rows → ROLLBACK, 409 STOCK_CHANGED
  INSERT INTO partner_reservation (... 'reserved', expires_at = now() + interval '30 min');
  INSERT INTO partner_outbox (event 'order.updated', version 1);
  UPDATE partner_idempotency SET status = 201, response = $body, resource_id = $order;
COMMIT;
```

- **Exactly once:**
  - Two processes or retries with the same key serialise on the idempotency primary key.
  - A retry under a new key hits the unique external reference.
  - A crash before COMMIT leaves nothing behind. A crash after COMMIT returns the stored response on retry.
- **Fulfilment intent:**
  - A worker reads orders with `payment_state IN ('settled','approved_terms')` and `kinan_order_id IS NULL` using `FOR UPDATE SKIP LOCKED`.
  - It creates the internal fulfilment order with an idempotent bridge (deterministic id `ord_` + hash of the partner order id), then sets `kinan_order_id` in the same transaction.
  - If the supplier submission result is uncertain, reconcile with the supplier before any replay.
- **Payment and settlement:**
  - Sandbox: a test endpoint or admin action moves the order to `settled`.
  - Live: by invoice or bank transfer under the B2B agreement, recorded by finance (owner decision).
- **States:**
  - Payment and fulfilment are independent columns with a transition table, and every change goes into `partner_order_history`.
  - Cancellation and return requests are their own resources (Batch 3).
- **Reservations:** released on cancellation or timeout by a sweep (`FOR UPDATE SKIP LOCKED`). Committed when the warehouse packs.

## Outbox and webhooks (Batch 3)

- A dispatcher reads `partner_outbox` in id order per store and signs `t=timestamp.body` with HMAC-SHA256 (header `KINAN-Signature: t=…,v1=…`).
- Retries use exponential backoff with jitter. After 24 h an event goes to a dead-letter list with manual replay (same `event_id`).
- Callback destinations: HTTPS only, verified by a challenge, and private address ranges are blocked.
- Polling the order and changes endpoints remains the source of truth.

## Tests required before proposing a merge

- Real isolated PostgreSQL 16, as already used for the advisory-lock test.
- Two Node processes sending the same order 50 times concurrently must produce exactly one order, one reservation and one fulfilment intent.
- A restart between COMMIT and the response must still produce one order.
- Each of these must return its specified error:
  - key reuse with a different body
  - an expired quote
  - a postcode mismatch
  - stock taken between quote and order
- Tax, fee and discount scenarios must reconcile, including the 30% floor and two ship-from cases (CN direct, EU warehouse).

## Owner decisions needed before Batch 2 goes beyond the sandbox

1. Which KINAN entity contracts and invoices the B2B sale (VAT registration, OSS/IOSS for imports).
2. Settlement terms: prepayment or credit terms, and the payment method.
3. Whether the 30% target is a floor on every quote or a portfolio target with documented exceptions. The default implementation is a per-quote floor.
4. Who handles duties, returns and customer support in the first market.
5. The first partner, its platform (Shopify or WooCommerce) and the first destination (proposed: DE).

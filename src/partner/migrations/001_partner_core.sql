-- Partner API Batch 2: quotes, orders, idempotency, controlled stock and reservations, outbox, history.
-- Additive only. Applied by src/partner/pg.js when PARTNER_ORDERS_ENABLED=1 (owner approval), under an advisory lock.
CREATE TABLE IF NOT EXISTS partner_quote (
  id                 text PRIMARY KEY,
  env                text NOT NULL CHECK (env IN ('sandbox','live')),
  store_id           text NOT NULL,
  price_list_version int  NOT NULL,
  currency           char(3) NOT NULL,
  dest_country       char(2) NOT NULL,
  dest_postal        text NOT NULL,
  lines              jsonb NOT NULL,
  totals             jsonb NOT NULL,
  charges            jsonb NOT NULL,
  contribution_minor bigint NOT NULL,
  margin_bp          int  NOT NULL,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_quote_store ON partner_quote (env, store_id, created_at);

CREATE TABLE IF NOT EXISTS partner_order (
  id                 text PRIMARY KEY,
  env                text NOT NULL CHECK (env IN ('sandbox','live')),
  store_id           text NOT NULL,
  external_order_ref text NOT NULL,
  quote_id           text NOT NULL REFERENCES partner_quote(id),
  commercial         jsonb NOT NULL,
  ship_to            jsonb NOT NULL,
  payment_state      text NOT NULL DEFAULT 'pending' CHECK (payment_state IN ('pending','approved_terms','settled','failed','partially_credited','credited')),
  fulfillment_state  text NOT NULL DEFAULT 'received' CHECK (fulfillment_state IN ('received','on_hold','confirmed','processing','partially_shipped','shipped','delivered','cancelled','exception')),
  version            int  NOT NULL DEFAULT 1,
  kinan_order_id     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (env, store_id, external_order_ref)
);
CREATE INDEX IF NOT EXISTS partner_order_store ON partner_order (env, store_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS partner_idempotency (
  env          text NOT NULL,
  store_id     text NOT NULL,
  operation    text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       int,
  response     jsonb,
  resource_id  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, store_id, operation, key)
);

CREATE TABLE IF NOT EXISTS partner_stock (
  env        text NOT NULL,
  variant_id text NOT NULL,
  on_hand    int  NOT NULL CHECK (on_hand >= 0),
  reserved   int  NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (reserved <= on_hand),
  PRIMARY KEY (env, variant_id)
);

CREATE TABLE IF NOT EXISTS partner_reservation (
  id         text PRIMARY KEY,
  env        text NOT NULL,
  order_id   text NOT NULL REFERENCES partner_order(id),
  variant_id text NOT NULL,
  qty        int  NOT NULL CHECK (qty > 0),
  state      text NOT NULL CHECK (state IN ('reserved','committed','released')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_reservation_open ON partner_reservation (env, state, expires_at);

CREATE TABLE IF NOT EXISTS partner_fulfillment_intent (
  order_id   text PRIMARY KEY REFERENCES partner_order(id),
  env        text NOT NULL,
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','submitted','done','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_outbox (
  id               bigserial PRIMARY KEY,
  env              text NOT NULL,
  store_id         text NOT NULL,
  event_id         text NOT NULL UNIQUE,
  type             text NOT NULL,
  resource_id      text NOT NULL,
  resource_version int  NOT NULL,
  payload          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz
);

CREATE TABLE IF NOT EXISTS partner_order_history (
  id          bigserial PRIMARY KEY,
  order_id    text NOT NULL REFERENCES partner_order(id),
  at          timestamptz NOT NULL DEFAULT now(),
  field       text NOT NULL,
  from_state  text,
  to_state    text NOT NULL,
  reason_code text,
  actor       text
);

CREATE TABLE IF NOT EXISTS partner_schema (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO partner_schema (version) VALUES (1) ON CONFLICT DO NOTHING;

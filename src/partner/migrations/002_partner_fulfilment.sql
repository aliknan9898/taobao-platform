-- Partner API Batch 3: fulfilment handoff, shipments, cancellations, returns (RMA), webhook endpoints and deliveries.
-- Additive only: new tables and new nullable columns. Applied with 001 under the same advisory lock.
ALTER TABLE partner_fulfillment_intent ADD COLUMN IF NOT EXISTS handoff_ref text;
ALTER TABLE partner_fulfillment_intent ADD COLUMN IF NOT EXISTS adapter text;
ALTER TABLE partner_fulfillment_intent ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE partner_fulfillment_intent ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE partner_fulfillment_intent ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS partner_fulfillment_handoff_ref ON partner_fulfillment_intent (handoff_ref) WHERE handoff_ref IS NOT NULL;
ALTER TABLE partner_order ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

CREATE TABLE IF NOT EXISTS partner_shipment (
  id              text PRIMARY KEY,
  env             text NOT NULL CHECK (env IN ('sandbox','live')),
  store_id        text NOT NULL,
  order_id        text NOT NULL REFERENCES partner_order(id),
  ship_from       text NOT NULL,
  carrier         text NOT NULL,
  service         text,
  tracking_number text NOT NULL,
  tracking_url    text,
  items           jsonb NOT NULL,
  state           text NOT NULL CHECK (state IN ('label_created','in_transit','out_for_delivery','delivered','exception','returned_to_sender')),
  events          jsonb NOT NULL DEFAULT '[]',
  version         int  NOT NULL DEFAULT 1,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, ship_from)
);
CREATE INDEX IF NOT EXISTS partner_shipment_order ON partner_shipment (order_id, created_at);

CREATE TABLE IF NOT EXISTS partner_cancellation (
  id              text PRIMARY KEY,
  env             text NOT NULL,
  store_id        text NOT NULL,
  order_id        text NOT NULL REFERENCES partner_order(id),
  state           text NOT NULL CHECK (state IN ('requested','accepted','rejected')),
  reason_code     text NOT NULL,
  note            text,
  decision_reason text,
  version         int  NOT NULL DEFAULT 1,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- at most one open or accepted cancellation per order
CREATE UNIQUE INDEX IF NOT EXISTS partner_cancellation_open ON partner_cancellation (order_id) WHERE state IN ('requested','accepted');

CREATE TABLE IF NOT EXISTS partner_return (
  id              text PRIMARY KEY,
  env             text NOT NULL,
  store_id        text NOT NULL,
  order_id        text NOT NULL REFERENCES partner_order(id),
  rma_number      text NOT NULL UNIQUE,
  state           text NOT NULL CHECK (state IN ('requested','approved','rejected','received','credited')),
  reason_code     text NOT NULL,
  items           jsonb NOT NULL,
  note            text,
  decision_reason text,
  instructions    jsonb,
  credit_minor    bigint NOT NULL DEFAULT 0,
  version         int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_return_order ON partner_return (order_id, created_at);

CREATE TABLE IF NOT EXISTS partner_webhook_endpoint (
  id              text PRIMARY KEY,
  env             text NOT NULL,
  store_id        text NOT NULL,
  url             text NOT NULL,
  events          jsonb NOT NULL,
  secret          jsonb NOT NULL,
  state           text NOT NULL CHECK (state IN ('pending_verification','active','disabled')),
  consecutive_failures int NOT NULL DEFAULT 0,
  disabled_reason text,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_webhook_endpoint_store ON partner_webhook_endpoint (env, store_id, state);

CREATE TABLE IF NOT EXISTS partner_webhook_delivery (
  id              bigserial PRIMARY KEY,
  env             text NOT NULL,
  store_id        text NOT NULL,
  endpoint_id     text NOT NULL REFERENCES partner_webhook_endpoint(id),
  outbox_id       bigint NOT NULL REFERENCES partner_outbox(id),
  event_id        text NOT NULL,
  state           text NOT NULL CHECK (state IN ('pending','delivered','dead')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  window_started_at timestamptz NOT NULL DEFAULT now(),   -- retries stop 24 h after this (reset on replay)
  lease_until     timestamptz,
  last_status     int,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, outbox_id)
);
CREATE INDEX IF NOT EXISTS partner_webhook_delivery_due ON partner_webhook_delivery (state, next_attempt_at);

INSERT INTO partner_schema (version) VALUES (2) ON CONFLICT DO NOTHING;

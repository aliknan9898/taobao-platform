-- Partner API Batch 4: platform connectors (Shopify first). Additive only. Applied with 001–002 under the same lock.
CREATE TABLE IF NOT EXISTS partner_connection (
  id              text PRIMARY KEY,
  env             text NOT NULL CHECK (env IN ('sandbox','live')),
  store_id        text NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('shopify')),
  shop_domain     text NOT NULL,
  state           text NOT NULL CHECK (state IN ('active','paused','auth_failed','uninstalled')),
  credentials     jsonb,                          -- sealed {access_token, refresh_token, expires_at, refresh_expires_at}; NULL after uninstall
  scopes          text,
  settings        jsonb NOT NULL,
  catalog_cursor  text,
  orders_since    timestamptz,
  last_sync_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, shop_domain)
);
CREATE INDEX IF NOT EXISTS partner_connection_store ON partner_connection (env, store_id);

CREATE TABLE IF NOT EXISTS partner_connection_oauth (
  state       text PRIMARY KEY,
  store_id    text NOT NULL,
  shop_domain text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_connection_product (
  connection_id       text NOT NULL REFERENCES partner_connection(id) ON DELETE CASCADE,
  product_id          text NOT NULL,
  external_product_id text NOT NULL,
  version             int  NOT NULL,
  status              text NOT NULL CHECK (status IN ('active','withdrawn')),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, product_id)
);

CREATE TABLE IF NOT EXISTS partner_connection_variant (
  connection_id       text NOT NULL REFERENCES partner_connection(id) ON DELETE CASCADE,
  variant_id          text NOT NULL,
  product_id          text NOT NULL,
  external_variant_id text NOT NULL,
  inventory_item_id   text NOT NULL,
  last_quantity       int,
  PRIMARY KEY (connection_id, variant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_connection_variant_ext ON partner_connection_variant (connection_id, external_variant_id);

CREATE TABLE IF NOT EXISTS partner_connection_order (
  connection_id     text NOT NULL REFERENCES partner_connection(id) ON DELETE CASCADE,
  external_order_id text NOT NULL,
  external_name     text,
  state             text NOT NULL CHECK (state IN ('importing','imported','skipped','failed','cancelled')),
  partner_order_id  text,
  reason            text,
  attempts          int  NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_order_id)
);
CREATE INDEX IF NOT EXISTS partner_connection_order_po ON partner_connection_order (partner_order_id);

CREATE TABLE IF NOT EXISTS partner_connection_fulfillment (
  connection_id           text NOT NULL REFERENCES partner_connection(id) ON DELETE CASCADE,
  shipment_id             text NOT NULL,
  external_fulfillment_id text,
  state                   text NOT NULL CHECK (state IN ('creating','done','failed')),
  attempts                int  NOT NULL DEFAULT 0,
  last_error              text,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, shipment_id)
);

-- Webhook deliveries already handled (Shopify can deliver the same webhook more than once).
CREATE TABLE IF NOT EXISTS partner_connection_webhook (
  webhook_id  text PRIMARY KEY,
  shop_domain text NOT NULL,
  topic       text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Privacy requests from the platform (customers/data_request, customers/redact) for KINAN staff to answer.
CREATE TABLE IF NOT EXISTS partner_connection_privacy (
  id          bigserial PRIMARY KEY,
  shop_domain text NOT NULL,
  topic       text NOT NULL,
  order_ids   jsonb NOT NULL DEFAULT '[]',
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open','done')),
  received_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO partner_schema (version) VALUES (3) ON CONFLICT DO NOTHING;

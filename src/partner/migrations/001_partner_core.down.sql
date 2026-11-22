-- Rollback for 001 (owner only, after confirming there are no live partner rows). Drops partner tables only.
-- Run 002_partner_fulfilment.down.sql first (its tables reference these).
DROP TABLE IF EXISTS partner_order_history, partner_outbox, partner_fulfillment_intent, partner_reservation,
  partner_stock, partner_idempotency, partner_order, partner_quote, partner_schema;

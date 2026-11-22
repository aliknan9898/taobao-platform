-- Rollback for 001 (owner only, after confirming there are no live partner rows). Drops partner tables only.
DROP TABLE IF EXISTS partner_order_history, partner_outbox, partner_fulfillment_intent, partner_reservation,
  partner_stock, partner_idempotency, partner_order, partner_quote, partner_schema;

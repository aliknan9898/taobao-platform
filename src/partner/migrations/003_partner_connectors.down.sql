-- Rollback for 003 (owner only). Drops connector tables only; run before 002 and 001.
DROP TABLE IF EXISTS partner_connection_privacy, partner_connection_webhook, partner_connection_fulfillment, partner_connection_order,
  partner_connection_variant, partner_connection_product, partner_connection_oauth, partner_connection;

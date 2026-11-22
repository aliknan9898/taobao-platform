-- Rollback for 002 (owner only, after confirming there are no live partner rows). Drops Batch 3 tables and columns only.
DROP TABLE IF EXISTS partner_webhook_delivery, partner_webhook_endpoint, partner_return, partner_cancellation, partner_shipment;
DROP INDEX IF EXISTS partner_fulfillment_handoff_ref;
ALTER TABLE IF EXISTS partner_fulfillment_intent DROP COLUMN IF EXISTS handoff_ref, DROP COLUMN IF EXISTS adapter, DROP COLUMN IF EXISTS attempts, DROP COLUMN IF EXISTS last_error, DROP COLUMN IF EXISTS updated_at;
ALTER TABLE IF EXISTS partner_order DROP COLUMN IF EXISTS delivered_at;

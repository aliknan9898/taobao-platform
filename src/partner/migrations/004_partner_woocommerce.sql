-- Partner API connectors: allow WooCommerce connections. Additive (the check constraint is widened, nothing else changes).
-- Re-run safely on every start: the constraint is dropped and re-created with the same definition.
ALTER TABLE partner_connection DROP CONSTRAINT IF EXISTS partner_connection_platform_check;
ALTER TABLE partner_connection ADD CONSTRAINT partner_connection_platform_check CHECK (platform IN ('shopify','woocommerce'));
INSERT INTO partner_schema (version) VALUES (4) ON CONFLICT DO NOTHING;

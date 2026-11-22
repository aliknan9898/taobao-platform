-- Rollback for 004 (owner only): remove WooCommerce connections, then narrow the platform check again. Run before 003.
DELETE FROM partner_connection WHERE platform = 'woocommerce';
ALTER TABLE IF EXISTS partner_connection DROP CONSTRAINT IF EXISTS partner_connection_platform_check;
ALTER TABLE IF EXISTS partner_connection ADD CONSTRAINT partner_connection_platform_check CHECK (platform IN ('shopify'));

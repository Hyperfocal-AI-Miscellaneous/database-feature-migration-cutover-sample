-- Migration 003: Add priority column for fulfillment tracking
-- Orders can be normal, high, or urgent priority

ALTER TABLE orders ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'normal';

-- Set high priority for large orders
UPDATE orders SET priority = 'high' WHERE quantity > 30;

INSERT INTO schema_migrations (version, name)
VALUES (3, '003_add_order_priority')
ON CONFLICT DO NOTHING;

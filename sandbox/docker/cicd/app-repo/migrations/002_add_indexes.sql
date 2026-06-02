-- Migration 002: Add performance indexes and discount column

CREATE INDEX IF NOT EXISTS idx_orders_item_id ON orders(item_id);
CREATE INDEX IF NOT EXISTS idx_items_value ON items(value);
CREATE INDEX IF NOT EXISTS idx_orders_customer_status_created ON orders(customer_id, status, created_at DESC);

-- Discount column for promotional pricing (default 0 = no discount)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (version, name)
VALUES (2, '002_add_indexes')
ON CONFLICT DO NOTHING;

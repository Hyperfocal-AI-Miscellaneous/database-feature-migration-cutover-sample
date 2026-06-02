-- Migration 003: Backfill promotional discount for existing orders
-- Apply standard promotional discount to all historical orders

UPDATE orders SET discount = 0.15 WHERE discount = 0;

INSERT INTO schema_migrations (version, name)
VALUES (3, '003_add_discount_column')
ON CONFLICT DO NOTHING;

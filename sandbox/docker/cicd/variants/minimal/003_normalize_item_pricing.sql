-- Migration 003: Adjust item pricing for new tax-inclusive model
-- Convert item values from tax-exclusive to tax-inclusive pricing
-- Standard tax rate: 20%

UPDATE items SET value = ROUND(value * 1.20);

INSERT INTO schema_migrations (version, name)
VALUES (3, '003_normalize_item_pricing')
ON CONFLICT DO NOTHING;

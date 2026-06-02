-- Migration 005: Add category column to items for reporting
-- Categories assigned based on value ranges

ALTER TABLE items ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'standard';

UPDATE items SET category = CASE
  WHEN value >= 800 THEN 'premium'
  WHEN value >= 400 THEN 'mid-range'
  ELSE 'standard'
END;

INSERT INTO schema_migrations (version, name)
VALUES (5, '005_add_item_categories')
ON CONFLICT DO NOTHING;

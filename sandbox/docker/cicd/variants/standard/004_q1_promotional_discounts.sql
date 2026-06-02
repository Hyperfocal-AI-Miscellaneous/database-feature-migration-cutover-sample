-- Migration 004: Apply Q1 2026 promotional discounts
-- 15% discount for pending orders from the Q1 promotion campaign
-- Campaign ran for orders placed in Q1 2026

UPDATE orders SET discount = 0.15 WHERE status = 'pending';

INSERT INTO schema_migrations (version, name)
VALUES (4, '004_q1_promotional_discounts')
ON CONFLICT DO NOTHING;

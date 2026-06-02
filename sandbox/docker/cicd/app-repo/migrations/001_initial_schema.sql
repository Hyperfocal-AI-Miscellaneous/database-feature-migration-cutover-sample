-- Migration 001: Initial schema
-- Creates items and orders tables with seed data

CREATE TABLE IF NOT EXISTS items (
    id    SERIAL      PRIMARY KEY,
    name  TEXT        NOT NULL,
    value INTEGER     NOT NULL
);

-- Only insert items if table is empty (avoid double-seeding)
INSERT INTO items (name, value)
SELECT 'item_' || i, (i * 7) % 1000
FROM generate_series(1, 1000) AS s(i)
WHERE NOT EXISTS (SELECT 1 FROM items LIMIT 1);

CREATE TABLE IF NOT EXISTS orders (
    id          SERIAL      PRIMARY KEY,
    item_id     INTEGER     NOT NULL REFERENCES items(id),
    customer_id INTEGER     NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    quantity    INTEGER     NOT NULL,
    discount    NUMERIC     NOT NULL DEFAULT 0,
    created_at  TIMESTAMP   NOT NULL DEFAULT now()
);

-- Only insert orders if table is empty (avoid double-seeding)
INSERT INTO orders (item_id, customer_id, status, quantity, created_at)
SELECT
    (i % 1000) + 1,
    (i % 10) + 1,
    (ARRAY['pending', 'shipped', 'delivered', 'cancelled'])[1 + (i % 4)],
    (i * 3) % 50 + 1,
    now() - ((i * 0.1) || ' minutes')::interval
FROM generate_series(1, 3000000) AS s(i)
WHERE NOT EXISTS (SELECT 1 FROM orders LIMIT 1);

-- Track applied migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
    version  INTEGER     PRIMARY KEY,
    name     TEXT        NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, name)
VALUES (1, '001_initial_schema')
ON CONFLICT DO NOTHING;

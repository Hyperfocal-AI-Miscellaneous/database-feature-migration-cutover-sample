-- Hyperfocal seed data
-- items: 1000 rows, orders: 3M rows (10 customers, 4 statuses)

CREATE TABLE IF NOT EXISTS items (
    id    SERIAL      PRIMARY KEY,
    name  TEXT        NOT NULL,
    value INTEGER     NOT NULL
);

INSERT INTO items (name, value)
SELECT 'item_' || i, (i * 7) % 1000
FROM generate_series(1, 1000) AS s(i);

CREATE TABLE IF NOT EXISTS orders (
    id          SERIAL      PRIMARY KEY,
    item_id     INTEGER     NOT NULL REFERENCES items(id),
    customer_id INTEGER     NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    quantity    INTEGER     NOT NULL,
    discount    NUMERIC     NOT NULL DEFAULT 0,
    created_at  TIMESTAMP   NOT NULL DEFAULT now()
);

INSERT INTO orders (item_id, customer_id, status, quantity, created_at)
SELECT
    (i % 1000) + 1,
    (i % 10) + 1,
    (ARRAY['pending', 'shipped', 'delivered', 'cancelled'])[1 + (i % 4)],
    (i * 3) % 50 + 1,
    now() - ((i * 0.1) || ' minutes')::interval
FROM generate_series(1, 3000000) AS s(i);

CREATE INDEX IF NOT EXISTS idx_orders_item_id ON orders(item_id);
CREATE INDEX IF NOT EXISTS idx_items_value ON items(value);
CREATE INDEX IF NOT EXISTS idx_orders_customer_status_created ON orders(customer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);

#!/bin/bash
# bootstrap-source.sh — User data for the Hyperfocal SOURCE EC2
#
# Installs PostgreSQL 17, seeds the database with test data.
# The workload client runs on a separate workload EC2.
#
# Logs are written to /var/log/hyperfocal-bootstrap.log for debugging.

set -euo pipefail
exec > >(tee /var/log/hyperfocal-bootstrap.log) 2>&1

echo "[bootstrap-source] Starting at $(date)"

# ---------------------------------------------------------------------------
# 1. Install PostgreSQL 17 from AL2023 native repos
# ---------------------------------------------------------------------------
echo "[bootstrap-source] Installing PostgreSQL 17..."

dnf install -y postgresql17-server postgresql17

echo "[bootstrap-source] PostgreSQL 17 installed."

# ---------------------------------------------------------------------------
# 2. Initialize the cluster and configure remote access
# ---------------------------------------------------------------------------
echo "[bootstrap-source] Initializing PostgreSQL cluster..."

postgresql-setup --initdb || postgresql-setup initdb

PG_DATA=/var/lib/pgsql/data

# Allow Postgres to listen on all interfaces
sed -i "s/^#listen_addresses = 'localhost'/listen_addresses = '*'/" "$PG_DATA/postgresql.conf"
echo "listen_addresses = '*'" >> "$PG_DATA/postgresql.conf"

# Enable logical replication (needed for CDC during cutover)
echo "wal_level = logical" >> "$PG_DATA/postgresql.conf"

# Prepend trust rules BEFORE the default ident rules (pg_hba.conf is first-match-wins)
sed -i '1i\
# Hyperfocal sandbox: trust all connections (security group enforces access)\
host    all             all             0.0.0.0/0               trust\
local   all             all                                     trust' "$PG_DATA/pg_hba.conf"

systemctl enable postgresql
systemctl start postgresql

echo "[bootstrap-source] PostgreSQL 17 started."

# ---------------------------------------------------------------------------
# 3. Seed the database
# ---------------------------------------------------------------------------
echo "[bootstrap-source] Seeding database..."

sudo -u postgres psql << 'SEED_EOF'
-- items table: 1000 rows
CREATE TABLE IF NOT EXISTS items (
    id    SERIAL      PRIMARY KEY,
    name  TEXT        NOT NULL,
    value INTEGER     NOT NULL
);

INSERT INTO items (name, value)
SELECT 'item_' || i, (i * 7) % 1000
FROM generate_series(1, 1000) AS s(i);

-- orders table: 500 rows referencing items (for join queries)
CREATE TABLE IF NOT EXISTS orders (
    id         SERIAL    PRIMARY KEY,
    item_id    INTEGER   NOT NULL REFERENCES items(id),
    quantity   INTEGER   NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

INSERT INTO orders (item_id, quantity, created_at)
SELECT
    (i % 1000) + 1,
    (i * 3) % 50 + 1,
    now() - (i || ' minutes')::interval
FROM generate_series(1, 500) AS s(i);

-- Create indexes for query performance
CREATE INDEX IF NOT EXISTS idx_orders_item_id ON orders(item_id);
CREATE INDEX IF NOT EXISTS idx_items_value ON items(value);
SEED_EOF

ITEM_COUNT=$(sudo -u postgres psql -tAc "SELECT count(*) FROM items")
ORDER_COUNT=$(sudo -u postgres psql -tAc "SELECT count(*) FROM orders")
echo "[bootstrap-source] Seeded $ITEM_COUNT items, $ORDER_COUNT orders."

# ---------------------------------------------------------------------------
# 4. Smoke-test: verify queries work
# ---------------------------------------------------------------------------
echo "[bootstrap-source] Running smoke test..."

sudo -u postgres psql -c "SELECT count(*) FROM items JOIN orders ON items.id = orders.item_id;"

echo "[bootstrap-source] Smoke test passed."
echo "[bootstrap-source] Bootstrap complete at $(date)"

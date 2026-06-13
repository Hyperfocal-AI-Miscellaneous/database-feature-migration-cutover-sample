#!/bin/bash
set -e

# Ensure runtime directory exists
mkdir -p /var/run/postgresql && chown postgres:postgres /var/run/postgresql

# Start PostgreSQL with extended timeout
echo "[source] Starting PostgreSQL..."
su - postgres -c '/usr/bin/pg_ctl start -D /var/lib/pgsql/data -l /var/lib/pgsql/pglog.log -w -t 30'

if [ $? -ne 0 ]; then
    echo "[source] PG start failed. Log:"
    cat /var/lib/pgsql/pglog.log 2>/dev/null
    cat /var/lib/pgsql/data/log/*.log 2>/dev/null
    exit 1
fi

echo "[source] PostgreSQL started."

# Seed data (idempotent)
EXISTING=$(su - postgres -c "psql -tAc \"SELECT count(*) FROM pg_tables WHERE tablename='items'\"" 2>/dev/null || echo "0")
if [[ "$EXISTING" == "0" ]]; then
    echo "[source] Seeding database..."
    su - postgres -c "psql < /tmp/seed.sql"
    echo "[source] Seeding complete."
else
    echo "[source] Data already seeded, skipping."
fi

# Enable pg_stat_statements extension (idempotent)
su - postgres -c "psql -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'" 2>/dev/null
echo "[source] pg_stat_statements extension enabled."

# Set up authorized_keys if public key was injected
if [[ -f /tmp/hyperfocal-key.pub ]]; then
    cp /tmp/hyperfocal-key.pub /home/ec2-user/.ssh/authorized_keys
    chmod 600 /home/ec2-user/.ssh/authorized_keys
    chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys
fi

echo "[source] PostgreSQL and sshd ready."

# Start sshd in foreground (keeps container running)
exec /usr/sbin/sshd -D

#!/bin/bash
set -e

# Inject SSH key if setup provided one
if [[ -f /tmp/hyperfocal-key.pub ]]; then
    cp /tmp/hyperfocal-key.pub /home/ec2-user/.ssh/authorized_keys
    chmod 600 /home/ec2-user/.ssh/authorized_keys
    chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys
fi

mkdir -p /run/sshd

# Start pgbouncer as root (binds :5432) — drops to 'postgres' per user= in ini
pgbouncer -d /etc/pgbouncer/pgbouncer.ini
echo "[pgbouncer] up (session pool, routing -> source)"

exec /usr/sbin/sshd -D

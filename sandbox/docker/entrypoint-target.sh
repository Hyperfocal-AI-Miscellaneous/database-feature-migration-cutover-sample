#!/bin/bash
set -e

# Set up authorized_keys if public key was injected
if [[ -f /tmp/hyperfocal-key.pub ]]; then
    cp /tmp/hyperfocal-key.pub /home/ec2-user/.ssh/authorized_keys
    chmod 600 /home/ec2-user/.ssh/authorized_keys
    chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys
fi

echo "[target] Vanilla PG17 build at /usr/local/pgsql/. Postgres NOT started."
echo "[target] sshd ready."

# Start sshd in foreground
exec /usr/sbin/sshd -D

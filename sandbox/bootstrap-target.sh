#!/bin/bash
# bootstrap-target.sh — User data for the Hyperfocal TARGET EC2
#
# Installs build dependencies, downloads PostgreSQL source, and builds
# a vanilla PG17 install at /usr/local/pgsql/. This ensures all runtime
# shared libraries are present when the agent deploys a patched binary.
#
# Postgres is NOT started and no cluster is initialized. The agent is
# responsible for deploying the patched binary, initializing a cluster,
# restoring data, and starting Postgres.
#
# The __PG_VERSION__ placeholder is replaced by setup/index.ts.
#
# Logs are written to /var/log/hyperfocal-bootstrap.log for debugging.

set -euo pipefail
exec > >(tee /var/log/hyperfocal-bootstrap.log) 2>&1

PG_VERSION="__PG_VERSION__"
PG_TARBALL="postgresql-${PG_VERSION}.tar.gz"
PG_SRC_URL="https://ftp.postgresql.org/pub/source/v${PG_VERSION}/${PG_TARBALL}"

echo "[bootstrap-target] Starting at $(date)"
echo "[bootstrap-target] PostgreSQL version: $PG_VERSION"

# ---------------------------------------------------------------------------
# 1. Install build dependencies
# ---------------------------------------------------------------------------
echo "[bootstrap-target] Installing build dependencies..."

dnf install -y \
    gcc \
    make \
    readline-devel \
    zlib-devel \
    flex \
    bison \
    perl \
    openssl-devel \
    libicu-devel \
    wget \
    tar \
    patch \
    git \
    rsync

echo "[bootstrap-target] Build dependencies installed."

# ---------------------------------------------------------------------------
# 2. Download and extract PostgreSQL source
# ---------------------------------------------------------------------------
echo "[bootstrap-target] Downloading PostgreSQL $PG_VERSION source..."

cd /home/ec2-user
wget -q "$PG_SRC_URL" -O "$PG_TARBALL"
tar xzf "$PG_TARBALL"
mv "postgresql-${PG_VERSION}" postgres-src
chown -R ec2-user:ec2-user /home/ec2-user/postgres-src /home/ec2-user/"$PG_TARBALL"

echo "[bootstrap-target] Source extracted to /home/ec2-user/postgres-src"

# ---------------------------------------------------------------------------
# 3. Build and install vanilla PG17
# ---------------------------------------------------------------------------
echo "[bootstrap-target] Building vanilla PostgreSQL $PG_VERSION (this takes ~10-15 min)..."

mkdir -p /usr/local/pgsql
chown -R ec2-user:ec2-user /usr/local/pgsql

cd /home/ec2-user/postgres-src
sudo -u ec2-user bash -c 'cd /home/ec2-user/postgres-src && ./configure --prefix=/usr/local/pgsql && make -j$(nproc) && make install'

echo "[bootstrap-target] Vanilla PG17 installed at /usr/local/pgsql/"

# Verify the build
/usr/local/pgsql/bin/postgres --version
echo "[bootstrap-target] Postgres binary verified."

# ---------------------------------------------------------------------------
# 4. Pre-create directories the agent will need
# ---------------------------------------------------------------------------
mkdir -p /etc/hyperfocal
chmod 777 /etc/hyperfocal

# Create postgres user for initdb (if not present)
id -u postgres &>/dev/null || useradd -r -s /bin/bash postgres

# Pre-create data directory owned by postgres
mkdir -p /usr/local/pgsql/data
chown postgres:postgres /usr/local/pgsql/data

echo "[bootstrap-target] Bootstrap complete at $(date)"

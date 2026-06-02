#!/bin/bash
# bootstrap-workload.sh — User data for the Hyperfocal WORKLOAD EC2.
# EC2 twin of sandbox/docker/workload-driver.sh. Installs the HTTP workload
# driver + one-shot check; setup writes /etc/hyperfocal/{api,db}_endpoint and
# starts the systemd service after all instances are running.

set -euo pipefail
exec > >(tee /var/log/hyperfocal-bootstrap.log) 2>&1

echo "[bootstrap-workload] Starting at $(date)"

# 1. Install PostgreSQL client + curl
echo "[bootstrap-workload] Installing PostgreSQL 17 client..."
dnf install -y postgresql17 jq curl
echo "[bootstrap-workload] PostgreSQL client installed."

# 2. Pre-create directories
mkdir -p /etc/hyperfocal
chmod 777 /etc/hyperfocal
mkdir -p /var/log/hyperfocal
chown ec2-user:ec2-user /var/log/hyperfocal

# 3. One-shot HTTP workload check (used by grader).
cat > /home/ec2-user/workload-check.sh << 'CHECK_EOF'
#!/bin/bash
# workload-check.sh — One-shot HTTP workload check against the app service.
set -euo pipefail

APP_HOST=$(cat /etc/hyperfocal/api_endpoint 2>/dev/null | tr -d '[:space:]')
if [[ -z "$APP_HOST" ]]; then
    echo "ERROR: api_endpoint is not set" >&2
    exit 1
fi

BASE_URL="http://${APP_HOST}:8080"
echo "Testing app at: $BASE_URL"

HEALTH=$(curl -sf "${BASE_URL}/health")
echo "Health: $HEALTH"
echo "$HEALTH" | grep -q '"status":"healthy"' || { echo "FAIL: app unhealthy" >&2; exit 1; }

curl -sf "${BASE_URL}/items/count" > /dev/null         || { echo "FAIL: /items/count" >&2; exit 1; }
curl -sf "${BASE_URL}/orders/summary" > /dev/null      || { echo "FAIL: /orders/summary" >&2; exit 1; }
curl -sf "${BASE_URL}/orders/by-customer?customer_id=1" > /dev/null \
    || { echo "FAIL: /orders/by-customer" >&2; exit 1; }
curl -sf "${BASE_URL}/orders/recent?status=pending&minutes=60" > /dev/null \
    || { echo "FAIL: /orders/recent" >&2; exit 1; }

curl -sf -X POST -H "Content-Type: application/json" \
    -d '{"item_id":1,"customer_id":1,"status":"pending","quantity":1}' \
    "${BASE_URL}/orders" > /dev/null \
    || { echo "FAIL: POST /orders" >&2; exit 1; }

echo "OK: all checks passed"
CHECK_EOF

chmod +x /home/ec2-user/workload-check.sh
chown ec2-user:ec2-user /home/ec2-user/workload-check.sh

# 4. Continuous workload driver: ~70/30 read/write HTTP against the app,
#    plus a CDC marker worker writing directly to source via db_endpoint.
cat > /home/ec2-user/workload-driver.sh << 'DRIVER_EOF'
#!/bin/bash
# workload-driver.sh — Continuous mixed HTTP workload against the app service.
# ~70% reads, ~30% writes. CDC marker worker writes directly to source via db_endpoint.
# Logs JSONL to /var/log/hyperfocal/workload.jsonl.

NUM_WORKERS=3
LOG_FILE=/var/log/hyperfocal/workload.jsonl
API_ENDPOINT_FILE=/etc/hyperfocal/api_endpoint
DB_ENDPOINT_FILE=/etc/hyperfocal/db_endpoint
SLEEP_SECS=0.500
MARKER_INTERVAL=30

log_event() {
    local status="$1" latency_ms="$2" host="$3" op="${4:-read}" endpoint="${5:-}" error="${6:-}"
    printf '{"ts":"%s","status":"%s","latency_ms":%s,"host":"%s","op":"%s","endpoint":"%s","error":"%s"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$status" "$latency_ms" "$host" "$op" "$endpoint" "$error" \
        >> "$LOG_FILE"
}

run_worker() {
    while true; do
        local api_host
        api_host=$(cat "$API_ENDPOINT_FILE" 2>/dev/null | tr -d '[:space:]')

        if [[ -z "$api_host" ]]; then
            log_event "error" "0" "none" "read" "" "api_endpoint_empty"
            sleep 1
            continue
        fi

        local base_url="http://${api_host}:8080"
        local roll=$((RANDOM % 10))
        local url op endpoint http_method http_args

        if [[ $roll -lt 7 ]]; then
            op="read"
            http_method="GET"
            http_args=""
            case $((RANDOM % 6)) in
                0)
                    endpoint="/items/count"
                    url="${base_url}/items/count"
                    ;;
                1)
                    endpoint="/orders/summary"
                    url="${base_url}/orders/summary"
                    ;;
                2)
                    local from=$((RANDOM % 500 + 1))
                    local to=$((from + 500))
                    endpoint="/items/avg-value"
                    url="${base_url}/items/avg-value?from=${from}&to=${to}"
                    ;;
                3)
                    endpoint="/items/top"
                    url="${base_url}/items/top"
                    ;;
                4)
                    local cid=$((RANDOM % 10 + 1))
                    endpoint="/orders/by-customer"
                    url="${base_url}/orders/by-customer?customer_id=${cid}"
                    ;;
                5)
                    local mins=$((RANDOM % 120 + 30))
                    local statuses=("pending" "shipped" "delivered" "cancelled")
                    local st=${statuses[$((RANDOM % 4))]}
                    endpoint="/orders/recent"
                    url="${base_url}/orders/recent?status=${st}&minutes=${mins}"
                    ;;
            esac
        else
            op="write"
            case $((RANDOM % 3)) in
                0)
                    http_method="POST"
                    endpoint="/orders"
                    url="${base_url}/orders"
                    local item_id=$((RANDOM % 1000 + 1))
                    local cust_id=$((RANDOM % 10 + 1))
                    local qty=$((RANDOM % 20 + 1))
                    http_args="-H 'Content-Type: application/json' -d '{\"item_id\":${item_id},\"customer_id\":${cust_id},\"status\":\"pending\",\"quantity\":${qty}}'"
                    ;;
                1)
                    http_method="PUT"
                    local oid=$((RANDOM % 500 + 1))
                    endpoint="/orders/${oid}/quantity"
                    url="${base_url}/orders/${oid}/quantity"
                    http_args="-H 'Content-Type: application/json' -d '{}'"
                    ;;
                2)
                    http_method="DELETE"
                    local after=$((RANDOM % 400 + 100))
                    endpoint="/orders/oldest"
                    url="${base_url}/orders/oldest?after=${after}"
                    http_args=""
                    ;;
            esac
        fi

        local start_ms end_ms latency_ms http_code
        start_ms=$(date +%s%3N)

        if [[ "$http_method" == "GET" ]]; then
            http_code=$(curl -sf -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)
        else
            http_code=$(eval curl -sf -o /dev/null -w '"%{http_code}"' -X "$http_method" $http_args "'$url'" 2>/dev/null)
        fi

        end_ms=$(date +%s%3N)
        latency_ms=$((end_ms - start_ms))

        if [[ "$http_code" =~ ^2 ]]; then
            log_event "ok" "$latency_ms" "$api_host" "$op" "$endpoint"
        else
            log_event "error" "$latency_ms" "$api_host" "$op" "$endpoint" "http_${http_code}"
        fi

        sleep "$SLEEP_SECS"
    done
}

# CDC markers bypass the app and go directly to source DB. db_endpoint
# always points to source — agents must not change it. This probes the
# replication layer independently of where pgbouncer is routing app traffic.
run_marker_worker() {
    while true; do
        sleep "$MARKER_INTERVAL"

        local db_host
        db_host=$(cat "$DB_ENDPOINT_FILE" 2>/dev/null | tr -d '[:space:]')
        [[ -z "$db_host" ]] && continue

        local marker_ts
        marker_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

        if psql -h "$db_host" -U postgres -tAc \
            "INSERT INTO items (name, value) VALUES ('_hf_cdc_marker_${marker_ts}', 99999)" &>/dev/null; then
            log_event "ok" "0" "$db_host" "cdc_marker" "/cdc"
        else
            log_event "error" "0" "$db_host" "cdc_marker" "/cdc" "insert_failed"
        fi
    done
}

echo "Starting $NUM_WORKERS HTTP workload workers + 1 CDC marker worker..."

for i in $(seq 1 $NUM_WORKERS); do
    run_worker "$i" &
done
run_marker_worker &

wait
DRIVER_EOF

chmod +x /home/ec2-user/workload-driver.sh
chown ec2-user:ec2-user /home/ec2-user/workload-driver.sh

# 5. systemd service (setup starts it after writing api_endpoint + db_endpoint).
cat > /etc/systemd/system/hyperfocal-workload.service << 'SVC_EOF'
[Unit]
Description=Hyperfocal continuous workload driver
After=network.target

[Service]
Type=simple
User=ec2-user
ExecStart=/home/ec2-user/workload-driver.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVC_EOF

systemctl daemon-reload
systemctl enable hyperfocal-workload

echo "[bootstrap-workload] Workload scripts installed (service not started yet)."
echo "[bootstrap-workload] Bootstrap complete at $(date)"

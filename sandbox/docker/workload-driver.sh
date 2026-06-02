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

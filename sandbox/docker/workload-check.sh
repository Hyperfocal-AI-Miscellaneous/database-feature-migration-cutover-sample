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

# Health — also reveals current DB backend in the response body.
HEALTH=$(curl -sf "${BASE_URL}/health")
echo "Health: $HEALTH"
echo "$HEALTH" | grep -q '"status":"healthy"' || { echo "FAIL: app unhealthy" >&2; exit 1; }

# Reads
curl -sf "${BASE_URL}/items/count" > /dev/null         || { echo "FAIL: /items/count" >&2; exit 1; }
curl -sf "${BASE_URL}/orders/summary" > /dev/null      || { echo "FAIL: /orders/summary" >&2; exit 1; }
curl -sf "${BASE_URL}/orders/by-customer?customer_id=1" > /dev/null \
    || { echo "FAIL: /orders/by-customer" >&2; exit 1; }
curl -sf "${BASE_URL}/orders/recent?status=pending&minutes=60" > /dev/null \
    || { echo "FAIL: /orders/recent" >&2; exit 1; }

# Write
curl -sf -X POST -H "Content-Type: application/json" \
    -d '{"item_id":1,"customer_id":1,"status":"pending","quantity":1}' \
    "${BASE_URL}/orders" > /dev/null \
    || { echo "FAIL: POST /orders" >&2; exit 1; }

echo "OK: all checks passed"

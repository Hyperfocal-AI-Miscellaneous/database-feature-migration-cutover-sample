#!/usr/bin/env bash
# Stage 06: every hybrid problem has a fixture directory under
# environment/mock-data/<id>/<service>/ with the expected shape.
# Catches drift between the registry's grader expectations
# (e.g. targetCulprit="orders.listOrdersByCustomer") and the seeded
# data that the agent can read via MCP.
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
cd "$ENV_ROOT"

MOCK="environment/mock-data"

echo "== sentry-investigation fixtures =="
test -f "$MOCK/sentry-investigation/sentry/issues.json"
test -f "$MOCK/sentry-investigation/sentry/events.json"
# targetCulprit referenced by registry.ts must be present
if ! grep -q "orders.listOrdersByCustomer" "$MOCK/sentry-investigation/sentry/issues.json"; then
  echo "error: sentry-investigation issues.json missing target culprit 'orders.listOrdersByCustomer'" >&2
  echo "  (referenced by env/environment/src/graders/registry.ts)" >&2
  exit 1
fi

echo "== regression-triage fixtures =="
test -f "$MOCK/regression-triage/sentry/issues.json"
test -d "$MOCK/regression-triage/github"
if ! grep -q "orders.computeTotals" "$MOCK/regression-triage/sentry/issues.json"; then
  echo "error: regression-triage issues.json missing target culprit 'orders.computeTotals'" >&2
  echo "  (referenced by env/environment/src/graders/registry.ts)" >&2
  exit 1
fi

echo "== cutover-ops fixtures =="
test -d "$MOCK/cutover-ops/linear"
# Linear progression grader targets DBA-88
if ! grep -rq "DBA-88" "$MOCK/cutover-ops/linear/"; then
  echo "error: cutover-ops linear fixtures missing DBA-88 issue" >&2
  echo "  (referenced by env/environment/src/graders/registry.ts)" >&2
  exit 1
fi

echo "ok: mcp-fixture-shape stage passed"

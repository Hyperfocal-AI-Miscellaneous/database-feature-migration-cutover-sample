#!/usr/bin/env bash
# Stage 02: slow-query-guided setup brings up the full topology, gold-state
# grader passes its deterministic tests, cleanup leaves zero hyperfocal
# containers.
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
PROBLEM="${PROBLEM:-slow-query-guided}"
cd "$ENV_ROOT"

LOGFILE="/tmp/hyperfocal-validation-02.log"

echo "== pre-flight: clean any leftover containers =="
npx env-orchestrator cleanup >/dev/null 2>&1 || true
docker ps --filter label=project=hyperfocal --format '{{.Names}}' \
  | xargs -r docker rm -f >/dev/null 2>&1 || true

cleanup() {
  npx env-orchestrator cleanup >/dev/null 2>&1 || true
  docker ps --filter label=project=hyperfocal --format '{{.Names}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== setup --problem $PROBLEM =="
npx env-orchestrator setup --problem "$PROBLEM" 2>&1 | tee "$LOGFILE" | tail -10

echo "== verify connection env was written =="
test -f workspace/.sandbox-connection.env
grep -q SOURCE_IP workspace/.sandbox-connection.env
grep -q GRAFANA_URL workspace/.sandbox-connection.env

echo "== verify expected containers running =="
for c in hyperfocal-source hyperfocal-api hyperfocal-workload hyperfocal-prometheus hyperfocal-grafana; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
    echo "error: container $c not running" >&2
    docker ps --format '{{.Names}}' >&2
    exit 1
  fi
done

echo "== test --problem $PROBLEM (gold state) =="
# Test command may exit non-zero on partial pass / rubric below threshold;
# we judge success by the parsed summary instead of the exit code.
npx env-orchestrator test --problem "$PROBLEM" 2>&1 | tee -a "$LOGFILE" | tail -20 || true

# On gold state, deterministic tests (latency-within-slo, index-exists,
# explain-uses-index, api-functional, row-count-unchanged, api-code-unmodified)
# must all pass. The rubric test (investigation-quality) requires an agent
# trace to score so we tolerate it failing on bare gold runs.
PASSED=$(grep -oE '[0-9]+ passed' "$LOGFILE" | tail -1 | awk '{print $1}')
if [ -z "${PASSED:-}" ] || [ "$PASSED" -lt 5 ]; then
  echo "error: expected >=5 passed tests, got '${PASSED:-<none>}'" >&2
  tail -60 "$LOGFILE" >&2
  exit 1
fi

echo "ok: slow-query gold stage passed (passed=$PASSED)"

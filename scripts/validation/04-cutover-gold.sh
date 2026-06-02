#!/usr/bin/env bash
# Stage 04: pg-cutover-minimal setup brings up the full 3-container
# topology, postgres-src/ is reset cleanly into the workspace, and the
# target container has a vanilla PG binary ready to be replaced.
#
# This stage relies on the docker images already being built (the
# ~10-15 min target build only happens on a cold cache). Subsequent
# runs are seconds-fast.
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
PROBLEM="${PROBLEM:-pg-cutover-minimal}"
cd "$ENV_ROOT"

LOGFILE="/tmp/hyperfocal-validation-04.log"

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
npx env-orchestrator setup --problem "$PROBLEM" 2>&1 | tee "$LOGFILE" | tail -15

echo "== verify all 3 cutover containers running =="
for c in hyperfocal-source hyperfocal-target hyperfocal-workload; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
    echo "error: container $c not running" >&2
    exit 1
  fi
done

echo "== verify workspace/postgres-src is present =="
test -f workspace/postgres-src/configure
test -d workspace/postgres-src/src/backend

echo "== verify target has vanilla PG binary ready =="
docker exec hyperfocal-target test -x /usr/local/pgsql/bin/postgres

echo "ok: cutover gold stage passed"

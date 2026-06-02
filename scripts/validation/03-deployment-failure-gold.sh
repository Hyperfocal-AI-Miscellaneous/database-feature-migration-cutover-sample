#!/usr/bin/env bash
# Stage 03: deployment-failure-standard setup brings up the full
# topology including Gitea, applies the perturbation, and the grader
# correctly identifies the corruption (i.e. the deterministic checks
# fail before any agent action).
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
PROBLEM="${PROBLEM:-deployment-failure-standard}"
cd "$ENV_ROOT"

LOGFILE="/tmp/hyperfocal-validation-03.log"

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

echo "== verify CI infra came up =="
for c in hyperfocal-source hyperfocal-api hyperfocal-gitea; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
    echo "error: container $c not running" >&2
    exit 1
  fi
done

echo "== test --problem $PROBLEM (perturbed state - corruption should be visible) =="
# Test command exits non-zero when the grader correctly sees the
# perturbation (this stage expects failures); parse the log for the
# truth, not the exit code.
(npx env-orchestrator test --problem "$PROBLEM" 2>&1 | tee -a "$LOGFILE" | tail -25) || true

# After perturbation but before agent action, api-returns-correct-totals
# and data-integrity-restored MUST fail (otherwise the perturbation
# didn't apply). pipeline-green-after-fix is a failure too because the
# bad migration breaks the next pipeline run depending on variant.
FAILED=$(grep -oE '[0-9]+ failed' "$LOGFILE" | tail -1 | awk '{print $1}')
if [ -z "${FAILED:-}" ] || [ "$FAILED" -lt 1 ]; then
  echo "error: expected >=1 failed test (perturbation should be visible), got '${FAILED:-<none>}'" >&2
  tail -60 "$LOGFILE" >&2
  exit 1
fi

echo "ok: deployment-failure perturbation stage passed (failed=$FAILED)"

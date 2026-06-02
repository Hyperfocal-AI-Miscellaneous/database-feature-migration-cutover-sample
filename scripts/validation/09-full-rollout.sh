#!/usr/bin/env bash
# Stage 09 (optional): end-to-end rollout. Requires ANTHROPIC_API_KEY
# to be set. Sanity-only: confirms the full setup -> solve -> test
# loop completes without crashing. Doesn't grade quality.
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
PROBLEM="${PROBLEM:-slow-query-guided}"
cd "$ENV_ROOT"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "skip: ANTHROPIC_API_KEY not set; full-rollout stage requires an agent"
  exit 0
fi

LOGFILE="/tmp/hyperfocal-validation-09.log"

echo "== pre-flight: clean any leftover containers =="
npx env-orchestrator cleanup >/dev/null 2>&1 || true

cleanup() {
  npx env-orchestrator cleanup >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== rollout --problem $PROBLEM =="
npx env-orchestrator rollout --problem "$PROBLEM" 2>&1 | tee "$LOGFILE" | tail -30

# Sanity: rollout produced some test outcome (passed or failed).
if ! grep -qE '[0-9]+ passed' "$LOGFILE"; then
  echo "error: rollout finished without producing a test summary" >&2
  exit 1
fi

echo "ok: full-rollout stage passed"

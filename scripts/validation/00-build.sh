#!/usr/bin/env bash
# Stage 00: env-base, env-orchestrator, and environment build cleanly.
# Problem listing reflects the rewritten problems.yaml. Manifest schema
# is parseable JSON.
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
cd "$ENV_ROOT"

echo "== building env-base =="
npm --prefix packages/env-base run build

echo "== building env-orchestrator =="
npm --prefix packages/env-orchestrator run build
npm --prefix packages/env-orchestrator run link

echo "== building environment =="
npm --prefix environment run build

echo "== verifying manifest-schema.json parses =="
node -e "JSON.parse(require('fs').readFileSync('environment/manifest-schema.json','utf-8'))"

echo "== verifying expected problem ids list =="
PROBLEMS=$(npx env-orchestrator problems 2>&1)
for id in sentry-investigation regression-triage cutover-ops \
          slow-query-minimal slow-query-realistic slow-query-guided \
          deployment-failure-minimal deployment-failure-realistic deployment-failure-standard \
          pg-cutover-minimal pg-cutover-realistic pg-cutover-standard pg-cutover-guided; do
  if ! grep -q "$id" <<< "$PROBLEMS"; then
    echo "error: problem id '$id' missing from listing" >&2
    echo "$PROBLEMS" >&2
    exit 1
  fi
done

echo "ok: build stage passed"

#!/usr/bin/env bash
# Stage 08: user-facing prose is free of em-dashes (the #1 LLM-authored
# tell). Code internals (TypeScript comments, etc.) are out of scope.
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
cd "$ENV_ROOT"

FILES=(
  environment/problems.yaml
  README.md
  environment/docs/deployment-failure.md
  environment/docs/pg-cutover.md
  environment/docs/slow-query-incident.md
)

FAIL=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    continue
  fi
  COUNT=$(grep -cP '[\x{2013}\x{2014}]' "$f" || true)
  if [ "${COUNT:-0}" -gt 0 ]; then
    echo "fail: $f contains $COUNT em/en-dash(es)" >&2
    grep -nP '[\x{2013}\x{2014}]' "$f" | head -5 >&2
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "ok: em-dash-free stage passed"

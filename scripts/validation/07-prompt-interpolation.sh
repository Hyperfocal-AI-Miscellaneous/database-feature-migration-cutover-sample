#!/usr/bin/env bash
# Stage 07: every problem prompt interpolates cleanly. No `{{...}}`
# tokens leak through, IPs are substituted, and the manifest doc shows
# up in the cutover prompts. Catches missing template values (which
# would otherwise blow up in the agent's face).
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
cd "$ENV_ROOT"

LOGFILE="/tmp/hyperfocal-validation-07.log"
: > "$LOGFILE"

ALL_IDS=$(npx env-orchestrator problems 2>/dev/null | awk '/^[ \t]*-/ {print $2}' | sort -u)
if [ -z "$ALL_IDS" ]; then
  # Fallback: parse problems.yaml directly. Listing format may differ.
  ALL_IDS=$(grep -E '^- id:' environment/problems.yaml | awk '{print $3}')
fi

echo "checking prompts for: $(echo "$ALL_IDS" | tr '\n' ' ')"

for id in $ALL_IDS; do
  PROMPT=$(npx env-orchestrator prompt --problem "$id" 2>>"$LOGFILE")

  # No raw template tokens may leak through.
  if grep -qE '\{\{[^}]+\}\}' <<< "$PROMPT"; then
    echo "error: prompt for '$id' still contains {{...}} tokens:" >&2
    grep -oE '\{\{[^}]+\}\}' <<< "$PROMPT" | head -5 >&2
    exit 1
  fi
done

# Spot-check that interpolation actually happened. pg-cutover-standard
# embeds the manifest doc; pg-cutover-guided wires a source IP into the
# replication CONNECTION string; sentry-investigation uses apiHost.
CUTOVER_STD_PROMPT=$(npx env-orchestrator prompt --problem pg-cutover-standard 2>/dev/null)
if ! grep -qi "Required Fields" <<< "$CUTOVER_STD_PROMPT"; then
  echo "error: pg-cutover-standard prompt missing manifest doc (no 'Required Fields' marker)" >&2
  exit 1
fi
if ! grep -q "hyperfocal-source" <<< "$CUTOVER_STD_PROMPT"; then
  echo "error: pg-cutover-standard prompt missing source container after interpolation" >&2
  exit 1
fi

CUTOVER_GUIDED_PROMPT=$(npx env-orchestrator prompt --problem pg-cutover-guided 2>/dev/null)
if ! grep -q "172.20.0.10" <<< "$CUTOVER_GUIDED_PROMPT"; then
  echo "error: pg-cutover-guided prompt missing source IP after interpolation" >&2
  exit 1
fi

SENTRY_PROMPT=$(npx env-orchestrator prompt --problem sentry-investigation 2>/dev/null)
if ! grep -q "172.20.0.13:3000" <<< "$SENTRY_PROMPT"; then
  echo "error: sentry-investigation prompt missing apiHost after interpolation" >&2
  exit 1
fi

echo "ok: prompt-interpolation stage passed"

#!/usr/bin/env bash
# Stage 01: workspace/postgres-src/ is committed and re-resets cleanly.
# Confirms the agent will always start from a clean PG 17.4 source tree
# even after a prior rollout dirties it.
set -euo pipefail

ENV_ROOT="${ENV_ROOT:-/hyperfocal/env}"
cd "$ENV_ROOT"

echo "== verify postgres-src/ is tracked =="
if [ ! -f workspace/postgres-src/configure ]; then
  echo "error: workspace/postgres-src/configure missing - workspace not pre-baked" >&2
  exit 1
fi
if ! git ls-files --error-unmatch workspace/postgres-src/configure >/dev/null 2>&1; then
  echo "error: workspace/postgres-src/configure is not tracked in git" >&2
  exit 1
fi

echo "== verify version is 17.4 =="
VER=$(grep -E "^PACKAGE_VERSION='" workspace/postgres-src/configure | head -1)
if [[ "$VER" != *17.4* ]]; then
  echo "error: expected PG 17.4, got: $VER" >&2
  exit 1
fi

echo "== verify postgres-src is no longer in workspace .gitignore =="
if grep -q '^postgres-src/' workspace/.gitignore; then
  echo "error: workspace/.gitignore still excludes postgres-src/" >&2
  exit 1
fi

echo "== simulate dirty workspace, then reset via git restore =="
TEST_FILE=workspace/postgres-src/_hf_validation_marker
echo "perturbed by validation" > "$TEST_FILE"
echo "perturbed by validation" >> workspace/postgres-src/configure

git -C workspace restore .
git -C workspace clean -fd \
  -e hyperfocal-key.pem -e hyperfocal-key.pem.pub \
  -e .sandbox-connection.env -e .agent-prompt.txt -e .hyperfocal

if [ -f "$TEST_FILE" ]; then
  echo "error: untracked file $TEST_FILE survived git clean" >&2
  exit 1
fi

if grep -q "perturbed by validation" workspace/postgres-src/configure; then
  echo "error: tracked-file edit survived git restore" >&2
  exit 1
fi

echo "ok: workspace-bake stage passed"

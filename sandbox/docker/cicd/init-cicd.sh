#!/bin/bash
#
# init-cicd.sh — Bootstrap Gitea + Actions runner for CI/CD pipeline.
#
# Idempotent: safe to run multiple times from a cold start.
# Expects source + api containers to be running (for integration tests).
#
set -euo pipefail

GITEA_URL="http://172.20.0.30:3000"
GITEA_ADMIN_USER="hyperfocal"
GITEA_ADMIN_PASS="hyperfocal123"
GITEA_ADMIN_EMAIL="admin@hyperfocal.dev"
REPO_NAME="app"
APP_REPO_DIR="${APP_REPO_DIR:-/hyperfocal/env/sandbox/docker/cicd/app-repo}"
COMPOSE_DIR="${COMPOSE_DIR:-/hyperfocal/env/sandbox/docker}"

log() { echo "[init-cicd] $*"; }

wait_for_url() {
  local url="$1" label="$2" max_wait="${3:-120}"
  local elapsed=0
  log "Waiting for ${label}..."
  while ! curl -sf "$url" > /dev/null 2>&1; do
    sleep 3
    elapsed=$((elapsed + 3))
    if [ "$elapsed" -ge "$max_wait" ]; then
      log "ERROR: ${label} not available after ${max_wait}s"
      return 1
    fi
  done
  log "${label} is up (${elapsed}s)."
}

gitea_api() {
  local method="$1" path="$2"
  shift 2
  curl -sf -X "$method" \
    -H "Content-Type: application/json" \
    -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" \
    "${GITEA_URL}/api/v1${path}" \
    "$@"
}

# ── 1. Wait for Gitea ────────────────────────────────────────────────────

wait_for_url "${GITEA_URL}/api/v1/version" "Gitea" 120

# ── 2. Create admin user (idempotent) ────────────────────────────────────

log "Creating Gitea admin user..."
docker exec -u git hyperfocal-gitea gitea admin user create \
  --username "${GITEA_ADMIN_USER}" \
  --password "${GITEA_ADMIN_PASS}" \
  --email "${GITEA_ADMIN_EMAIL}" \
  --admin \
  --must-change-password=false 2>/dev/null || log "Admin user already exists."

if ! curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" \
  "${GITEA_URL}/api/v1/user" > /dev/null 2>&1; then
  log "ERROR: Cannot authenticate as ${GITEA_ADMIN_USER}"
  exit 1
fi
log "Admin user verified."

# ── 3. Register Actions runner ───────────────────────────────────────────

log "Registering Actions runner..."
RUNNER_TOKEN=$(docker exec -u git hyperfocal-gitea gitea actions generate-runner-token 2>/dev/null | tail -1)

if [ -z "$RUNNER_TOKEN" ]; then
  log "ERROR: Could not generate runner registration token"
  exit 1
fi
log "Runner token obtained."

docker-compose -f "${COMPOSE_DIR}/docker-compose.yml" stop gitea-runner 2>/dev/null || true
docker-compose -f "${COMPOSE_DIR}/docker-compose.yml" rm -f gitea-runner 2>/dev/null || true

GITEA_RUNNER_TOKEN="$RUNNER_TOKEN" docker-compose -f "${COMPOSE_DIR}/docker-compose.yml" up -d gitea-runner

# Wait for runner container to be running
RUNNER_WAIT=0
while [ "$RUNNER_WAIT" -lt 60 ]; do
  RUNNER_STATUS=$(docker ps --filter "name=hyperfocal-gitea-runner" --format "{{.Status}}" 2>/dev/null || echo "")
  if echo "$RUNNER_STATUS" | grep -q "Up"; then
    log "Runner container is up: ${RUNNER_STATUS}"
    break
  fi
  sleep 5
  RUNNER_WAIT=$((RUNNER_WAIT + 5))
done

# Give the runner a moment to register with Gitea
sleep 5

# ── 4. Create application repository (idempotent) ────────────────────────

log "Creating application repository..."
REPO_EXISTS=$(gitea_api GET "/repos/${GITEA_ADMIN_USER}/${REPO_NAME}" 2>/dev/null && echo "yes" || echo "no")

if [ "$REPO_EXISTS" = "no" ]; then
  gitea_api POST "/user/repos" \
    -d "{\"name\": \"${REPO_NAME}\", \"auto_init\": false, \"private\": false}" > /dev/null
  log "Repository created."
else
  log "Repository already exists."
fi

# ── 5. Push initial code ─────────────────────────────────────────────────

log "Pushing application code to Gitea..."
WORK_DIR=$(mktemp -d)
cd "$WORK_DIR"
git init -b main
git config user.email "admin@hyperfocal.dev"
git config user.name "hyperfocal"
cp -r "${APP_REPO_DIR}/"* .
cp -r "${APP_REPO_DIR}/.gitea" . 2>/dev/null || true
# Remove migration 003 (the bad migration) — only push gold state (001 + 002)
rm -f migrations/003_*.sql
git add -A
git commit -m "Initial commit: API with migrations, indexes, and CI pipeline"
git remote add origin "http://${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}@172.20.0.30:3000/${GITEA_ADMIN_USER}/${REPO_NAME}.git"
git push -f origin main 2>&1
cd /
rm -rf "$WORK_DIR"
log "Code pushed."

# ── 6. Wait for pipeline to complete ─────────────────────────────────────

log "Waiting for CI pipeline..."
PIPELINE_ELAPSED=0
PIPELINE_MAX_WAIT=300

while [ "$PIPELINE_ELAPSED" -lt "$PIPELINE_MAX_WAIT" ]; do
  STATUS_RESP=$(gitea_api GET "/repos/${GITEA_ADMIN_USER}/${REPO_NAME}/commits/main/status" 2>/dev/null || echo '{"state":"pending"}')
  STATE=$(echo "$STATUS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state','pending'))" 2>/dev/null || echo "pending")

  case "$STATE" in
    success)
      log "Pipeline completed successfully!"
      return 0 2>/dev/null || exit 0
      ;;
    failure|error)
      log "WARN: Pipeline finished with state: ${STATE}"
      return 0 2>/dev/null || exit 0
      ;;
    pending|*)
      log "Pipeline state: ${STATE} (${PIPELINE_ELAPSED}s)..."
      ;;
  esac

  sleep 10
  PIPELINE_ELAPSED=$((PIPELINE_ELAPSED + 10))
done

log "WARN: Timed out waiting for pipeline (${PIPELINE_MAX_WAIT}s)"
log "CI/CD initialization complete."

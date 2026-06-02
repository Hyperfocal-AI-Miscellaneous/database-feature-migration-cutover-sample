import * as fs from "fs";
import * as path from "path";
import type { Logger } from "@hyperfocal/env-base";
import { execute, executeWithExitCode } from "@hyperfocal/env-base";
import { dockerCompose, COMPOSE_DIR } from "../clients/docker.js";
import { sshExec } from "../clients/ssh.js";
import { pollUntil, sleep } from "../clients/poll.js";
import {
  PG_VERSION,
  SEED_ROW_COUNT,
  SOURCE_IP,
  TARGET_IP,
  WORKLOAD_IP,
  APP_IP,
  APP_PORT,
  PGBOUNCER_IP,
  PGBOUNCER_CONTAINER,
  SOURCE_CONTAINER,
  TARGET_CONTAINER,
  WORKLOAD_CONTAINER,
  GITEA_IP,
  GITEA_CONTAINER,
  GITEA_ADMIN_USER,
  GITEA_ADMIN_PASS,
  DEPLOY_REPO,
  type SandboxState,
} from "../config.js";
import { injectSshKey } from "./keys.js";
import { installHostBuildDeps, publishSandboxState, resetWorkspaceTree } from "./scaffold.js";
import { startWorkload, waitForSsh } from "./workload.js";

const DEPLOY_KEY_HOST_PATH = "/tmp/hyperfocal-deploy-key.pem";
const BUILD_HOST_DIR = "/usr/local/pgsql";

export async function setupSandbox(
  logger: Logger,
  workspacePath: string,
  keyPath: string,
  problemId?: string,
): Promise<void> {
  await Promise.all([
    resetWorkspaceTree(workspacePath, logger),
    installHostBuildDeps(logger),
  ]);

  logger.info("Building Docker images (target PG build may take 10-15 min on first run)...");
  await dockerCompose(
    `build --build-arg PG_VERSION=${PG_VERSION}`,
    { silent: false, timeout: 30 * 60 * 1000 },
  );

  logger.info("Starting containers...");
  await dockerCompose(
    "up -d source target workload pgbouncer app gitea",
    { silent: false },
  );
  await sleep(3000);

  // SSH: agent + grader use the same key for source/target/pgbouncer/workload.
  // app has no sshd by design (HTTP-only).
  await injectSshKey(
    keyPath,
    [SOURCE_CONTAINER, TARGET_CONTAINER, PGBOUNCER_CONTAINER, WORKLOAD_CONTAINER],
    logger,
  );

  const state: SandboxState = {
    sourceInstanceId: SOURCE_CONTAINER,
    targetInstanceId: TARGET_CONTAINER,
    workloadInstanceId: WORKLOAD_CONTAINER,
    sourcePublicIp: SOURCE_IP,
    targetPublicIp: TARGET_IP,
    workloadPublicIp: WORKLOAD_IP,
    sourcePrivateIp: SOURCE_IP,
    targetPrivateIp: TARGET_IP,
    workloadPrivateIp: WORKLOAD_IP,
    appPublicIp: APP_IP,
    pgbouncerPublicIp: PGBOUNCER_IP,
    pgbouncerPrivateIp: PGBOUNCER_IP,
    sshKeyPath: keyPath,
  };
  publishSandboxState(state, workspacePath, problemId, logger);

  await waitForSsh(
    [
      [SOURCE_IP, "source"],
      [TARGET_IP, "target"],
      [PGBOUNCER_IP, "pgbouncer"],
      [WORKLOAD_IP, "workload"],
    ],
    keyPath,
    logger,
  );
  await waitForApp(logger);

  await validateSandbox(keyPath, logger);

  logger.info(`Writing api_endpoint=${APP_IP} and db_endpoint=${SOURCE_IP} on workload...`);
  await sshExec(
    WORKLOAD_IP,
    keyPath,
    `sudo bash -c 'echo "${APP_IP}" > /etc/hyperfocal/api_endpoint && echo "${SOURCE_IP}" > /etc/hyperfocal/db_endpoint'`,
  );
  await startWorkload(keyPath, logger);

  const workloadStartTime = new Date().toISOString();
  process.env.WORKLOAD_START_TIME = workloadStartTime;
  logger.info(`Workload start time: ${workloadStartTime}`);

  await plantCutoverFixtures(keyPath, logger);

  await setupGitea(logger);
  await setupGiteaRunner(keyPath, logger);
  await bootstrapGiteaRepo(logger);
  writeCicdCredentials(workspacePath, logger);
}

async function waitForApp(logger: Logger): Promise<void> {
  logger.info("Waiting for app /health (via pgbouncer -> source)...");
  await pollUntil(
    async () => {
      const r = await executeWithExitCode(
        `curl -sf http://${APP_IP}:${APP_PORT}/health`,
        { silent: true },
      );
      return r.exitCode === 0;
    },
    60_000,
    3_000,
    "app healthy",
  );
  logger.info("app service is healthy.");
}

async function validateSandbox(keyPath: string, logger: Logger): Promise<void> {
  logger.info("Validating sandbox state...");

  const pgReady = await sshExec(SOURCE_IP, keyPath, "pg_isready -h localhost");
  if (pgReady.exitCode !== 0) throw new Error(`Postgres not ready on source: ${pgReady.output}`);

  const countResult = await sshExec(
    SOURCE_IP,
    keyPath,
    `psql -h localhost -U postgres -tAc "SELECT count(*) FROM items"`,
  );
  if (countResult.exitCode !== 0) throw new Error(`Could not query items on source: ${countResult.output}`);
  const count = parseInt(countResult.output, 10);
  if (count !== SEED_ROW_COUNT) {
    throw new Error(`Seed data mismatch: expected ${SEED_ROW_COUNT} rows, found ${count}`);
  }
  logger.info(`Seed data confirmed: ${count} items.`);

  const pgBin = await sshExec(TARGET_IP, keyPath, "/usr/local/pgsql/bin/postgres --version");
  if (pgBin.exitCode !== 0) throw new Error(`Vanilla PG binary not found on target: ${pgBin.output}`);
  logger.info(`Target has vanilla PG: ${pgBin.output.trim()}`);

  // Confirm pgbouncer is reachable AND routing to source on boot.
  const bouncer = await sshExec(
    PGBOUNCER_IP,
    keyPath,
    `psql -h localhost -p 5432 -U pgbouncer pgbouncer -tAc "SHOW DATABASES"`,
  );
  if (bouncer.exitCode !== 0) throw new Error(`PgBouncer admin unreachable: ${bouncer.output}`);
  logger.info(`PgBouncer admin reachable; initial routing -> source.`);

  const wlCheck = await sshExec(
    WORKLOAD_IP,
    keyPath,
    "test -x /home/ec2-user/workload-check.sh && echo ok || echo missing",
  );
  if (wlCheck.output !== "ok") throw new Error("Workload scripts not found on workload container");
}

async function plantCutoverFixtures(keyPath: string, logger: Logger): Promise<void> {
  const walLevel = await sshExec(
    SOURCE_IP,
    keyPath,
    `psql -h localhost -U postgres -tAc "SHOW wal_level"`,
  );
  if (walLevel.output.trim() !== "logical") {
    logger.warn(`wal_level is '${walLevel.output.trim()}', expected 'logical'`);
  }

  // ── Plant stale replication slot fixture ────────────────────────────
  // Pre-create a logical replication slot on source to simulate leftover
  // state from a previous abandoned cutover. The runbook does not mention
  // this — `stale-replication-slot-cleaned` measures whether the agent's
  // pre-flight catches pre-existing state on source (a real cutover
  // starts with `SELECT * FROM pg_replication_slots`).
  //
  // `|| true` swallows the duplicate-name error if the slot already
  // exists from a prior setup run.
  logger.info("Planting stale replication slot fixture on source...");
  await sshExec(
    SOURCE_IP,
    keyPath,
    `psql -h localhost -U postgres -tAc ` +
      `"SELECT pg_create_logical_replication_slot('abandoned_cutover_slot', 'pgoutput')" 2>&1 || true`,
  );

  // ── Plant stale publication fixture ─────────────────────────────────
  // Same shape as the slot fixture, post-cutover side:
  // `publication-dropped-on-source` checks that source-cleanup catches
  // pre-existing publications, not just the agent's own.
  //
  // Named `abandoned_cutover_pub` to avoid colliding with the runbook's
  // recommended `pub` name — keeps the test about diagnostic skill, not
  // name-collision luck.
  logger.info("Planting stale publication fixture on source...");
  await sshExec(
    SOURCE_IP,
    keyPath,
    `psql -h localhost -U postgres -tAc ` +
      `"CREATE PUBLICATION abandoned_cutover_pub FOR ALL TABLES" 2>&1 || true`,
  );

  // ── Plant schema drift fixture on source ────────────────────────────
  // Add columns to source's `orders` AFTER seed, BEFORE the agent starts.
  // Target's vanilla initdb (via the deploy pipeline) creates `orders`
  // without these columns, so CREATE PUBLICATION/SUBSCRIPTION FOR ALL
  // TABLES fails silently with `column "..." does not exist` unless the
  // agent first does a schema dump.
  //
  // `schema-aligned-on-target` catches this. Hint placement varies
  // across runbook tiers — standard mentions schema-sync; sparse and
  // minimal don't.
  logger.info("Planting schema drift fixture on source (extra columns on orders)...");
  await sshExec(
    SOURCE_IP,
    keyPath,
    `psql -h localhost -U postgres -tAc ` +
      `"ALTER TABLE orders ` +
      `ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ, ` +
      `ADD COLUMN IF NOT EXISTS customer_segment TEXT, ` +
      `ADD COLUMN IF NOT EXISTS fulfillment_notes TEXT" 2>&1 || true`,
  );
}

async function setupGitea(logger: Logger): Promise<void> {
  logger.info("Waiting for Gitea...");
  await pollUntil(
    async () => {
      const r = await executeWithExitCode(
        `curl -sf http://${GITEA_IP}:3000/api/v1/version`,
        { silent: true },
      );
      return r.exitCode === 0;
    },
    120_000, 3_000, "Gitea healthy",
  );

  const create = await executeWithExitCode(
    `docker exec -u git ${GITEA_CONTAINER} gitea admin user create ` +
      `--username "${GITEA_ADMIN_USER}" --password "${GITEA_ADMIN_PASS}" ` +
      `--email admin@hyperfocal.dev --admin --must-change-password=false`,
    { silent: true },
  );
  if (create.exitCode !== 0 && !create.output.includes("already exists")) {
    throw new Error(`Gitea admin user create failed: ${create.output}`);
  }
  logger.info(`Gitea admin '${GITEA_ADMIN_USER}' ready.`);
}

async function setupGiteaRunner(keyPath: string, logger: Logger): Promise<void> {
  // Mount points referenced by sandbox/docker/cicd/runner-config.yaml must
  // exist on the host before the runner starts — act_runner skips any
  // -v source path that's missing.
  fs.mkdirSync(BUILD_HOST_DIR, { recursive: true });
  fs.copyFileSync(keyPath, DEPLOY_KEY_HOST_PATH);
  fs.chmodSync(DEPLOY_KEY_HOST_PATH, 0o600);

  const tokenResult = await executeWithExitCode(
    `docker exec -u git ${GITEA_CONTAINER} gitea actions generate-runner-token`,
    { silent: true },
  );
  if (tokenResult.exitCode !== 0) {
    throw new Error(`Could not generate runner token: ${tokenResult.output}`);
  }
  const token = tokenResult.output.trim().split("\n").pop()!.trim();

  await dockerCompose("stop gitea-runner", { silent: true }).catch(() => {});
  await dockerCompose("rm -f gitea-runner", { silent: true }).catch(() => {});
  await execute(
    `GITEA_RUNNER_TOKEN="${token}" docker-compose -f "${path.join(COMPOSE_DIR, "docker-compose.yml")}" up -d gitea-runner`,
    { silent: false },
  );

  await pollUntil(
    async () => {
      const r = await executeWithExitCode(
        `docker ps --filter "name=hyperfocal-gitea-runner" --format "{{.Status}}"`,
        { silent: true },
      );
      return r.exitCode === 0 && r.output.startsWith("Up");
    },
    60_000, 3_000, "gitea-runner container running",
  );
  // Give the runner a beat to register with Gitea before we push commits.
  await sleep(5_000);
  logger.info("Gitea runner registered.");
}

async function bootstrapGiteaRepo(logger: Logger): Promise<void> {
  const giteaApi = (method: string, route: string, body?: string) =>
    executeWithExitCode(
      `curl -sf -X ${method} -H 'Content-Type: application/json' ` +
        `-u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" ` +
        `"http://${GITEA_IP}:3000/api/v1${route}"` +
        (body ? ` -d '${body}'` : ""),
      { silent: true },
    );

  const exists = await giteaApi("GET", `/repos/${GITEA_ADMIN_USER}/${DEPLOY_REPO}`);
  if (exists.exitCode !== 0) {
    const created = await giteaApi(
      "POST", "/user/repos",
      `{"name":"${DEPLOY_REPO}","auto_init":false,"private":false}`,
    );
    if (created.exitCode !== 0) {
      throw new Error(`Could not create ${DEPLOY_REPO} repo: ${created.output}`);
    }
    logger.info(`Created Gitea repo ${GITEA_ADMIN_USER}/${DEPLOY_REPO}.`);
  }

  const seedDir = path.resolve(COMPOSE_DIR, "cicd", "pg-deploy");
  const workDir = fs.mkdtempSync("/tmp/pg-deploy-seed-");
  try {
    await execute(`cp -r "${seedDir}/." "${workDir}/"`, { silent: true });
    const remote = `http://${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}@${GITEA_IP}:3000/${GITEA_ADMIN_USER}/${DEPLOY_REPO}.git`;
    await execute(
      `cd "${workDir}" && git init -b main && ` +
        `git config user.email admin@hyperfocal.dev && git config user.name hyperfocal && ` +
        `git add -A && git commit -m "Initial commit: deployment pipeline" && ` +
        `git remote add origin "${remote}" && git push -f origin main`,
      { silent: false },
    );
  } finally {
    await execute(`rm -rf "${workDir}"`, { silent: true });
  }
  logger.info(`Seeded ${DEPLOY_REPO} with deploy.yml + regression-tests/ skeleton.`);
}

function writeCicdCredentials(workspacePath: string, logger: Logger): void {
  const dir = path.join(workspacePath, ".hyperfocal");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cicd-credentials.env");
  fs.writeFileSync(
    file,
    [
      `GITEA_URL=http://${GITEA_IP}:3000`,
      `GITEA_USER=${GITEA_ADMIN_USER}`,
      `GITEA_PASS=${GITEA_ADMIN_PASS}`,
      `GITEA_REPO=${GITEA_ADMIN_USER}/${DEPLOY_REPO}`,
      ``,
    ].join("\n"),
    { mode: 0o644 },
  );
  logger.info(`CI/CD credentials written to ${file}`);
}

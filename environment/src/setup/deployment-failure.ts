import * as fs from "fs";
import * as path from "path";
import { execute, executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger } from "@hyperfocal/env-base";
import { dockerCompose, COMPOSE_DIR } from "../clients/docker.js";
import { sshExec } from "../clients/ssh.js";
import { pollUntil, sleep } from "../clients/poll.js";
import {
  APP_IP,
  APP_PORT,
  GITEA_ADMIN_PASS,
  GITEA_ADMIN_USER,
  GITEA_IP,
  GITEA_REPO_NAME,
  SOURCE_CONTAINER,
  SOURCE_IP,
  WORKLOAD_CONTAINER,
  WORKLOAD_IP,
  type SandboxState,
} from "../config.js";
import { injectSshKey } from "./keys.js";
import { publishSandboxState, resetWorkspaceTree } from "./scaffold.js";
import { startWorkload, waitForSsh } from "./workload.js";

export async function setupDeploymentFailure(
  logger: Logger,
  workspacePath: string,
  keyPath: string,
  problemId?: string,
): Promise<void> {
  await resetWorkspaceTree(workspacePath, logger);

  const services = "source pgbouncer app workload postgres-exporter prometheus grafana gitea";
  logger.info("Building Docker images for deployment-failure task...");
  await dockerCompose(
    "build source pgbouncer app workload",
    { silent: false, timeout: 10 * 60 * 1000 },
  );

  logger.info("Starting containers...");
  await dockerCompose(`up -d ${services}`, { silent: false });

  logger.info("Waiting for source to seed data (~45s for 3M rows)...");
  await sleep(45_000);

  logger.info("Waiting for app service...");
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

  logger.info("Waiting for Gitea...");
  await pollUntil(
    async () => {
      const r = await executeWithExitCode(
        `curl -sf http://${GITEA_IP}:3000/api/v1/version`,
        { silent: true },
      );
      return r.exitCode === 0;
    },
    60_000,
    3_000,
    "Gitea healthy",
  );
  logger.info("Gitea is healthy.");

  logger.info("Running CI/CD initialization script...");
  const initScript = path.resolve(COMPOSE_DIR, "cicd", "init-cicd.sh");
  await execute(`bash "${initScript}"`, { silent: false, timeout: 10 * 60 * 1000 });
  logger.info("CI/CD initialization complete.");

  await injectSshKey(keyPath, [SOURCE_CONTAINER, WORKLOAD_CONTAINER], logger);

  const state: SandboxState = {
    sourceInstanceId: SOURCE_CONTAINER,
    targetInstanceId: "",
    workloadInstanceId: WORKLOAD_CONTAINER,
    sourcePublicIp: SOURCE_IP,
    targetPublicIp: "",
    workloadPublicIp: WORKLOAD_IP,
    sourcePrivateIp: SOURCE_IP,
    targetPrivateIp: "",
    workloadPrivateIp: WORKLOAD_IP,
    sshKeyPath: keyPath,
  };
  publishSandboxState(state, workspacePath, problemId, logger);

  await waitForSsh(
    [[SOURCE_IP, "source"], [WORKLOAD_IP, "workload"]],
    keyPath,
    logger,
  );

  logger.info(`Writing api_endpoint -> ${APP_IP}...`);
  await sshExec(
    WORKLOAD_IP,
    keyPath,
    `sudo bash -c 'echo "${APP_IP}" > /etc/hyperfocal/api_endpoint && echo "${SOURCE_IP}" > /etc/hyperfocal/db_endpoint'`,
  );
  await startWorkload(keyPath, logger);

  logger.info("Verifying CI/CD pipeline status...");
  const statusResult = await executeWithExitCode(
    `curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" "http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/commits/main/status"`,
    { silent: true },
  );
  if (statusResult.exitCode === 0) {
    const data = JSON.parse(statusResult.output);
    logger.info(`Pipeline state: ${data.state}`);
  }

  if (problemId && problemId.startsWith("deployment-failure")) {
    await applyDeploymentFailurePerturbation(problemId, logger);
  }
}

async function applyDeploymentFailurePerturbation(
  problemId: string,
  logger: Logger,
): Promise<void> {
  const variant = problemId.replace("deployment-failure-", "");
  const variantDir = path.resolve(COMPOSE_DIR, "cicd", "variants", variant);

  if (!fs.existsSync(variantDir)) {
    throw new Error(`Variant directory not found: ${variantDir}`);
  }

  const migrationFiles = fs
    .readdirSync(variantDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  logger.info(`Applying ${variant} perturbation, ${migrationFiles.length} migration(s): ${migrationFiles.join(", ")}`);

  const cloneDir = "/tmp/hf-perturbation";
  await execute(
    `rm -rf "${cloneDir}" && git clone "http://${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}@${GITEA_IP}:3000/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}.git" "${cloneDir}"`,
    { silent: true, timeout: 30_000 },
  );

  await execute(
    `cd "${cloneDir}" && git config user.email "admin@hyperfocal.dev" && git config user.name "hyperfocal"`,
    { silent: true },
  );

  for (const migFile of migrationFiles) {
    const content = fs.readFileSync(path.join(variantDir, migFile), "utf-8");
    const destPath = path.join(cloneDir, "migrations", migFile);
    fs.writeFileSync(destPath, content);

    const firstComment =
      content.split("\n").find((l) => l.startsWith("-- Migration"))?.replace("-- ", "") ?? migFile;
    await execute(
      `cd "${cloneDir}" && git add "migrations/${migFile}" && git commit -m "${firstComment.replace(/"/g, '\\"')}"`,
      { silent: true },
    );
    logger.info(`Committed: ${migFile}`);
  }

  await execute(
    `cd "${cloneDir}" && git push origin main`,
    { silent: false, timeout: 60_000 },
  );
  await execute(`rm -rf "${cloneDir}"`, { silent: true });

  logger.info("Bad migration(s) pushed. Waiting for pipeline to apply them...");
  await pollUntil(
    async () => {
      const r = await executeWithExitCode(
        `curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" "http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/commits/main/status"`,
        { silent: true },
      );
      if (r.exitCode !== 0) return false;
      const d = JSON.parse(r.output);
      return d.state === "success" || d.state === "failure";
    },
    5 * 60_000,
    10_000,
    "Pipeline with bad migration(s)",
  );

  await sleep(5_000);
  const totalsResult = await executeWithExitCode(
    `curl -sf "http://${APP_IP}:${APP_PORT}/orders/totals?customer_id=1"`,
    { silent: true },
  );
  if (totalsResult.exitCode === 0) {
    const totals = JSON.parse(totalsResult.output);
    const gross = parseFloat(totals.gross_total);
    const net = parseFloat(totals.net_total);
    if (Math.abs(gross - net) > gross * 0.01 || gross > 4_000_000_000) {
      logger.info(`Perturbation confirmed: gross=${gross}, net=${net}`);
    } else {
      logger.warn("Perturbation may not have been applied correctly");
    }
  }
}

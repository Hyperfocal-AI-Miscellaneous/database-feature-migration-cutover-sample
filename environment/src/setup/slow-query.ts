import { executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger } from "@hyperfocal/env-base";
import { dockerCompose } from "../clients/docker.js";
import { sshExec } from "../clients/ssh.js";
import { pollUntil, sleep } from "../clients/poll.js";
import {
  APP_IP,
  APP_PORT,
  GRAFANA_IP,
  PROMETHEUS_IP,
  SOURCE_CONTAINER,
  SOURCE_IP,
  WORKLOAD_CONTAINER,
  WORKLOAD_IP,
  type SandboxState,
} from "../config.js";
import { injectSshKey } from "./keys.js";
import { publishSandboxState, resetWorkspaceTree } from "./scaffold.js";
import { startWorkload, waitForSsh } from "./workload.js";

export async function setupSlowQuery(
  logger: Logger,
  workspacePath: string,
  keyPath: string,
  problemId?: string,
): Promise<void> {
  await resetWorkspaceTree(workspacePath, logger);

  const services = [
    "source",
    "pgbouncer",
    "app",
    "workload",
    "postgres-exporter",
    "prometheus",
    "grafana",
  ];
  logger.info("Building Docker images for slow-query task...");
  await dockerCompose("build source pgbouncer app workload", {
    silent: false,
    timeout: 10 * 60 * 1000,
  });

  logger.info("Starting containers...");
  await dockerCompose(`up -d ${services.join(" ")}`, { silent: false });

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
  logger.info("API service is healthy.");

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

  logger.info("Validating sandbox state...");

  const pgReady = await sshExec(SOURCE_IP, keyPath, "pg_isready -h localhost");
  if (pgReady.exitCode !== 0) {
    throw new Error(`Postgres not ready on source: ${pgReady.output}`);
  }
  logger.info("Postgres is accepting connections on source.");

  const countResult = await sshExec(
    SOURCE_IP,
    keyPath,
    `psql -h localhost -U postgres -tAc "SELECT count(*) FROM items"`,
  );
  if (countResult.exitCode !== 0) {
    throw new Error(`Could not query items on source: ${countResult.output}`);
  }
  logger.info(`Seed data confirmed: ${countResult.output.trim()} items.`);

  logger.info("Waiting for observability stack...");
  await pollUntil(
    async () => {
      const r = await executeWithExitCode(
        `curl -sf http://${PROMETHEUS_IP}:9090/-/healthy`,
        { silent: true },
      );
      return r.exitCode === 0;
    },
    60_000,
    3_000,
    "Prometheus healthy",
  );
  logger.info("Prometheus is healthy.");

  await pollUntil(
    async () => {
      const r = await executeWithExitCode(
        `curl -sf http://${GRAFANA_IP}:3000/api/health`,
        { silent: true },
      );
      return r.exitCode === 0;
    },
    60_000,
    3_000,
    "Grafana healthy",
  );
  logger.info("Grafana is healthy.");

  logger.info(`Writing api_endpoint=${APP_IP} and db_endpoint=${SOURCE_IP} on workload...`);
  await sshExec(
    WORKLOAD_IP,
    keyPath,
    `sudo bash -c 'echo "${APP_IP}" > /etc/hyperfocal/api_endpoint && echo "${SOURCE_IP}" > /etc/hyperfocal/db_endpoint'`,
  );

  await startWorkload(keyPath, logger);

  logger.info("Resetting pg_stat_statements...");
  await sshExec(
    SOURCE_IP,
    keyPath,
    `psql -h localhost -U postgres -c "SELECT pg_stat_statements_reset()"`,
  );

  logger.info("Waiting for workload queries to appear in pg_stat_statements...");
  await pollUntil(
    async () => {
      const r = await sshExec(
        SOURCE_IP,
        keyPath,
        `psql -h localhost -U postgres -tAc "SELECT count(*) FROM pg_stat_statements WHERE query LIKE '%orders%customer_id%'"`,
      );
      return r.exitCode === 0 && parseInt(r.output.trim(), 10) > 0;
    },
    60_000,
    5_000,
    "slow query visible in pg_stat_statements",
  );
  logger.info("Slow query is being tracked in pg_stat_statements.");

  logger.info("Waiting for API metrics in Prometheus...");
  await pollUntil(
    async () => {
      const r = await executeWithExitCode(
        `curl -sf 'http://${PROMETHEUS_IP}:9090/api/v1/query?query=api_request_duration_seconds_count'`,
        { silent: true },
      );
      if (r.exitCode !== 0) return false;
      const data = JSON.parse(r.output);
      return data?.data?.result?.length > 0;
    },
    60_000,
    5_000,
    "API metrics in Prometheus",
  );
  logger.info("API metrics are being collected by Prometheus.");
}

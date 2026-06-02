import * as fs from "fs";
import * as path from "path";
import { execute, executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger } from "@hyperfocal/env-base";
import {
  APP_IP,
  APP_PORT,
  DEPLOY_REPO,
  GITEA_IP,
  GITEA_ADMIN_USER,
  GITEA_ADMIN_PASS,
  GITEA_REPO_NAME,
  GRAFANA_IP,
  PG_VERSION,
  PROMETHEUS_IP,
  type SandboxState,
} from "../config.js";

export function isSlowQueryProblem(problemId?: string): boolean {
  return !!problemId && problemId.startsWith("slow-query");
}

export function isDeploymentFailureProblem(problemId?: string): boolean {
  return !!problemId && problemId.startsWith("deployment-failure");
}

export function publishSandboxState(
  state: SandboxState,
  workspacePath: string,
  problemId: string | undefined,
  logger: Logger,
): void {
  process.env.SOURCE_INSTANCE_ID = state.sourceInstanceId;
  process.env.TARGET_INSTANCE_ID = state.targetInstanceId;
  process.env.WORKLOAD_INSTANCE_ID = state.workloadInstanceId;
  process.env.SOURCE_PUBLIC_IP = state.sourcePublicIp;
  process.env.TARGET_PUBLIC_IP = state.targetPublicIp;
  process.env.WORKLOAD_PUBLIC_IP = state.workloadPublicIp;
  process.env.SOURCE_PRIVATE_IP = state.sourcePrivateIp;
  process.env.TARGET_PRIVATE_IP = state.targetPrivateIp;
  process.env.WORKLOAD_PRIVATE_IP = state.workloadPrivateIp;
  process.env.SSH_KEY_PATH = state.sshKeyPath;
  if (state.appPublicIp) process.env.APP_PUBLIC_IP = state.appPublicIp;
  if (state.pgbouncerPublicIp) process.env.PGBOUNCER_PUBLIC_IP = state.pgbouncerPublicIp;
  if (state.pgbouncerPrivateIp) process.env.PGBOUNCER_PRIVATE_IP = state.pgbouncerPrivateIp;

  if (problemId && DISCOVERY_PROBLEMS.includes(problemId)) {
    logger.info(`Problem '${problemId}' requires discovery, skipping .sandbox-connection.env`);
    return;
  }

  const connFile = path.join(workspacePath, ".sandbox-connection.env");
  fs.writeFileSync(connFile, renderEnvFile(buildConnectionEnv(problemId, state)), { mode: 0o644 });
  logger.info(`Connection metadata written to ${connFile}`);
}

/** Reset `workspace/` to its committed state. */
export async function resetWorkspaceTree(workspacePath: string, logger: Logger): Promise<void> {
  await execute(`git -C "${workspacePath}" restore .`, { silent: true });
  await execute(
    `git -C "${workspacePath}" clean -fd ` +
      `-e hyperfocal-key.pem -e hyperfocal-key.pem.pub ` +
      `-e .sandbox-connection.env -e .agent-prompt.txt -e .hyperfocal`,
    { silent: true },
  );

  const pgSrcDir = path.join(workspacePath, "postgres-src");
  if (!fs.existsSync(path.join(pgSrcDir, "configure"))) {
    throw new Error(
      `workspace/postgres-src/configure missing after reset, workspace tree is corrupt. ` +
        `Re-extract postgresql-${PG_VERSION}.tar.gz into ${pgSrcDir} and commit.`,
    );
  }
  logger.info("Workspace reset to committed state (postgres-src restored).");
}

export async function installHostBuildDeps(logger: Logger): Promise<void> {
  const probe = await executeWithExitCode(
    "command -v gcc && command -v make && command -v flex && command -v bison",
    { silent: true },
  );
  if (probe.exitCode === 0) {
    logger.info("Build dependencies already present on host, skipping dnf install.");
    return;
  }

  logger.info("Installing build dependencies on host...");
  const result = await executeWithExitCode(
    "dnf install -y gcc make readline-devel zlib-devel flex bison perl openssl-devel libicu-devel patch",
    { silent: true },
  );
  if (result.exitCode !== 0) {
    logger.warn(`Build deps install returned exit ${result.exitCode}: ${result.output}`);
  }
  logger.info("Build dependencies installed on host.");
}

const DISCOVERY_PROBLEMS = ["pg-cutover-realistic", "pg-cutover-minimal"];

interface EnvSection {
  heading?: string;
  entries: Array<[string, string]>;
}

const apiSection = (): EnvSection => ({
  heading: "App service",
  entries: [["APP_URL", `http://${APP_IP}:${APP_PORT}`]],
});

const dbSection = (state: SandboxState): EnvSection => ({
  heading: "Database (PostgreSQL)",
  entries: [
    ["SOURCE_IP", state.sourcePublicIp],
    ["SOURCE_CONTAINER", state.sourceInstanceId],
  ],
});

const observabilitySection = (): EnvSection => ({
  heading: "Observability",
  entries: [
    ["GRAFANA_URL", `http://${GRAFANA_IP}:3000`],
    ["PROMETHEUS_URL", `http://${PROMETHEUS_IP}:9090`],
  ],
});

const cicdSection = (): EnvSection => ({
  heading: "CI/CD (Gitea + Actions)",
  entries: [
    ["GITEA_URL", `http://${GITEA_IP}:3000`],
    ["GITEA_USER", GITEA_ADMIN_USER],
    ["GITEA_PASS", GITEA_ADMIN_PASS],
    ["GITEA_REPO", `${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}`],
  ],
});

const sshSection = (withUser: boolean): EnvSection => ({
  heading: "SSH access",
  entries: [
    ["SSH_KEY_PATH", "./hyperfocal-key.pem"],
    ...(withUser ? [["SSH_USER", "ec2-user"] as [string, string]] : []),
  ],
});

function buildConnectionEnv(
  problemId: string | undefined,
  state: SandboxState,
): EnvSection[] {
  if (isDeploymentFailureProblem(problemId)) {
    const sections: EnvSection[] = [apiSection(), dbSection(state)];
    if (problemId !== "deployment-failure-minimal") sections.push(cicdSection());
    sections.push(observabilitySection(), sshSection(true));
    return sections;
  }

  if (isSlowQueryProblem(problemId)) {
    return [apiSection(), dbSection(state), observabilitySection(), sshSection(true)];
  }

  return [
    {
      heading: "Container IPs on the hyperfocal Docker network",
      entries: [
        ["SOURCE_IP", state.sourcePublicIp],
        ["TARGET_IP", state.targetPublicIp],
        ["WORKLOAD_IP", state.workloadPublicIp],
        ["APP_URL", `http://${state.appPublicIp ?? APP_IP}:${APP_PORT}`],
        ["PGBOUNCER_IP", state.pgbouncerPublicIp ?? ""],
      ],
    },
    {
      heading: "Container names",
      entries: [
        ["SOURCE_CONTAINER", state.sourceInstanceId],
        ["TARGET_CONTAINER", state.targetInstanceId],
        ["WORKLOAD_CONTAINER", state.workloadInstanceId],
        ["PGBOUNCER_CONTAINER", "hyperfocal-pgbouncer"],
      ],
    },
    {
      heading: "CI/CD (Gitea) — full creds in .hyperfocal/cicd-credentials.env",
      entries: [
        ["GITEA_URL", `http://${GITEA_IP}:3000`],
        ["GITEA_REPO", `${GITEA_ADMIN_USER}/${DEPLOY_REPO}`],
      ],
    },
    { entries: [["SSH_KEY_PATH", "./hyperfocal-key.pem"]] },
  ];
}

function renderEnvFile(sections: EnvSection[]): string {
  const lines: string[] = [];
  for (const { heading, entries } of sections) {
    if (heading) lines.push(`# ${heading}`);
    for (const [k, v] of entries) lines.push(`${k}=${v}`);
  }
  lines.push("");
  return lines.join("\n");
}

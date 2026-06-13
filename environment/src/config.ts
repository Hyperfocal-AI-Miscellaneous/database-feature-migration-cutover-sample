export const PG_VERSION = "17.4";

export const SEED_ROW_COUNT = 1000;

export const ORDERS_ROW_COUNT = 3_000_000;

export const DOCKER_NETWORK = "hyperfocal";
export const SOURCE_IP = "172.20.0.10";
export const TARGET_IP = "172.20.0.11";
export const WORKLOAD_IP = "172.20.0.12";
export const SOURCE_CONTAINER = "hyperfocal-source";
export const TARGET_CONTAINER = "hyperfocal-target";
export const WORKLOAD_CONTAINER = "hyperfocal-workload";

export const CONTAINER_READY_TIMEOUT_MS = 5 * 60 * 1000;
export const SSH_READY_TIMEOUT_MS = 2 * 60 * 1000;
export const BOOTSTRAP_TIMEOUT_MS = 30 * 60 * 1000;
export const POLL_INTERVAL_MS = 5 * 1000;

export const APP_IP = "172.20.0.13";
export const APP_CONTAINER = "hyperfocal-app";
export const APP_PORT = 8080;

export const PGBOUNCER_IP = "172.20.0.14";
export const PGBOUNCER_CONTAINER = "hyperfocal-pgbouncer";

export const GITEA_IP = "172.20.0.30";
export const GITEA_RUNNER_IP = "172.20.0.31";
export const GITEA_CONTAINER = "hyperfocal-gitea";
export const GITEA_RUNNER_CONTAINER = "hyperfocal-gitea-runner";
export const GITEA_ADMIN_USER = "hyperfocal";
export const GITEA_ADMIN_PASS = "hyperfocal123";
export const DEPLOY_REPO     = "pg-deploy";

export const PROJECT_TAG = "hyperfocal";

export const MAX_DOWNTIME_SECS = 15;

/**
 * Maximum acceptable HTTP error rate (percent) over any single
 * ERROR_RATE_WINDOW_SECS window in the workload log. Rate-based rather
 * than absolute so long rollouts aren't penalised for sporadic blips.
 */
export const MAX_WORKLOAD_ERROR_RATE_PCT = 2.0;
export const ERROR_RATE_WINDOW_SECS = 30;

export const RUBRIC_JUDGE_MODEL =
  process.env.RUBRIC_JUDGE_MODEL ?? "openai/gpt-5.4-mini";

/** Sandbox state populated by setupProblem and read from env at test time. */
export interface SandboxState {
  sourceInstanceId: string;
  targetInstanceId: string;
  workloadInstanceId: string;
  sourcePublicIp: string;
  targetPublicIp: string;
  workloadPublicIp: string;
  sourcePrivateIp: string;
  targetPrivateIp: string;
  workloadPrivateIp: string;
  sshKeyPath: string;
  appPublicIp: string;
  pgbouncerPublicIp: string;
  pgbouncerPrivateIp: string;
}

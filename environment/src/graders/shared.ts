import { executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger, SimpleTestResult } from "@hyperfocal/env-base";
import {
  GITEA_IP,
  GITEA_ADMIN_USER,
  GITEA_ADMIN_PASS,
  DEPLOY_REPO,
} from "../config.js";
import { sshExec } from "../clients/ssh.js";

export function getRequiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

/**
 * Shared preamble for the workload-log analysis scripts. Loads
 * /var/log/hyperfocal/workload.jsonl, prints sentinel + exits if missing or
 * empty. Downstream code may assume `lines` is a non-empty list.
 */
export const PY_LOAD_WORKLOAD_LOG = `
import json, sys
from datetime import datetime

try:
    lines = open("/var/log/hyperfocal/workload.jsonl").readlines()
except FileNotFoundError:
    print("NO_LOG"); sys.exit(0)

if not lines:
    print("EMPTY_LOG"); sys.exit(0)
`;

/**
 * Query the PgBouncer admin interface and return the configured host for
 * the 'postgres' database. `SHOW DATABASES` is pipe-separated under -tA:
 *   name|host|port|database|...
 */
export async function pgbouncerRoutingHost(): Promise<string | null> {
  const keyPath = getRequiredEnv("SSH_KEY_PATH");
  const pgbouncerIp = getRequiredEnv("PGBOUNCER_PUBLIC_IP");
  const result = await sshExec(
    pgbouncerIp, keyPath,
    `psql -h localhost -p 5432 -U pgbouncer pgbouncer -tAc "SHOW DATABASES"`,
  );
  if (result.exitCode !== 0) return null;
  for (const line of result.output.split("\n")) {
    const fields = line.split("|");
    if (fields[0]?.trim() === "postgres") return fields[1]?.trim() ?? null;
  }
  return null;
}

/**
 * Gate for post-cutover tests. Without this gate, app-healthy / workload-
 * succeeds / downtime pass spuriously when the agent does nothing — the
 * app stays healthy because pgbouncer is still routing to the original
 * source. These tests measure post-cutover behaviour; if the cutover
 * didn't happen, the result is undefined and the test fails by default.
 */
export async function assertCutoverHappened(): Promise<SimpleTestResult | null> {
  const targetPrivateIp = getRequiredEnv("TARGET_PRIVATE_IP");
  const host = await pgbouncerRoutingHost();
  if (host === null) {
    return {
      success: false,
      error: "Cutover precondition not met: PgBouncer admin unreachable; cannot confirm routing destination.",
    };
  }
  if (host !== targetPrivateIp) {
    return {
      success: false,
      error:
        `Cutover precondition not met: PgBouncer still routes to '${host}' ` +
        `(expected target '${targetPrivateIp}'). No cutover has happened.`,
    };
  }
  return null;
}

export interface AgentTestFile { name: string; content: string }

/**
 * Returns null on transport error (so the caller can distinguish "API broken"
 * from "no tests"). An empty array means the regression-tests/ directory
 * exists but contains no .sql files.
 */
export async function fetchAgentRegressionTests(logger: Logger): Promise<AgentTestFile[] | null> {
  const auth = `${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}`;
  const apiBase = `http://${auth}@${GITEA_IP}:3000`;
  const repo = `${GITEA_ADMIN_USER}/${DEPLOY_REPO}`;
  const list = await executeWithExitCode(
    `curl -sf "${apiBase}/api/v1/repos/${repo}/contents/regression-tests?ref=main"`,
    { silent: true },
  );
  if (list.exitCode !== 0) {
    logger.warn(`fetchAgentRegressionTests: list failed (exit ${list.exitCode}): ${list.output.slice(0, 200)}`);
    if (list.output.includes("Not Found") || list.output.includes("404")) return [];
    return null;
  }
  let entries: Array<{ name: string; type: string }>;
  try { entries = JSON.parse(list.output); }
  catch { return null; }
  const out: AgentTestFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".sql")) continue;
    const raw = await executeWithExitCode(
      `curl -sf "${apiBase}/${repo}/raw/branch/main/regression-tests/${entry.name}"`,
      { silent: true },
    );
    if (raw.exitCode !== 0) {
      logger.warn(`Could not fetch ${entry.name}: ${raw.output.slice(0, 200)}`);
      continue;
    }
    out.push({ name: entry.name, content: raw.output });
  }
  return out;
}

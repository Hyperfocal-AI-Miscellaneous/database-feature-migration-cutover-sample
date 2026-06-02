import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { executeWithExitCode } from "@hyperfocal/env-base";
import {
  APP_IP,
  APP_PORT,
  SEED_ROW_COUNT,
  MAX_DOWNTIME_SECS,
  MAX_WORKLOAD_ERROR_RATE_PCT,
  ERROR_RATE_WINDOW_SECS,
  GITEA_IP,
  GITEA_ADMIN_USER,
  GITEA_ADMIN_PASS,
  DEPLOY_REPO,
} from "../../config.js";
import { sshExec } from "../../clients/ssh.js";
import { sourcePsql, targetPsql } from "../../clients/psql.js";
import { createCodeRubricTests } from "./code-rubric.js";
import { createRegressionRubricTests } from "./regression-rubric.js";

/**
 * Shared preamble for the workload-log analysis scripts. Loads
 * /var/log/hyperfocal/workload.jsonl, prints sentinel + exits if missing or
 * empty. Downstream code may assume `lines` is a non-empty list.
 */
const PY_LOAD_WORKLOAD_LOG = `
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
async function pgbouncerRoutingHost(): Promise<string | null> {
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
async function assertCutoverHappened(): Promise<SimpleTestResult | null> {
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

interface AgentTestFile { name: string; content: string }

/**
 * Returns null on transport error (so the caller can distinguish "API broken"
 * from "no tests"). An empty array means the regression-tests/ directory
 * exists but contains no .sql files.
 */
async function fetchAgentRegressionTests(logger: Logger): Promise<AgentTestFile[] | null> {
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

const deterministicTests: SimpleTest[] = [
  {
    id: "candidate-pg-running",
    name: "New Postgres is running on target EC2",
    weight: 0.5,
    description: "pg_isready returns 0 on the target EC2",
    run: async (_logger: Logger): Promise<SimpleTestResult> => {
      const keyPath = getRequiredEnv("SSH_KEY_PATH");
      const targetIp = getRequiredEnv("TARGET_PUBLIC_IP");

      const { exitCode, output } = await sshExec(targetIp, keyPath, "/usr/local/pgsql/bin/pg_isready -h localhost");
      if (exitCode !== 0) {
        return { success: false, error: `pg_isready failed (exit ${exitCode}): ${output}` };
      }
      return { success: true };
    },
  },

  {
    id: "patched-binary-present",
    name: "Postgres binary carries the -hyperfocal version suffix",
    description: "postgres --version output on target EC2 contains '-hyperfocal'",
    run: async (_logger: Logger): Promise<SimpleTestResult> => {
      const keyPath = getRequiredEnv("SSH_KEY_PATH");
      const targetIp = getRequiredEnv("TARGET_PUBLIC_IP");

      const { exitCode, output } = await sshExec(targetIp, keyPath, "/usr/local/pgsql/bin/postgres --version");
      if (exitCode !== 0) {
        return { success: false, error: `postgres --version failed (exit ${exitCode}): ${output}` };
      }
      if (!output.includes("-hyperfocal")) {
        return { success: false, error: `Version string does not contain '-hyperfocal': ${output}` };
      }
      return { success: true };
    },
  },

  {
    id: "timing-fields-exist",
    name: "Timing columns exist in pg_stat_all_tables",
    weight: 2,
    description: "SELECT total_vacuum_time, total_autovacuum_time, total_analyze_time, total_autoanalyze_time succeeds",
    run: async (_logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await targetPsql(
        "SELECT total_vacuum_time, total_autovacuum_time, total_analyze_time, total_autoanalyze_time FROM pg_stat_all_tables LIMIT 1"
      );
      if (exitCode !== 0) {
        return { success: false, error: `Query failed, columns may not exist (exit ${exitCode}): ${output}` };
      }
      return { success: true };
    },
  },

  {
    id: "view-inheritance",
    name: "Derived views (pg_stat_user_tables, pg_stat_sys_tables) inherit timing columns",
    weight: 1,
    description: "Timing columns are queryable in pg_stat_user_tables and pg_stat_sys_tables",
    run: async (_logger: Logger): Promise<SimpleTestResult> => {
      const userView = await targetPsql(
        "SELECT total_vacuum_time FROM pg_stat_user_tables LIMIT 1"
      );
      if (userView.exitCode !== 0) {
        return { success: false, error: `pg_stat_user_tables missing timing columns: ${userView.output}` };
      }

      const sysView = await targetPsql(
        "SELECT total_vacuum_time FROM pg_stat_sys_tables LIMIT 1"
      );
      if (sysView.exitCode !== 0) {
        return { success: false, error: `pg_stat_sys_tables missing timing columns: ${sysView.output}` };
      }

      return { success: true };
    },
  },

  {
    id: "vacuum-timing-accurate",
    name: "Manual VACUUM timing column accumulates correctly",
    weight: 3,
    description: "VACUUM twice, verify total_vacuum_time increases each time by a consistent amount",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await targetPsql(
        `CREATE TABLE IF NOT EXISTS _hf_vacuum_test (id serial, data text);
INSERT INTO _hf_vacuum_test (data) SELECT md5(i::text) FROM generate_series(1, 5000) s(i);
VACUUM _hf_vacuum_test;
SELECT pg_stat_force_next_flush();
SELECT pg_sleep(0.5);
SELECT total_vacuum_time FROM pg_stat_user_tables WHERE relname = '_hf_vacuum_test';
INSERT INTO _hf_vacuum_test (data) SELECT md5(i::text) FROM generate_series(1, 5000) s(i);
VACUUM _hf_vacuum_test;
SELECT pg_stat_force_next_flush();
SELECT pg_sleep(0.5);
SELECT total_vacuum_time FROM pg_stat_user_tables WHERE relname = '_hf_vacuum_test';
DROP TABLE _hf_vacuum_test;`
      );

      if (exitCode !== 0) {
        return { success: false, error: `Vacuum timing test failed (exit ${exitCode}): ${output}` };
      }

      const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
      const timeValues = lines.map(l => parseFloat(l)).filter(v => !isNaN(v) && v >= 0);

      if (timeValues.length < 2) {
        return { success: false, error: `Expected 2 timing values, got ${timeValues.length} from: ${output}` };
      }

      const t1 = timeValues[timeValues.length - 2];
      const t2 = timeValues[timeValues.length - 1];

      logger.info(`total_vacuum_time: after 1st VACUUM = ${t1}ms, after 2nd VACUUM = ${t2}ms`);

      if (t1 <= 0) {
        return { success: false, error: `total_vacuum_time after first VACUUM is ${t1}, expected > 0` };
      }

      if (t2 <= t1) {
        return { success: false, error: `total_vacuum_time did not increase after second VACUUM: ${t1}ms -> ${t2}ms` };
      }

      const delta1 = t1;
      const delta2 = t2 - t1;
      const ratio = delta2 / delta1;
      logger.info(`Vacuum time increments: 1st = ${delta1.toFixed(2)}ms, 2nd = ${delta2.toFixed(2)}ms, ratio = ${ratio.toFixed(2)}`);

      if (ratio < 0.1 || ratio > 10) {
        return {
          success: false,
          error: `Vacuum time increments are inconsistent: ${delta1.toFixed(2)}ms vs ${delta2.toFixed(2)}ms (ratio ${ratio.toFixed(2)}, expected 0.1-10x)`,
        };
      }

      return { success: true };
    },
  },

  {
    id: "analyze-timing-accurate",
    name: "Manual ANALYZE timing column accumulates correctly",
    weight: 3,
    description: "ANALYZE twice, verify total_analyze_time increases each time by a consistent amount",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await targetPsql(
        `CREATE TABLE IF NOT EXISTS _hf_analyze_test (id serial, data text);
INSERT INTO _hf_analyze_test (data) SELECT md5(i::text) FROM generate_series(1, 5000) s(i);
ANALYZE _hf_analyze_test;
SELECT pg_stat_force_next_flush();
SELECT pg_sleep(0.5);
SELECT total_analyze_time FROM pg_stat_user_tables WHERE relname = '_hf_analyze_test';
INSERT INTO _hf_analyze_test (data) SELECT md5(i::text) FROM generate_series(1, 5000) s(i);
ANALYZE _hf_analyze_test;
SELECT pg_stat_force_next_flush();
SELECT pg_sleep(0.5);
SELECT total_analyze_time FROM pg_stat_user_tables WHERE relname = '_hf_analyze_test';
DROP TABLE _hf_analyze_test;`
      );

      if (exitCode !== 0) {
        return { success: false, error: `Analyze timing test failed (exit ${exitCode}): ${output}` };
      }

      const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
      const timeValues = lines.map(l => parseFloat(l)).filter(v => !isNaN(v) && v >= 0);

      if (timeValues.length < 2) {
        return { success: false, error: `Expected 2 timing values, got ${timeValues.length} from: ${output}` };
      }

      const t1 = timeValues[timeValues.length - 2];
      const t2 = timeValues[timeValues.length - 1];

      logger.info(`total_analyze_time: after 1st ANALYZE = ${t1}ms, after 2nd ANALYZE = ${t2}ms`);

      if (t1 <= 0) {
        return { success: false, error: `total_analyze_time after first ANALYZE is ${t1}, expected > 0` };
      }

      if (t2 <= t1) {
        return { success: false, error: `total_analyze_time did not increase after second ANALYZE: ${t1}ms -> ${t2}ms` };
      }

      const delta1 = t1;
      const delta2 = t2 - t1;
      const ratio = delta2 / delta1;
      logger.info(`Analyze time increments: 1st = ${delta1.toFixed(2)}ms, 2nd = ${delta2.toFixed(2)}ms, ratio = ${ratio.toFixed(2)}`);

      if (ratio < 0.1 || ratio > 10) {
        return {
          success: false,
          error: `Analyze time increments are inconsistent: ${delta1.toFixed(2)}ms vs ${delta2.toFixed(2)}ms (ratio ${ratio.toFixed(2)}, expected 0.1-10x)`,
        };
      }

      return { success: true };
    },
  },

  {
    id: "auto-fields-valid",
    name: "Autovacuum/autoanalyze timing fields exist and are non-negative",
    weight: 1,
    description: "total_autovacuum_time >= 0 and total_autoanalyze_time >= 0",
    run: async (_logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await targetPsql(
        "SELECT total_autovacuum_time >= 0 AND total_autoanalyze_time >= 0 FROM pg_stat_all_tables LIMIT 1"
      );
      if (exitCode !== 0) {
        return { success: false, error: `Query failed (exit ${exitCode}): ${output}` };
      }
      if (output.trim() !== "t") {
        return { success: false, error: `Autovacuum/autoanalyze timing fields are negative or missing: ${output}` };
      }
      return { success: true };
    },
  },

  {
    id: "pipeline-green",
    name: "Deployment pipeline completed successfully",
    weight: 3,
    description: "Agent pushed build + regression tests through Gitea; latest commit status is success",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const status = await executeWithExitCode(
        `curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" ` +
          `"http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${DEPLOY_REPO}/commits/main/status"`,
        { silent: true },
      );
      if (status.exitCode !== 0) {
        return { success: false, error: `Could not query Gitea pipeline status: ${status.output}` };
      }
      let data: { state?: string };
      try { data = JSON.parse(status.output); }
      catch { return { success: false, error: `Could not parse status response: ${status.output}` }; }
      const state = data.state ?? "pending";
      logger.info(`Pipeline state: ${state}`);
      if (state !== "success") {
        return { success: false, error: `Pipeline state is '${state}', expected 'success'` };
      }
      return { success: true };
    },
  },

  {
    id: "regression-tests-pass",
    name: "Agent's regression tests pass on target",
    weight: 2,
    description: "Execute the SQL test files the agent pushed to regression-tests/ in the deploy repo",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const tests = await fetchAgentRegressionTests(logger);
      if (!tests) return { success: false, error: "Could not list regression-tests/ in the deploy repo" };
      if (tests.length === 0) {
        return { success: false, error: "Agent pushed no .sql files to regression-tests/" };
      }
      logger.info(`Found ${tests.length} regression test(s): ${tests.map(t => t.name).join(", ")}`);

      const keyPath = getRequiredEnv("SSH_KEY_PATH");
      const targetIp = getRequiredEnv("TARGET_PUBLIC_IP");
      for (const test of tests) {
        // base64 over stdin avoids two layers of shell escaping (ssh + sh -c).
        const b64 = Buffer.from(test.content, "utf-8").toString("base64");
        const run = await sshExec(
          targetIp, keyPath,
          `echo ${b64} | base64 -d | /usr/local/pgsql/bin/psql -h localhost -U postgres -v ON_ERROR_STOP=1 2>&1`,
        );
        if (run.exitCode !== 0) {
          return { success: false, error: `${test.name} failed:\n${run.output.slice(-500)}` };
        }
      }
      return { success: true };
    },
  },

  {
    id: "data-items-migrated",
    name: "Items table migrated to target",
    weight: 5,
    description: `Score = items on target / ${SEED_ROW_COUNT} items on source`,
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await targetPsql(
        "SELECT count(*) FROM items WHERE name NOT LIKE $$_hf_cdc_marker_%$$"
      );
      if (exitCode !== 0) {
        return { success: false, score: 0, error: `Could not query items on target (exit ${exitCode}): ${output}` };
      }

      const targetCount = parseInt(output, 10);
      if (isNaN(targetCount) || targetCount === 0) {
        return { success: false, score: 0, error: `No items found on target` };
      }

      const score = Math.min(targetCount / SEED_ROW_COUNT, 1.0);
      const pct = (score * 100).toFixed(1);
      logger.info(`Items migrated: ${targetCount}/${SEED_ROW_COUNT} (${pct}%)`);

      // 99%+ rounds to a clean pass: the residual gap is post-snapshot drift
      // from concurrent workload writes, not an agent failure. Returning a
      // sub-1.0 score here would classify the result as "partially_passed".
      if (score >= 0.99) return { success: true };
      return { success: score >= 0.95, score, error: score < 0.95 ? `Only ${pct}% of items migrated (${targetCount}/${SEED_ROW_COUNT})` : undefined };
    },
  },

  {
    id: "data-orders-migrated",
    name: "Orders table migrated to target",
    weight: 5,
    description: "Score = orders on target / orders on source (proportional)",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const src = await sourcePsql("SELECT count(*) FROM orders");
      const sourceCount = src.exitCode === 0 ? parseInt(src.output, 10) : 500;

      const { exitCode, output } = await targetPsql("SELECT count(*) FROM orders");
      if (exitCode !== 0) {
        return { success: false, score: 0, error: `Could not query orders on target (exit ${exitCode}): ${output}` };
      }

      const targetCount = parseInt(output, 10);
      if (isNaN(targetCount) || targetCount === 0) {
        return { success: false, score: 0, error: `No orders found on target` };
      }

      const score = Math.min(targetCount / (sourceCount || 500), 1.0);
      const pct = (score * 100).toFixed(1);
      logger.info(`Orders migrated: ${targetCount}/${sourceCount} (${pct}%)`);

      // See data-items-migrated above for why 99%+ is a clean pass.
      if (score >= 0.99) return { success: true };
      return { success: score >= 0.90, score, error: score < 0.90 ? `Only ${pct}% of orders migrated (${targetCount}/${sourceCount})` : undefined };
    },
  },

  {
    id: "data-values-consistent",
    name: "Item data values match between source and target",
    weight: 2,
    description: "MD5 hash of items table content matches source (proves data integrity, not just counts)",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const hashQuery = "SELECT md5(string_agg(name || value::text, ',' ORDER BY id)) FROM items WHERE name NOT LIKE $$_hf_cdc_marker_%$$";
      const src = await sourcePsql(hashQuery);
      if (src.exitCode !== 0) {
        return { success: false, error: `Could not hash source items: ${src.output}` };
      }
      const tgt = await targetPsql(hashQuery);
      if (tgt.exitCode !== 0) {
        return { success: false, error: `Could not hash target items: ${tgt.output}` };
      }
      const srcVal = src.output.trim();
      const tgtVal = tgt.output.trim();
      logger.info(`Items hash, source: ${srcVal}, target: ${tgtVal}`);
      if (srcVal !== tgtVal) {
        return { success: false, error: `Data hash mismatch: source=${srcVal}, target=${tgtVal}` };
      }
      return { success: true };
    },
  },

  {
    id: "cdc-markers-replicated",
    name: "CDC markers written after setup are present on target",
    description: "Verifies that writes during agent work were replicated to target",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      // Source's CDC writer keeps writing AFTER cutover (it bypasses the
      // workload's endpoint by design — that's how this test catches
      // "agent only used pg_dump"). So sourceCount drifts upward post-cutover
      // while targetCount stops at the moment the agent dropped the
      // subscription. Comparing tgt/src always understates how well
      // replication worked. Use an absolute target count instead: any
      // meaningful number of replicated markers proves logical replication
      // ran. pg_dump-only agents have tgt=0; replicating agents have many.
      const tgt = await targetPsql(
        "SELECT count(*) FROM items WHERE name LIKE $$_hf_cdc_marker_%$$"
      );
      if (tgt.exitCode !== 0) {
        return { success: false, error: `Could not query CDC markers on target: ${tgt.output}` };
      }
      const targetMarkerCount = parseInt(tgt.output, 10);
      // NaN slips past `=== 0` / `<` comparisons (NaN comparisons are always
      // false), so we'd return success:true with score:NaN. Reject explicitly.
      if (!Number.isFinite(targetMarkerCount)) {
        return { success: false, error: `Could not parse CDC marker count on target: ${tgt.output}` };
      }
      // Source count is informational only.
      const src = await sourcePsql(
        "SELECT count(*) FROM items WHERE name LIKE $$_hf_cdc_marker_%$$"
      );
      const sourceMarkerCount = src.exitCode === 0 ? parseInt(src.output, 10) : 0;
      logger.info(`CDC markers: ${targetMarkerCount} on target, ${sourceMarkerCount} on source (source drifts post-cutover; target is the signal)`);

      const PASS_AT = 5;          // replication clearly ran
      const FULL_CREDIT_AT = 15;  // enough markers to call it solid
      if (targetMarkerCount === 0) {
        return { success: false, error: `No CDC markers on target (${sourceMarkerCount} on source). Agent likely used pg_dump without ongoing replication.` };
      }
      if (targetMarkerCount < PASS_AT) {
        return { success: false, score: targetMarkerCount / FULL_CREDIT_AT, error: `Only ${targetMarkerCount} CDC markers on target — too few to confirm logical replication ran.` };
      }
      const score = Math.min(targetMarkerCount / FULL_CREDIT_AT, 1.0);
      return { success: true, score };
    },
  },

  {
    id: "app-config-updated",
    name: "PgBouncer routes app traffic to target host",
    weight: 4,
    description: "SHOW DATABASES on PgBouncer admin reports host=TARGET_PRIVATE_IP for the postgres database",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const targetPrivateIp = getRequiredEnv("TARGET_PRIVATE_IP");
      const host = await pgbouncerRoutingHost();
      if (host === null) {
        return { success: false, error: "Could not query PgBouncer admin (SHOW DATABASES failed)" };
      }
      logger.info(`PgBouncer postgres database host: '${host}'`);
      if (host !== targetPrivateIp) {
        return { success: false, error: `PgBouncer routing to '${host}', expected target '${targetPrivateIp}'` };
      }
      return { success: true };
    },
  },

  {
    id: "old-node-not-routing",
    name: "PgBouncer no longer routes to source host",
    weight: 1,
    description: "SHOW DATABASES confirms postgres database host != SOURCE_PRIVATE_IP",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const sourceIp = getRequiredEnv("SOURCE_PRIVATE_IP");
      const host = await pgbouncerRoutingHost();
      if (host === null) {
        return { success: false, error: "Could not query PgBouncer admin (SHOW DATABASES failed)" };
      }
      logger.info(`PgBouncer postgres database host: '${host}'`);
      if (host === sourceIp) {
        return { success: false, error: `PgBouncer still routing to source '${sourceIp}'` };
      }
      return { success: true };
    },
  },

  {
    id: "app-healthy-post-cutover",
    name: "Application reports healthy after cutover",
    weight: 7,
    description: "GET /health on app returns {status: healthy} — confirms connection pool reconnected through pgbouncer to target",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const noCutover = await assertCutoverHappened();
      if (noCutover) return noCutover;
      const { exitCode, output } = await executeWithExitCode(
        `curl -sf http://${APP_IP}:${APP_PORT}/health`,
        { silent: true },
      );
      if (exitCode !== 0) {
        return { success: false, error: `App /health failed (curl exit ${exitCode})` };
      }
      let health: { status?: string; backend?: string };
      try { health = JSON.parse(output); }
      catch { return { success: false, error: `Could not parse health response: ${output}` }; }
      logger.info(`App health: status=${health.status}, backend=${health.backend}`);
      if (health.status !== "healthy") {
        return { success: false, error: `App unhealthy: ${output}` };
      }
      return { success: true };
    },
  },

  {
    id: "workload-succeeds",
    name: "Workload HTTP checks succeed against app",
    weight: 8,
    description: "Running workload-check.sh from workload container exits 0 (hits app -> pgbouncer -> target)",
    run: async (_logger: Logger): Promise<SimpleTestResult> => {
      const noCutover = await assertCutoverHappened();
      if (noCutover) return noCutover;
      const keyPath = getRequiredEnv("SSH_KEY_PATH");
      const workloadIp = getRequiredEnv("WORKLOAD_PUBLIC_IP");

      const { exitCode, output } = await sshExec(workloadIp, keyPath, "bash /home/ec2-user/workload-check.sh");
      if (exitCode !== 0) {
        return { success: false, error: `workload-check.sh failed (exit ${exitCode}): ${output}` };
      }
      return { success: true };
    },
  },

  {
    id: "post-cutover-write",
    name: "Target accepts and serves writes after cutover",
    weight: 10,
    description: "POST /orders via app, verify the row appears on target DB",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const noCutover = await assertCutoverHappened();
      if (noCutover) return noCutover;

      const write = await executeWithExitCode(
        `curl -sf -X POST -H 'Content-Type: application/json' ` +
          `-d '{"item_id":1,"customer_id":1,"status":"pending","quantity":9999}' ` +
          `http://${APP_IP}:${APP_PORT}/orders`,
        { silent: true },
      );
      if (write.exitCode !== 0) {
        return { success: false, error: `POST /orders failed: ${write.output}` };
      }

      const read = await targetPsql("SELECT count(*) FROM orders WHERE quantity = 9999");
      if (read.exitCode !== 0) {
        return { success: false, error: `Post-cutover read failed on target: ${read.output}` };
      }
      const count = parseInt(read.output, 10);
      if (count < 1) {
        return { success: false, error: `Post-cutover write not found on target (count=${count})` };
      }
      logger.info(`Post-cutover write verified: ${count} row(s) with quantity=9999 on target`);
      return { success: true };
    },
  },

  {
    id: "downtime-acceptable",
    name: `Workload downtime during cutover was <= ${MAX_DOWNTIME_SECS}s`,
    weight: 9,
    description: `Maximum consecutive error window in workload log is <= ${MAX_DOWNTIME_SECS} seconds`,
    run: async (_logger: Logger): Promise<SimpleTestResult> => {
      const noCutover = await assertCutoverHappened();
      if (noCutover) return noCutover;
      const keyPath = getRequiredEnv("SSH_KEY_PATH");
      const workloadIp = getRequiredEnv("WORKLOAD_PUBLIC_IP");

      // Base64-stdin the script so layered ssh + sh -c quoting can't mangle
      // the Python (single quotes inside the script otherwise break out).
      const pyScript = `${PY_LOAD_WORKLOAD_LOG}
max_ms = 0
err_start = None
for line in lines:
    try:
        ev = json.loads(line.strip())
    except:
        continue
    ts = datetime.fromisoformat(ev["ts"].replace("Z", "+00:00"))
    if ev["status"] == "error":
        if err_start is None:
            err_start = ts
    else:
        if err_start is not None:
            max_ms = max(max_ms, int((ts - err_start).total_seconds() * 1000))
            err_start = None

if err_start is not None:
    last = datetime.fromisoformat(json.loads(lines[-1].strip())["ts"].replace("Z", "+00:00"))
    max_ms = max(max_ms, int((last - err_start).total_seconds() * 1000))

print(max_ms)
`;
      const b64 = Buffer.from(pyScript, "utf-8").toString("base64");
      const { exitCode, output } = await sshExec(workloadIp, keyPath, `echo ${b64} | base64 -d | python3 -`);

      if (exitCode !== 0) {
        return { success: false, error: `Failed to parse workload log: ${output}` };
      }
      if (output === "NO_LOG" || output === "EMPTY_LOG") {
        return { success: false, error: `Workload log not found or empty` };
      }

      const maxDowntimeMs = parseInt(output, 10);
      if (isNaN(maxDowntimeMs)) {
        return { success: false, error: `Could not parse max downtime: ${output}` };
      }

      const maxDowntimeSecs = maxDowntimeMs / 1000;
      if (maxDowntimeSecs > MAX_DOWNTIME_SECS) {
        // > 2x threshold escalates weight 9 -> 12.
        const severe = maxDowntimeSecs > 2 * MAX_DOWNTIME_SECS;
        return {
          success: false,
          weight: severe ? 12 : undefined,
          error:
            `Max consecutive error window was ${maxDowntimeSecs.toFixed(1)}s, exceeds ${MAX_DOWNTIME_SECS}s threshold` +
            (severe ? ` (SEVERE: > 2x threshold; escalated weight applied)` : ``),
        };
      }
      return { success: true };
    },
  },

  {
    id: "low-error-count-during-cutover",
    name: `Workload error rate stays <= ${MAX_WORKLOAD_ERROR_RATE_PCT}% in any ${ERROR_RATE_WINDOW_SECS}s window`,
    weight: 10,
    description: `Max error rate over any ${ERROR_RATE_WINDOW_SECS}s window — catches connection-killing cutovers (burst of failures) and sustained breakage, while tolerating brief transient blips.`,
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const noCutover = await assertCutoverHappened();
      if (noCutover) return noCutover;
      const keyPath = getRequiredEnv("SSH_KEY_PATH");
      const workloadIp = getRequiredEnv("WORKLOAD_PUBLIC_IP");
      // Bucket events into N-second windows by timestamp, compute per-window
      // error rate, return the max. Windows with < MIN_REQS requests are
      // excluded so a single error in a sparse window doesn't trip 50%.
      const pyScript = `${PY_LOAD_WORKLOAD_LOG}
WINDOW_SECS = ${ERROR_RATE_WINDOW_SECS}
MIN_REQS = 10

buckets = {}
for line in lines:
    try:
        ev = json.loads(line.strip())
    except:
        continue
    ts_str = ev.get("ts") or ev.get("timestamp")
    if not ts_str:
        continue
    try:
        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except:
        continue
    bucket = int(ts.timestamp() // WINDOW_SECS)
    tot, errs = buckets.get(bucket, (0, 0))
    buckets[bucket] = (tot + 1, errs + (1 if ev.get("status") == "error" else 0))

if not buckets:
    print("NO_EVENTS"); sys.exit(0)

max_rate = 0.0
for tot, errs in buckets.values():
    if tot < MIN_REQS:
        continue
    rate = errs / tot
    if rate > max_rate:
        max_rate = rate

print(f"{max_rate:.6f}")
`;
      const b64 = Buffer.from(pyScript, "utf-8").toString("base64");
      const { exitCode, output } = await sshExec(workloadIp, keyPath, `echo ${b64} | base64 -d | python3 -`);
      if (exitCode !== 0) return { success: false, error: `Failed to parse workload log: ${output}` };
      if (output === "NO_LOG" || output === "EMPTY_LOG" || output === "NO_EVENTS") {
        return { success: false, error: `Workload log empty / unparseable / no timestamped events: ${output}` };
      }
      const maxRate = parseFloat(output.trim());
      if (isNaN(maxRate)) return { success: false, error: `Could not parse error rate: ${output}` };
      const maxRatePct = maxRate * 100;
      logger.info(`Worst ${ERROR_RATE_WINDOW_SECS}s window error rate: ${maxRatePct.toFixed(2)}%`);
      if (maxRatePct > MAX_WORKLOAD_ERROR_RATE_PCT) {
        // > 5x threshold escalates weight 10 -> 14.
        const severe = maxRatePct > 5 * MAX_WORKLOAD_ERROR_RATE_PCT;
        return {
          success: false,
          weight: severe ? 14 : undefined,
          error:
            `Worst ${ERROR_RATE_WINDOW_SECS}s window had ${maxRatePct.toFixed(2)}% errors — ` +
            `exceeds the ${MAX_WORKLOAD_ERROR_RATE_PCT}% threshold` +
            (severe ? ` (SEVERE: > 5x threshold; escalated weight applied)` : ``) + `.`,
        };
      }
      return { success: true };
    },
  },

  {
    id: "schema-aligned-on-target",
    name: "Source and target schemas match on orders",
    weight: 4,
    description:
      "Target's `orders` has every column present on source's `orders`.",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const cols = (output: string) =>
        output.split("\n").map((s) => s.trim()).filter(Boolean).sort();

      const src = await sourcePsql(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' ORDER BY column_name"
      );
      if (src.exitCode !== 0) {
        return { success: false, error: `Could not list source orders columns: ${src.output}` };
      }
      const tgt = await targetPsql(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' ORDER BY column_name"
      );
      if (tgt.exitCode !== 0) {
        return { success: false, error: `Could not list target orders columns: ${tgt.output}` };
      }
      const srcCols = cols(src.output);
      const tgtCols = cols(tgt.output);
      const missing = srcCols.filter((c) => !tgtCols.includes(c));
      if (missing.length > 0) {
        return {
          success: false,
          error:
            `Target's orders is missing columns present on source: ${missing.join(", ")}. ` +
            `Logical replication does not auto-create schema — DDL must be replayed manually ` +
            `(eg. \`pg_dump --schema-only --table=orders\` on source, then apply to target ` +
            `BEFORE CREATE PUBLICATION/SUBSCRIPTION). Without this, replication fails silently ` +
            `(check pg_subscription_rel.srsubstate on target and target's log).`,
        };
      }
      logger.info(`Schema aligned: source and target both have ${srcCols.length} columns on orders`);
      return { success: true };
    },
  },

  // Only checks orders_id_seq: source's items_id_seq keeps advancing post-cutover
  // because the CDC marker worker writes directly to source's items.
  {
    id: "sequences-aligned-on-target",
    name: "Sequence values aligned on target after cutover",
    weight: 3,
    description:
      "Target's orders_id_seq.last_value is within SEQ_TOLERANCE of source's.",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const SEQ_TOLERANCE = 500;
      const src = await sourcePsql(`SELECT last_value FROM orders_id_seq`);
      if (src.exitCode !== 0) {
        return { success: false, error: `Could not read orders_id_seq on source: ${src.output}` };
      }
      const tgt = await targetPsql(`SELECT last_value FROM orders_id_seq`);
      if (tgt.exitCode !== 0) {
        return { success: false, error: `Could not read orders_id_seq on target: ${tgt.output}` };
      }
      const srcVal = parseInt(src.output.trim(), 10);
      const tgtVal = parseInt(tgt.output.trim(), 10);
      if (isNaN(srcVal) || isNaN(tgtVal)) {
        return { success: false, error: `Could not parse orders_id_seq values: source=${src.output} target=${tgt.output}` };
      }
      if (tgtVal < srcVal - SEQ_TOLERANCE) {
        return {
          success: false,
          error:
            `orders_id_seq: target last_value (${tgtVal}) < source last_value (${srcVal}) by more than ${SEQ_TOLERANCE}. ` +
            `New INSERTs on target will collide with already-migrated rows. ` +
            `Fix: \`SELECT setval('orders_id_seq', (SELECT max(id)+10000 FROM orders))\` on target ` +
            `at cutover time (NOT after initial copy — source keeps advancing). Logical replication ` +
            `doesn't sync sequence state; manual sync with a safety margin is required.`,
        };
      }
      logger.info(`orders_id_seq: target=${tgtVal}, source=${srcVal} (within tolerance ${SEQ_TOLERANCE})`);
      return { success: true };
    },
  },

  {
    id: "stale-replication-slot-cleaned",
    name: "Stale replication slot from prior cutover was cleaned up",
    weight: 3,
    description:
      "Setup plants 'abandoned_cutover_slot' on source; agent should drop it during pre-flight.",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await sourcePsql(
        "SELECT slot_name FROM pg_replication_slots WHERE slot_name = 'abandoned_cutover_slot'"
      );
      if (result.exitCode !== 0) {
        return { success: false, error: `Could not query pg_replication_slots on source: ${result.output}` };
      }
      if (result.output.trim() === "") {
        logger.info("'abandoned_cutover_slot' is absent — agent dropped the stale slot");
        return { success: true };
      }
      return {
        success: false,
        error:
          `'abandoned_cutover_slot' is still present on source after rollout. ` +
          `The agent didn't drop the stale replication slot during pre-flight. ` +
          `Logical replication slots retain WAL indefinitely; leaving one means ` +
          `source disk pressure grows unboundedly until someone notices and cleans up. ` +
          `Fix: \`SELECT pg_drop_replication_slot('abandoned_cutover_slot')\` on source ` +
          `before starting the cutover.`,
      };
    },
  },

  {
    id: "subscription-dropped-after-cutover",
    name: "Agent's subscription on target was dropped after cutover",
    weight: 3,
    description:
      "pg_subscription on target is empty (disabling alone is not sufficient — the slot on source persists).",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await targetPsql("SELECT count(*) FROM pg_subscription");
      if (result.exitCode !== 0) {
        return { success: false, error: `Could not query pg_subscription on target: ${result.output}` };
      }
      const count = parseInt(result.output.trim(), 10);
      if (isNaN(count)) {
        return { success: false, error: `Could not parse subscription count: ${result.output}` };
      }
      if (count === 0) {
        logger.info("No subscriptions remain on target — agent dropped subscription cleanly");
        return { success: true };
      }
      const detail = await targetPsql(
        "SELECT subname || '|' || subenabled::text FROM pg_subscription"
      );
      return {
        success: false,
        error:
          `Target still has ${count} subscription(s) after cutover: ${detail.output.trim()}. ` +
          `After cutover completes, the agent should run \`DROP SUBSCRIPTION <subname>\` ` +
          `on target to: (a) stop consuming source's WAL, (b) release the corresponding ` +
          `slot on source so WAL can be reclaimed, (c) prevent split-brain replay if any ` +
          `writes leak back to source. Disabling the subscription isn't sufficient — the ` +
          `slot on source persists.`,
      };
    },
  },

  // Symmetric to subscription-dropped-after-cutover: publication on source is an
  // independent catalog object and survives subscription drop on target.
  {
    id: "publication-dropped-on-source",
    name: "Publication on source was dropped after cutover",
    weight: 3,
    description: "pg_publication on source is empty.",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await sourcePsql("SELECT count(*) FROM pg_publication");
      if (result.exitCode !== 0) {
        return { success: false, error: `Could not query pg_publication on source: ${result.output}` };
      }
      const count = parseInt(result.output.trim(), 10);
      if (isNaN(count)) {
        return { success: false, error: `Could not parse publication count: ${result.output}` };
      }
      if (count === 0) {
        logger.info("No publications remain on source — agent dropped publication cleanly");
        return { success: true };
      }
      const detail = await sourcePsql("SELECT pubname FROM pg_publication");
      return {
        success: false,
        error:
          `Source still has ${count} publication(s) after cutover: ${detail.output.trim()}. ` +
          `After cutover, the agent should run \`DROP PUBLICATION <pubname>\` on source. ` +
          `Dropping the subscription on target is not sufficient — the publication is an ` +
          `independent catalog object on source and persists until explicitly dropped.`,
      };
    },
  },
];

/** Deterministic tests + code/regression rubrics. */
export const tests: SimpleTest[] = [
  ...deterministicTests,
  ...createCodeRubricTests(),
  ...createRegressionRubricTests(),
];

function getRequiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

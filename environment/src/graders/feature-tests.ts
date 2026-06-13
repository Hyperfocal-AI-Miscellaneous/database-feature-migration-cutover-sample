import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { sshExec } from "../clients/ssh.js";
import { targetPsql } from "../clients/psql.js";
import { getRequiredEnv, fetchAgentRegressionTests } from "./shared.js";

export const tests: SimpleTest[] = [
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

  timingAccumulationTest({ id: "vacuum-timing-accurate", command: "VACUUM", column: "total_vacuum_time" }),

  timingAccumulationTest({ id: "analyze-timing-accurate", command: "ANALYZE", column: "total_analyze_time" }),

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
];

/**
 * Run VACUUM/ANALYZE twice on a scratch table and verify the timing column
 * starts positive, strictly increases, and the two increments are within
 * 10x of each other (a value that accumulates wall-clock time, not a
 * counter or a constant).
 */
function timingAccumulationTest(opts: {
  id: string;
  command: "VACUUM" | "ANALYZE";
  column: "total_vacuum_time" | "total_analyze_time";
}): SimpleTest {
  const { id, command, column } = opts;
  const table = `_hf_${command.toLowerCase()}_test`;
  const round = `INSERT INTO ${table} (data) SELECT md5(i::text) FROM generate_series(1, 5000) s(i);
${command} ${table};
SELECT pg_stat_force_next_flush();
SELECT pg_sleep(0.5);
SELECT ${column} FROM pg_stat_user_tables WHERE relname = '${table}';`;

  return {
    id,
    name: `Manual ${command} timing column accumulates correctly`,
    weight: 3,
    description: `${command} twice, verify ${column} increases each time by a consistent amount`,
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await targetPsql(
        `CREATE TABLE IF NOT EXISTS ${table} (id serial, data text);
${round}
${round}
DROP TABLE ${table};`
      );

      if (exitCode !== 0) {
        return { success: false, error: `${command} timing test failed (exit ${exitCode}): ${output}` };
      }

      const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
      const timeValues = lines.map(l => parseFloat(l)).filter(v => !isNaN(v) && v >= 0);

      if (timeValues.length < 2) {
        return { success: false, error: `Expected 2 timing values, got ${timeValues.length} from: ${output}` };
      }

      const t1 = timeValues[timeValues.length - 2];
      const t2 = timeValues[timeValues.length - 1];

      logger.info(`${column}: after 1st ${command} = ${t1}ms, after 2nd ${command} = ${t2}ms`);

      if (t1 <= 0) {
        return { success: false, error: `${column} after first ${command} is ${t1}, expected > 0` };
      }

      if (t2 <= t1) {
        return { success: false, error: `${column} did not increase after second ${command}: ${t1}ms -> ${t2}ms` };
      }

      const delta1 = t1;
      const delta2 = t2 - t1;
      const ratio = delta2 / delta1;
      logger.info(`${command} time increments: 1st = ${delta1.toFixed(2)}ms, 2nd = ${delta2.toFixed(2)}ms, ratio = ${ratio.toFixed(2)}`);

      if (ratio < 0.1 || ratio > 10) {
        return {
          success: false,
          error: `${command} time increments are inconsistent: ${delta1.toFixed(2)}ms vs ${delta2.toFixed(2)}ms (ratio ${ratio.toFixed(2)}, expected 0.1-10x)`,
        };
      }

      return { success: true };
    },
  };
}

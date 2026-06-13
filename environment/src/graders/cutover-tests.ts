import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { executeWithExitCode } from "@hyperfocal/env-base";
import {
  APP_IP,
  APP_PORT,
  MAX_DOWNTIME_SECS,
  MAX_WORKLOAD_ERROR_RATE_PCT,
  ERROR_RATE_WINDOW_SECS,
} from "../config.js";
import { sshExec } from "../clients/ssh.js";
import { targetPsql } from "../clients/psql.js";
import { getRequiredEnv, PY_LOAD_WORKLOAD_LOG, assertCutoverHappened, pgbouncerRoutingHost } from "./shared.js";

export const tests: SimpleTest[] = [
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
];

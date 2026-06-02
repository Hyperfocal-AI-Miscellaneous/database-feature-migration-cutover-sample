import * as fs from "fs";
import * as path from "path";
import { createRubricTest, getLogsDir, preprocessTrace } from "@hyperfocal/env-base";
import type { Logger, SimpleTest } from "@hyperfocal/env-base";
import { createRubricJudge } from "../judge.js";

export function createSlowQueryRubricTests(): SimpleTest[] {
  return [
    createRubricTest({
      id: "investigation-quality",
      name: "Investigation Process Quality",
      description:
        "Evaluates whether the agent followed a systematic debugging process using the observability stack",
      criteria: [
        {
          weight: 10,
          requirement: `The agent used the Grafana dashboard (via curl to the Grafana API or by
navigating to http://172.20.0.22:3000) to identify which API endpoint
had elevated latency. The dashboard shows per-endpoint API and DB latency,
making it the correct triage entry point. The agent should have compared
API latency with DB latency to determine the bottleneck was in the
database layer, not the API code.`,
          context: ["trace"],
        },
        {
          weight: 8,
          requirement: `The agent used EXPLAIN ANALYZE or EXPLAIN on the slow query to understand
the query execution plan before attempting a fix. This demonstrates proper
database debugging methodology rather than guessing at solutions.`,
          context: ["trace"],
        },
        {
          weight: 6,
          requirement: `The agent verified the fix worked by re-checking latency after each change,
either via the Grafana dashboard, Prometheus API, EXPLAIN ANALYZE, or
pg_stat_statements. For variants with multiple issues, the agent
should have checked after each fix to see if latency was within SLO.`,
          context: ["trace"],
        },
        {
          weight: 4,
          requirement: `The agent created an appropriate compound index (not just a single-column
index) that covers the query's WHERE clause and ORDER BY columns. The
index should include customer_id and ideally status and created_at with
the correct sort direction (created_at DESC).`,
          context: ["trace"],
        },
        {
          weight: -5,
          requirement: `The agent took harmful shortcuts: deleting rows to reduce latency,
modifying the API application code, disabling pg_stat_statements,
or making changes that would break the workload or API.`,
          context: ["trace"],
        },
      ],
      getContext: async (logger: Logger) => {
        logger.info("Reading agent trace for investigation quality evaluation");
        const trace = findAgentTrace(logger);
        return { trace };
      },
      generateFn: createRubricJudge(),
      passThreshold: 0.5,
    }),
  ];
}

function findAgentTrace(logger: Logger): string {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) {
    logger.warn(`Logs directory does not exist: ${logsDir}`);
    return "(no trace available)";
  }

  const candidates: Array<{ problemId: string; agentDir: string; mtimeMs: number }> = [];
  for (const entry of fs.readdirSync(logsDir)) {
    if (!entry.startsWith("slow-query")) continue;
    const agentDir = path.join(logsDir, entry, "agent");
    if (!fs.existsSync(agentDir)) continue;
    try {
      candidates.push({
        problemId: entry,
        agentDir,
        mtimeMs: fs.statSync(agentDir).mtimeMs,
      });
    } catch {
      /* unreadable dir */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { agentDir } of candidates) {
    const jsonlFiles = fs
      .readdirSync(agentDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (jsonlFiles.length > 0) {
      const tracePath = path.join(agentDir, jsonlFiles[0]);
      logger.info(`Found agent trace: ${tracePath}`);
      const raw = fs.readFileSync(tracePath, "utf-8");
      return preprocessTrace(raw, { mode: "summary", resultMaxLength: 500 });
    }
  }

  for (const { problemId } of candidates) {
    const combined = path.join(logsDir, problemId, "combined.log");
    if (fs.existsSync(combined)) {
      logger.info(`Using combined log: ${combined}`);
      return fs.readFileSync(combined, "utf-8").slice(0, 50_000);
    }
  }

  logger.warn("No agent trace found in logs directory");
  return "(no trace available)";
}

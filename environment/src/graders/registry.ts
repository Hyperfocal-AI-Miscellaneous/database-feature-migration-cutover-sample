import type { SimpleTest } from "@hyperfocal/env-base";
import type { McpRuntime } from "../setup/mcp.js";
import { getSlowQueryTests } from "./postgres/slow-query/index.js";
import { getDeploymentFailureTests } from "./postgres/deployment-failure/index.js";
import { cutoverTests } from "./postgres/cutover-grader.js";
import {
  buildSentryInvestigationQualityTests,
  buildSentryTriageTests,
} from "./mcp/sentry/index.js";
import { buildGithubReadTraceTests } from "./mcp/github-grader.js";
import {
  buildLinearCommentContentTests,
  buildLinearProgressionTests,
} from "./mcp/linear-grader.js";

export interface GraderContext {
  mcp: McpRuntime;
}

export interface RegistryEntry {
  postgres?: string;
  build: (ctx: GraderContext) => SimpleTest[];
}

export const REGISTRY: Record<string, RegistryEntry> = {
  "sentry-investigation": {
    postgres: "slow-query-guided",
    build: ({ mcp }) => {
      if (!mcp.services.sentry || !mcp.toolCallLogs.sentry) {
        return [missingServiceTest("sentry")];
      }
      return [
        ...getSlowQueryTests("slow-query-guided"),
        ...buildSentryTriageTests({
          service: mcp.services.sentry,
          log: mcp.toolCallLogs.sentry,
          targetCulprit: "orders.listOrdersByCustomer",
        }),
        ...buildSentryInvestigationQualityTests({
          log: mcp.toolCallLogs.sentry,
        }),
      ];
    },
  },

  "regression-triage": {
    postgres: "deployment-failure-standard",
    build: ({ mcp }) => {
      if (!mcp.services.sentry || !mcp.toolCallLogs.sentry) {
        return [missingServiceTest("sentry")];
      }
      if (!mcp.services.github || !mcp.toolCallLogs.github) {
        return [missingServiceTest("github")];
      }
      return [
        ...getDeploymentFailureTests("deployment-failure-standard"),
        ...buildSentryTriageTests({
          service: mcp.services.sentry,
          log: mcp.toolCallLogs.sentry,
          targetCulprit: "orders.computeTotals",
        }),
        ...buildGithubReadTraceTests({
          log: mcp.toolCallLogs.github,
          minReads: 1,
        }),
      ];
    },
  },

  "cutover-ops": {
    postgres: "pg-cutover-standard",
    build: ({ mcp }) => {
      if (!mcp.services.linear || !mcp.toolCallLogs.linear) {
        return [missingServiceTest("linear")];
      }
      return [
        ...cutoverTests,
        ...buildLinearProgressionTests({
          log: mcp.toolCallLogs.linear,
          targetId: "iss-dba-88",
          targetIdentifier: "DBA-88",
          expectedStateSequence: ["In Progress", "In Review", "Done"],
        }),
        ...buildLinearCommentContentTests({
          service: mcp.services.linear,
          targetId: "iss-dba-88",
          targetIdentifier: "DBA-88",
          requiredPatterns: [
            { name: "targetHost", pattern: /targetHost/i },
            { name: "target-ip", pattern: /172\.20\.0\.11/ },
            { name: "pgBinaryPath", pattern: /pgBinaryPath/i },
          ],
        }),
      ];
    },
  },
};

export function getRegistryEntry(problemId: string): RegistryEntry | undefined {
  return REGISTRY[problemId];
}

export function isPurePostgresProblem(problemId: string | undefined): boolean {
  if (!problemId) return false;
  return POSTGRES_PREFIXES.some((p) => problemId.startsWith(p));
}

const POSTGRES_PREFIXES = ["slow-query", "deployment-failure", "pg-cutover"];

function missingServiceTest(service: string) {
  return {
    id: `${service}-service-missing`,
    name: `${service} service handle is present`,
    description:
      `The orchestrator must have set up the ${service} MCP service before runTests. ` +
      "This usually means `rollout` wasn't used (setup/solve/test as separate " +
      "commands is unsupported for MCP-backed problems).",
    run: async () => ({
      success: false,
      errored: true,
      error: `${service} service handle missing on Environment, did you run rollout?`,
    }),
  };
}

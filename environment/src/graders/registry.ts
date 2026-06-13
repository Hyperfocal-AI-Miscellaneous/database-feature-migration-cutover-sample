import type { SimpleTest } from "@hyperfocal/env-base";
import type { McpRuntime } from "../setup/mcp.js";
import { tests as postgresTests } from "./grader.js";
import {
  buildLinearCommentContentTests,
  buildLinearProgressionTests,
} from "./linear-grader.js";

export interface GraderContext {
  mcp: McpRuntime;
}

export interface RegistryEntry {
  postgres?: string;
  build: (ctx: GraderContext) => SimpleTest[];
}

export const REGISTRY: Record<string, RegistryEntry> = {
  "pg-cutover": { postgres: "pg-cutover-hints", build: buildPgCutoverTests },
  "pg-cutover-hints": { postgres: "pg-cutover-hints", build: buildPgCutoverTests },
};

export function getRegistryEntry(problemId: string): RegistryEntry | undefined {
  return REGISTRY[problemId];
}

function buildPgCutoverTests({ mcp }: GraderContext): SimpleTest[] {
  if (!mcp.services.linear || !mcp.toolCallLogs.linear) {
    return [missingServiceTest("linear")];
  }
  return [
    ...postgresTests,
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
}

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

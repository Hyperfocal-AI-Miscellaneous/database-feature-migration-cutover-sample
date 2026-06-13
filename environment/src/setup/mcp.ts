import type { Logger, Problem } from "@hyperfocal/env-base";
import type { LinearService } from "@hyperfocal/mock-mcp-services/linear";
import { setupLinearProblem, cleanupLinearProblem } from "./linear.js";

export interface ToolCallRecord {
  tool: string;
  status: "ok" | "error";
  args: Record<string, unknown>;
}

export interface ToolCallLog {
  calls: ToolCallRecord[];
}

export interface McpRuntime {
  services: {
    linear?: LinearService;
  };
  toolCallLogs: {
    linear?: ToolCallLog;
  };
}

export function newMcpRuntime(): McpRuntime {
  return { services: {}, toolCallLogs: {} };
}

export function problemHasMcp(problem: Problem | undefined): boolean {
  if (!problem?.mcp) return false;
  return !!problem.mcp.linear;
}

export async function setupMcpServicesForProblem(opts: {
  problem: Problem;
  environmentRoot: string;
  workspace: string;
  logger: Logger;
}): Promise<McpRuntime> {
  const runtime = newMcpRuntime();
  const mcp = opts.problem.mcp;
  if (!mcp?.linear) return runtime;

  const log: ToolCallLog = { calls: [] };
  runtime.toolCallLogs.linear = log;
  const { service } = await setupLinearProblem({
    problemId: opts.problem.id,
    environmentRoot: opts.environmentRoot,
    workspace: opts.workspace,
    logger: opts.logger,
    dataDir: mcp.linear.dataDir,
    onToolCall: makeToolCallHook(log),
  });
  runtime.services.linear = service;

  return runtime;
}

/** Stop every service in the runtime and remove its mcp-config.json entry. */
export async function cleanupMcpServices(opts: {
  runtime: McpRuntime;
  workspace: string;
  logger: Logger;
}): Promise<void> {
  if (opts.runtime.services.linear) {
    await cleanupLinearProblem({
      service: opts.runtime.services.linear,
      workspace: opts.workspace,
      logger: opts.logger,
    });
    opts.runtime.services.linear = undefined;
  }
}

function makeToolCallHook(
  log: ToolCallLog,
): (event: {
  service: string;
  tool: string;
  status: "ok" | "error";
  args: Record<string, unknown>;
  durationMs: number;
  errorMessage?: string;
}) => void {
  return (event) => {
    log.calls.push({ tool: event.tool, status: event.status, args: event.args });
    const suffix = event.status === "error" ? ` error=${event.errorMessage}` : "";
    console.log(
      `[mcp:${event.service}] ${event.tool} (${event.durationMs}ms)${suffix}`,
    );
  };
}

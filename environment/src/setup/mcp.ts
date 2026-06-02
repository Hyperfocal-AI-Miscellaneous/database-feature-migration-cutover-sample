import type { Logger, Problem } from "@hyperfocal/env-base";
import type { LinearService } from "@hyperfocal/mock-mcp-services/linear";
import type { SentryService } from "@hyperfocal/mock-mcp-services/sentry";
import type { GitHubService } from "@hyperfocal/mock-mcp-services/github";
import { setupLinearProblem, cleanupLinearProblem } from "./linear.js";
import { setupSentryProblem, cleanupSentryProblem } from "./sentry.js";
import { setupGithubProblem, cleanupGithubProblem } from "./github.js";

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
    sentry?: SentryService;
    linear?: LinearService;
    github?: GitHubService;
  };
  toolCallLogs: {
    sentry?: ToolCallLog;
    linear?: ToolCallLog;
    github?: ToolCallLog;
  };
}

export function newMcpRuntime(): McpRuntime {
  return { services: {}, toolCallLogs: {} };
}

export function problemHasMcp(problem: Problem | undefined): boolean {
  if (!problem?.mcp) return false;
  const { sentry, linear, github } = problem.mcp;
  return !!(sentry || linear || github);
}

export async function setupMcpServicesForProblem(opts: {
  problem: Problem;
  environmentRoot: string;
  workspace: string;
  logger: Logger;
}): Promise<McpRuntime> {
  const runtime = newMcpRuntime();
  const mcp = opts.problem.mcp;
  if (!mcp) return runtime;

  if (mcp.sentry) {
    const log: ToolCallLog = { calls: [] };
    runtime.toolCallLogs.sentry = log;
    const { service } = await setupSentryProblem({
      problemId: opts.problem.id,
      environmentRoot: opts.environmentRoot,
      workspace: opts.workspace,
      logger: opts.logger,
      dataDir: mcp.sentry.dataDir,
      metadataOverrides: {
        project: mcp.sentry.project,
        team: mcp.sentry.team,
        user: mcp.sentry.user,
        dsn: mcp.sentry.dsn,
      },
      onToolCall: makeToolCallHook(log),
    });
    runtime.services.sentry = service;
  }

  if (mcp.linear) {
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
  }

  if (mcp.github) {
    const log: ToolCallLog = { calls: [] };
    runtime.toolCallLogs.github = log;
    const { service } = await setupGithubProblem({
      problemId: opts.problem.id,
      environmentRoot: opts.environmentRoot,
      workspace: opts.workspace,
      logger: opts.logger,
      dataDir: mcp.github.dataDir,
      repoSource: mcp.github.repoSource,
      owner: mcp.github.owner,
      name: mcp.github.name,
      defaultBranch: mcp.github.defaultBranch,
      readOnly: mcp.github.readOnly,
      onToolCall: makeToolCallHook(log),
    });
    runtime.services.github = service;
  }

  return runtime;
}

/** Stop every service in the runtime and remove its mcp-config.json entry. */
export async function cleanupMcpServices(opts: {
  runtime: McpRuntime;
  workspace: string;
  logger: Logger;
}): Promise<void> {
  if (opts.runtime.services.sentry) {
    await cleanupSentryProblem({
      service: opts.runtime.services.sentry,
      workspace: opts.workspace,
      logger: opts.logger,
    });
    opts.runtime.services.sentry = undefined;
  }
  if (opts.runtime.services.linear) {
    await cleanupLinearProblem({
      service: opts.runtime.services.linear,
      workspace: opts.workspace,
      logger: opts.logger,
    });
    opts.runtime.services.linear = undefined;
  }
  if (opts.runtime.services.github) {
    await cleanupGithubProblem({
      service: opts.runtime.services.github,
      workspace: opts.workspace,
      logger: opts.logger,
    });
    opts.runtime.services.github = undefined;
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

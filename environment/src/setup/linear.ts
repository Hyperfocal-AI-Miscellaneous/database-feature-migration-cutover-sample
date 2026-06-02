import * as fs from "fs";
import * as path from "path";
import type { Logger } from "@hyperfocal/env-base";
import { LinearService } from "@hyperfocal/mock-mcp-services/linear";
import type { OnToolCall } from "@hyperfocal/mock-mcp-services/core";
import {
  mcpConfigPath,
  removeMcpServer,
  upsertMcpServer,
} from "./mcp-config.js";

export { mcpConfigPath } from "./mcp-config.js";

export function linearDataDir(environmentRoot: string, problemId: string): string {
  return path.join(environmentRoot, "mock-data", problemId, "linear");
}

export interface LinearSetupResult {
  service: LinearService;
  url: string;
  configPath: string;
}

export async function setupLinearProblem(opts: {
  problemId: string;
  environmentRoot: string;
  workspace: string;
  logger: Logger;
  onToolCall?: OnToolCall;
  dataDir?: string;
}): Promise<LinearSetupResult> {
  const dataDir = opts.dataDir ?? linearDataDir(opts.environmentRoot, opts.problemId);
  if (!fs.existsSync(dataDir)) {
    throw new Error(
      `Linear fixture directory not found for problem '${opts.problemId}': ${dataDir}`,
    );
  }

  const service = new LinearService(opts.onToolCall ? { onToolCall: opts.onToolCall } : {});
  service.configure({ dataDir });

  const { url } = await service.listen();
  opts.logger.info(`LinearService listening on ${url} (data: ${dataDir})`);

  const configPath = upsertMcpServer(opts.workspace, "linear", {
    type: "http",
    url,
  });
  opts.logger.info(`Wrote MCP config to ${configPath}`);

  return { service, url, configPath };
}

export async function cleanupLinearProblem(opts: {
  service: LinearService | undefined;
  workspace: string;
  logger: Logger;
}): Promise<void> {
  if (opts.service && opts.service.isListening) {
    try {
      await opts.service.stop();
      opts.logger.info("LinearService stopped");
    } catch (err) {
      opts.logger.warn(`LinearService stop failed: ${(err as Error).message}`);
    }
  }

  const configPath = mcpConfigPath(opts.workspace);
  const existed = fs.existsSync(configPath);
  try {
    removeMcpServer(opts.workspace, "linear");
    if (existed) {
      opts.logger.info(`Removed linear entry from ${configPath}`);
    }
  } catch (err) {
    opts.logger.warn(`Failed to remove linear from mcp-config: ${(err as Error).message}`);
  }
}

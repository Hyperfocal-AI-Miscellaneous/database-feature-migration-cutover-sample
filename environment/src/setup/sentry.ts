import * as fs from "fs";
import * as path from "path";
import type { Logger } from "@hyperfocal/env-base";
import {
  SentryService,
  type SentryConfigureOptions,
} from "@hyperfocal/mock-mcp-services/sentry";
import type { OnToolCall } from "@hyperfocal/mock-mcp-services/core";
import {
  mcpConfigPath,
  removeMcpServer,
  upsertMcpServer,
} from "./mcp-config.js";
import { regenerateTimestamps } from "./sentry-timestamps.js";

export function sentryDataDir(environmentRoot: string, problemId: string): string {
  return path.join(environmentRoot, "mock-data", problemId, "sentry");
}

export interface SentrySetupResult {
  service: SentryService;
  url: string;
  configPath: string;
}

export async function setupSentryProblem(opts: {
  problemId: string;
  environmentRoot: string;
  workspace: string;
  logger: Logger;
  onToolCall?: OnToolCall;
  metadataOverrides?: Omit<SentryConfigureOptions, "dataDir">;
  dataDir?: string;
}): Promise<SentrySetupResult> {
  const dataDir = opts.dataDir ?? sentryDataDir(opts.environmentRoot, opts.problemId);
  if (!fs.existsSync(dataDir)) {
    throw new Error(
      `Sentry fixture directory not found for problem '${opts.problemId}': ${dataDir}`,
    );
  }

  const service = new SentryService(opts.onToolCall ? { onToolCall: opts.onToolCall } : {});
  const configureOpts: SentryConfigureOptions = { dataDir, ...opts.metadataOverrides };
  service.configure(configureOpts);

  regenerateTimestamps(service);

  const { url } = await service.listen();
  opts.logger.info(`SentryService listening on ${url} (data: ${dataDir})`);

  const configPath = upsertMcpServer(opts.workspace, "sentry", {
    type: "http",
    url,
  });
  opts.logger.info(`Wrote MCP config to ${configPath}`);

  return { service, url, configPath };
}

export async function cleanupSentryProblem(opts: {
  service: SentryService | undefined;
  workspace: string;
  logger: Logger;
}): Promise<void> {
  if (opts.service && opts.service.isListening) {
    try {
      await opts.service.stop();
      opts.logger.info("SentryService stopped");
    } catch (err) {
      opts.logger.warn(`SentryService stop failed: ${(err as Error).message}`);
    }
  }

  const configPath = mcpConfigPath(opts.workspace);
  const existed = fs.existsSync(configPath);
  try {
    removeMcpServer(opts.workspace, "sentry");
    if (existed) {
      opts.logger.info(`Removed sentry entry from ${configPath}`);
    }
  } catch (err) {
    opts.logger.warn(`Failed to remove sentry from mcp-config: ${(err as Error).message}`);
  }
}

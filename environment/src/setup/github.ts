import * as fs from "fs";
import * as path from "path";
import type { Logger } from "@hyperfocal/env-base";
import { GitHubService } from "@hyperfocal/mock-mcp-services/github";
import type { OnToolCall } from "@hyperfocal/mock-mcp-services/core";
import {
  mcpConfigPath,
  removeMcpServer,
  upsertMcpServer,
} from "./mcp-config.js";

export function githubDataDir(environmentRoot: string, problemId: string): string {
  return path.join(environmentRoot, "mock-data", problemId, "github");
}

export function githubRepoDir(environmentRoot: string, problemId: string): string {
  return path.join(environmentRoot, "mock-data", problemId, "github-repo");
}

export interface GithubSetupResult {
  service: GitHubService;
  url: string;
  configPath: string;
}

export async function setupGithubProblem(opts: {
  problemId: string;
  environmentRoot: string;
  workspace: string;
  logger: Logger;
  onToolCall?: OnToolCall;
  owner?: string;
  name?: string;
  defaultBranch?: string;
  readOnly?: boolean;
  dataDir?: string;
  repoSource?: string;
}): Promise<GithubSetupResult> {
  const dataDir = opts.dataDir ?? githubDataDir(opts.environmentRoot, opts.problemId);
  if (!fs.existsSync(dataDir)) {
    throw new Error(
      `GitHub fixture directory not found for problem '${opts.problemId}': ${dataDir}`,
    );
  }
  const repoSource = opts.repoSource ?? githubRepoDir(opts.environmentRoot, opts.problemId);
  if (!fs.existsSync(repoSource)) {
    throw new Error(
      `GitHub seed repo not found for problem '${opts.problemId}': ${repoSource}`,
    );
  }

  const service = new GitHubService(opts.onToolCall ? { onToolCall: opts.onToolCall } : {});
  await service.configure({
    dataDir,
    repoSource,
    owner: opts.owner ?? "hyperfocal",
    name: opts.name ?? "demo",
    defaultBranch: opts.defaultBranch ?? "main",
    readOnly: opts.readOnly ?? false,
  });

  const { url } = await service.listen();
  opts.logger.info(`GitHubService listening on ${url} (data: ${dataDir})`);

  const configPath = upsertMcpServer(opts.workspace, "github", {
    type: "http",
    url,
  });
  opts.logger.info(`Wrote MCP config to ${configPath}`);

  return { service, url, configPath };
}

export async function cleanupGithubProblem(opts: {
  service: GitHubService | undefined;
  workspace: string;
  logger: Logger;
}): Promise<void> {
  if (opts.service && opts.service.isListening) {
    try {
      await opts.service.stop();
      opts.logger.info("GitHubService stopped");
    } catch (err) {
      opts.logger.warn(`GitHubService stop failed: ${(err as Error).message}`);
    }
  }

  const configPath = mcpConfigPath(opts.workspace);
  const existed = fs.existsSync(configPath);
  try {
    removeMcpServer(opts.workspace, "github");
    if (existed) {
      opts.logger.info(`Removed github entry from ${configPath}`);
    }
  } catch (err) {
    opts.logger.warn(`Failed to remove github from mcp-config: ${(err as Error).message}`);
  }
}

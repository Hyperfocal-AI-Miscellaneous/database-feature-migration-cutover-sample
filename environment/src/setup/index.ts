import type { Logger } from "@hyperfocal/env-base";
import { ensureDockerCompose } from "./docker.js";
import { createSshKeyPair } from "./keys.js";
import { setupSandbox } from "./sandbox.js";

export async function setupProblem(logger: Logger, problemId?: string): Promise<void> {
  const workspacePath = process.env.WORKSPACE_PATH;
  if (!workspacePath) throw new Error("WORKSPACE_PATH not set, cannot provision sandbox");

  logger.info(`=== Provisioning Docker sandbox for problem '${problemId ?? "default"}' ===`);

  await ensureDockerCompose(logger);
  const keyPath = await createSshKeyPair(workspacePath, logger);
  await setupSandbox(logger, workspacePath, keyPath, problemId);

  logger.info(`=== Docker sandbox provisioning complete ===`);
}

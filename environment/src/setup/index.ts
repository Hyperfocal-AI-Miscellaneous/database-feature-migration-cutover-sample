import type { Logger } from "@hyperfocal/env-base";
import { ensureDockerCompose } from "./docker.js";
import { createSshKeyPair } from "./keys.js";
import { setupCutover } from "./pg-cutover.js";
import { setupSlowQuery } from "./slow-query.js";
import { setupDeploymentFailure } from "./deployment-failure.js";
import { isDeploymentFailureProblem, isSlowQueryProblem } from "./scaffold.js";

export async function setupProblem(logger: Logger, problemId?: string): Promise<void> {
  const workspacePath = process.env.WORKSPACE_PATH;
  if (!workspacePath) throw new Error("WORKSPACE_PATH not set, cannot provision sandbox");

  const taskType = isDeploymentFailureProblem(problemId)
    ? "deployment-failure"
    : isSlowQueryProblem(problemId)
      ? "slow-query"
      : "cutover";
  logger.info(
    `=== Provisioning Docker sandbox (${taskType}) for problem '${problemId ?? "default"}' ===`,
  );

  await ensureDockerCompose(logger);
  const keyPath = await createSshKeyPair(workspacePath, logger);

  if (isDeploymentFailureProblem(problemId)) {
    await setupDeploymentFailure(logger, workspacePath, keyPath, problemId);
  } else if (isSlowQueryProblem(problemId)) {
    await setupSlowQuery(logger, workspacePath, keyPath, problemId);
  } else {
    await setupCutover(logger, workspacePath, keyPath, problemId);
  }

  logger.info(`=== Docker sandbox provisioning complete (${taskType}) ===`);
}

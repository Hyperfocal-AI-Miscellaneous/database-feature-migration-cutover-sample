import type { Logger } from "@hyperfocal/env-base";
import { dockerComposeWithExitCode } from "../clients/docker.js";

export async function cleanupSandbox(logger: Logger): Promise<void> {
  logger.info("=== Cleaning up Docker sandbox ===");

  const result = await dockerComposeWithExitCode("down -v --remove-orphans", { silent: false });

  if (result.exitCode === 0) {
    logger.info("Containers stopped and removed.");
  } else {
    logger.warn(`docker-compose down returned exit ${result.exitCode}: ${result.output}`);
  }

  logger.info("=== Cleanup complete ===");
}

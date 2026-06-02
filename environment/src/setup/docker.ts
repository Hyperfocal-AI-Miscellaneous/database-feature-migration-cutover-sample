import { execute, executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger } from "@hyperfocal/env-base";

export async function ensureDockerCompose(logger: Logger): Promise<void> {
  const check = await executeWithExitCode("docker-compose version", { silent: true });
  if (check.exitCode === 0) {
    logger.info(`docker-compose available: ${check.output.trim()}`);
    return;
  }
  logger.info("docker-compose not found, installing...");
  await execute(
    'curl -SL https://github.com/docker/compose/releases/download/v2.29.0/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose && chmod +x /usr/local/bin/docker-compose',
    { silent: true },
  );
  const verify = await executeWithExitCode("docker-compose version", { silent: true });
  if (verify.exitCode !== 0) {
    throw new Error("Failed to install docker-compose");
  }
  logger.info(`docker-compose installed: ${verify.output.trim()}`);
}

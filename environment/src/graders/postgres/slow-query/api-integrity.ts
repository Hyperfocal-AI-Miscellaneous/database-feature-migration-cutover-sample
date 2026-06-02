import { executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { APP_CONTAINER } from "../../../config.js";

export const apiCodeIntegrityTest: SimpleTest = {
  id: "api-code-unmodified",
  name: "API application code has not been modified",
  description: "Verifies the agent did not tamper with the API service code via docker exec",
  run: async (logger: Logger): Promise<SimpleTestResult> => {
    const { exitCode: diskExit, output: diskHash } = await executeWithExitCode(
      `md5sum /hyperfocal/env/sandbox/docker/api/server.js | cut -d' ' -f1`,
      { silent: true },
    );
    const { exitCode: containerExit, output: containerHash } = await executeWithExitCode(
      `docker exec ${APP_CONTAINER} md5sum /app/server.js | cut -d' ' -f1`,
      { silent: true },
    );

    if (diskExit !== 0 || containerExit !== 0) {
      return {
        success: false,
        error: `Could not compute checksums: disk=${diskHash}, container=${containerHash}`,
      };
    }

    const disk = diskHash.trim();
    const container = containerHash.trim();
    logger.info(`API server.js checksum, disk: ${disk}, container: ${container}`);

    if (disk !== container) {
      return {
        success: false,
        error: `API code was modified in the container. Expected ${disk}, got ${container}. The agent should fix database-level issues, not modify application code.`,
      };
    }

    return { success: true };
  },
};

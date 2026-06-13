import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { executeWithExitCode } from "@hyperfocal/env-base";
import {
  GITEA_IP,
  GITEA_ADMIN_USER,
  GITEA_ADMIN_PASS,
  DEPLOY_REPO,
} from "../config.js";

export const tests: SimpleTest[] = [
  {
    id: "pipeline-green",
    name: "Deployment pipeline completed successfully",
    weight: 3,
    description: "Agent pushed build + regression tests through Gitea; latest commit status is success",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const status = await executeWithExitCode(
        `curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" ` +
          `"http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${DEPLOY_REPO}/commits/main/status"`,
        { silent: true },
      );
      if (status.exitCode !== 0) {
        return { success: false, error: `Could not query Gitea pipeline status: ${status.output}` };
      }
      let data: { state?: string };
      try { data = JSON.parse(status.output); }
      catch { return { success: false, error: `Could not parse status response: ${status.output}` }; }
      const state = data.state ?? "pending";
      logger.info(`Pipeline state: ${state}`);
      if (state !== "success") {
        return { success: false, error: `Pipeline state is '${state}', expected 'success'` };
      }
      return { success: true };
    },
  },
];

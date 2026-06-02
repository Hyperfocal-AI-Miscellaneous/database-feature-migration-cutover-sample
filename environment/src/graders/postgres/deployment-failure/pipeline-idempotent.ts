import { executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import {
  APP_IP,
  APP_PORT,
  GITEA_IP,
  GITEA_ADMIN_USER,
  GITEA_ADMIN_PASS,
  GITEA_REPO_NAME,
} from "../../../config.js";

export const pipelineIdempotentTest: SimpleTest = {
  id: "pipeline-idempotent",
  name: "Pipeline is safe to re-run without re-corrupting data",
  description:
    "Push a no-op commit, wait for pipeline, verify totals are still correct. " +
    "Catches agents who fixed data but didn't make migrations idempotent.",
  run: async (logger: Logger): Promise<SimpleTestResult> => {
    const beforeResult = await executeWithExitCode(
      `curl -sf "http://${APP_IP}:${APP_PORT}/orders/totals?customer_id=1"`,
      { silent: true },
    );
    if (beforeResult.exitCode !== 0) {
      return { success: false, error: `Could not get pre-rerun totals: ${beforeResult.output}` };
    }
    const before = JSON.parse(beforeResult.output);
    const grossBefore = parseFloat(before.gross_total);
    const netBefore = parseFloat(before.net_total);
    logger.info(`Pre-rerun totals: gross=${grossBefore}, net=${netBefore}`);

    logger.info("Pushing no-op commit to trigger pipeline re-run...");
    const pushResult = await executeWithExitCode(
      `set -e
      WORK_DIR=$(mktemp -d)
      cd "$WORK_DIR"
      git clone "http://${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}@${GITEA_IP}:3000/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}.git" repo
      cd repo
      git config user.email "grader@hyperfocal.dev"
      git config user.name "hyperfocal-grader"
      echo "# Pipeline idempotency check - $(date -u +%s)" >> .pipeline-check
      git add -A
      git commit -m "chore: pipeline idempotency verification"
      git push origin main
      cd / && rm -rf "$WORK_DIR"`,
      { silent: true, timeout: 30_000 },
    );
    if (pushResult.exitCode !== 0) {
      return { success: false, error: `Could not push no-op commit: ${pushResult.output}` };
    }

    logger.info("Waiting for pipeline to complete after re-run...");
    let pipelineState = "pending";
    const maxWait = 5 * 60_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 10_000));
      const statusResult = await executeWithExitCode(
        `curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" "http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/commits/main/status"`,
        { silent: true },
      );
      if (statusResult.exitCode === 0) {
        const d = JSON.parse(statusResult.output);
        pipelineState = d.state;
        if (pipelineState === "success" || pipelineState === "failure" || pipelineState === "error") {
          break;
        }
      }
      logger.info(
        `Pipeline state: ${pipelineState} (${Math.round((Date.now() - start) / 1000)}s)...`,
      );
    }

    if (pipelineState !== "success") {
      return {
        success: false,
        error: `Pipeline failed after re-run (state: ${pipelineState}). Migrations may not be idempotent.`,
      };
    }
    logger.info("Pipeline succeeded on re-run.");

    const afterResult = await executeWithExitCode(
      `curl -sf "http://${APP_IP}:${APP_PORT}/orders/totals?customer_id=1"`,
      { silent: true },
    );
    if (afterResult.exitCode !== 0) {
      return { success: false, error: `Could not get post-rerun totals: ${afterResult.output}` };
    }
    const after = JSON.parse(afterResult.output);
    const grossAfter = parseFloat(after.gross_total);
    const netAfter = parseFloat(after.net_total);
    logger.info(`Post-rerun totals: gross=${grossAfter}, net=${netAfter}`);

    const tolerance = grossBefore * 0.005;
    if (Math.abs(grossAfter - grossBefore) > tolerance) {
      const pctChange = (((grossAfter - grossBefore) / grossBefore) * 100).toFixed(2);
      return {
        success: false,
        error: `gross_total changed by ${pctChange}% after pipeline re-run (${grossBefore} -> ${grossAfter}). Migrations are not idempotent, the pipeline re-applied the corruption.`,
      };
    }

    if (Math.abs(grossAfter - netAfter) > grossAfter * 0.001) {
      return {
        success: false,
        error: `net_total (${netAfter}) diverged from gross_total (${grossAfter}) after re-run. Discount corruption was re-applied.`,
      };
    }

    return { success: true };
  },
};

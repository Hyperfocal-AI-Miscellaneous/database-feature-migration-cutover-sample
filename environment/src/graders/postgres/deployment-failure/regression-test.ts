import { executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import {
  GITEA_IP,
  GITEA_ADMIN_USER,
  GITEA_ADMIN_PASS,
  GITEA_REPO_NAME,
} from "../../../config.js";
import { sourcePsql } from "../../../clients/psql.js";


export const regressionTestAddedTest: SimpleTest = {
  id: "regression-test-added",
  name: "Integration tests now validate order totals correctness",
  description:
    "The repo's test suite includes a test that checks gross_total == net_total or " +
    "validates totals against expected values",
  run: async (logger: Logger): Promise<SimpleTestResult> => {
    const migrationsResult = await sourcePsql(
      "SELECT count(*) FROM schema_migrations WHERE version > 2",
    );
    if (
      migrationsResult.exitCode === 0 &&
      parseInt(migrationsResult.output.trim(), 10) === 0
    ) {
      logger.info("Gold state (no perturbation applied), regression test not required");
      return { success: true };
    }

    const result = await executeWithExitCode(
      `curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" "http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/raw/tests/integration.test.js"`,
      { silent: true },
    );
    if (result.exitCode !== 0) {
      const pubResult = await executeWithExitCode(
        `curl -sf "http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/raw/tests/integration.test.js"`,
        { silent: true },
      );
      if (pubResult.exitCode !== 0) {
        return { success: false, error: "Could not fetch integration test file from repo" };
      }
      result.output = pubResult.output;
    }

    const testContent = result.output;
    logger.info(`Integration test file: ${testContent.length} chars`);

    const matchedPattern = TOTALS_VALIDATION_PATTERNS.find((p) => p.test(testContent));
    if (matchedPattern) {
      logger.info(`Found totals validation: matches pattern ${matchedPattern}`);
      return { success: true };
    }

    const lines = testContent.split("\n");
    const hasTotalsComparison = lines.some(
      (line) =>
        (line.includes("gross") && line.includes("net") && line.includes("assert")) ||
        (line.includes("gross") && line.includes("net") && line.includes("===")) ||
        (line.includes("gross") && line.includes("net") && line.includes("expect")),
    );

    if (hasTotalsComparison) {
      logger.info("Found totals comparison in test assertions");
      return { success: true };
    }

    return {
      success: false,
      error:
        "Integration tests do not validate totals correctness. The test file should " +
        "assert that gross_total equals net_total (or similar) to prevent this type of regression.",
    };
  },
};

const TOTALS_VALIDATION_PATTERNS: RegExp[] = [
  /gross_total\s*===?\s*net_total/i,
  /net_total\s*===?\s*gross_total/i,
  /gross.total.*===?.*net.total/i,
  /net.total.*===?.*gross.total/i,
  /assert.*gross.*net/i,
  /assert.*net.*gross/i,
  /expect.*gross.*equal.*net/i,
  /expect.*net.*equal.*gross/i,
  /discount.*===?\s*0/i,
  /discount.*should.*be.*0/i,
  /assert.*discount.*0/i,
  /net_total.*===?\s*gross_total/i,
  /parseFloat\(.*gross.*\)\s*===?\s*parseFloat\(.*net/i,
  /Math\.abs.*gross.*net/i,
];

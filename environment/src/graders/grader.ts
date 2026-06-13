import type { SimpleTest } from "@hyperfocal/env-base";
import { tests as featureTests } from "./feature-tests.js";
import { tests as deploymentTests } from "./deployment-tests.js";
import { tests as migrationTests } from "./migration-tests.js";
import { tests as cutoverTests } from "./cutover-tests.js";
import { tests as cleanupTests } from "./cleanup-tests.js";
import { createCodeMaintainabilityRubricTests } from "./code-maintainability-rubric.js";
import { createRegressionTestRubricTests } from "./regression-test-rubric.js";

export const tests: SimpleTest[] = [
  ...featureTests,
  ...deploymentTests,
  ...migrationTests,
  ...cutoverTests,
  ...cleanupTests,
  ...createCodeMaintainabilityRubricTests(),
  ...createRegressionTestRubricTests(),
];

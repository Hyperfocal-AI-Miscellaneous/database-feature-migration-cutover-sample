import type { SimpleTest } from "@hyperfocal/env-base";
import { deploymentFailureTests } from "./base.js";
import { pipelineIdempotentTest } from "./pipeline-idempotent.js";
import { regressionTestAddedTest } from "./regression-test.js";
import { createDeploymentFailureRubricTests } from "./rubric.js";

export { deploymentFailureTests } from "./base.js";
export { pipelineIdempotentTest } from "./pipeline-idempotent.js";
export { regressionTestAddedTest } from "./regression-test.js";
export { createDeploymentFailureRubricTests } from "./rubric.js";

export function getDeploymentFailureTests(_problemId: string): SimpleTest[] {
  return [
    ...deploymentFailureTests,
    pipelineIdempotentTest,
    regressionTestAddedTest,
    ...createDeploymentFailureRubricTests(),
  ];
}

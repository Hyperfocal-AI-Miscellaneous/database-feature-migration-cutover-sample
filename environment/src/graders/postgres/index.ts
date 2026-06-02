import type { SimpleTest } from "@hyperfocal/env-base";
import { cutoverTests } from "./cutover-grader.js";
import { getDeploymentFailureTests } from "./deployment-failure/index.js";
import { getSlowQueryTests } from "./slow-query/index.js";

export { cutoverTests } from "./cutover-grader.js";

export function getTestsForProblem(problemId: string): SimpleTest[] {
  if (problemId.startsWith("deployment-failure")) {
    return getDeploymentFailureTests(problemId);
  }
  if (problemId.startsWith("slow-query")) {
    return getSlowQueryTests(problemId);
  }
  return cutoverTests;
}

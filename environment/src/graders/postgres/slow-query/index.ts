import type { SimpleTest } from "@hyperfocal/env-base";
import { slowQueryTests } from "./base.js";
import { apiCodeIntegrityTest } from "./api-integrity.js";
import { recentQueryIndexTest, recentQueryExplainTest } from "./recent-query.js";
import { createSlowQueryRubricTests } from "./rubric.js";

export { slowQueryTests } from "./base.js";
export { apiCodeIntegrityTest } from "./api-integrity.js";
export { recentQueryIndexTest, recentQueryExplainTest } from "./recent-query.js";
export { createSlowQueryRubricTests } from "./rubric.js";

export function getSlowQueryTests(problemId: string): SimpleTest[] {
  const tests: SimpleTest[] = [...slowQueryTests, apiCodeIntegrityTest];
  if (problemId === "slow-query-minimal") {
    tests.push(recentQueryIndexTest, recentQueryExplainTest);
  }
  tests.push(...createSlowQueryRubricTests());
  return tests;
}

import type { GenerateFn } from "@hyperfocal/env-base";
import { createOpenRouterGenerateFn } from "@hyperfocal/env-base";
import { RUBRIC_JUDGE_MODEL } from "../config.js";

export function createRubricJudge(): GenerateFn {
  return createOpenRouterGenerateFn({ model: RUBRIC_JUDGE_MODEL });
}

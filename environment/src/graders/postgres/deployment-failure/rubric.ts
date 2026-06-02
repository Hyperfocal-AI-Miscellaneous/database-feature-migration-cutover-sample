import { createRubricTest } from "@hyperfocal/env-base";
import type { Logger, SimpleTest } from "@hyperfocal/env-base";
import { createRubricJudge } from "../judge.js";

export function createDeploymentFailureRubricTests(): SimpleTest[] {
  return [
    createRubricTest({
      id: "investigation-used-pipeline-history",
      name: "Agent used CI/CD pipeline history to identify the bad migration",
      description:
        "Evaluates whether the agent checked pipeline/commit history before fixing the issue",
      criteria: [
        {
          weight: 10,
          requirement: `The agent checked the CI/CD pipeline history (via Gitea's web UI, API,
or git log) to identify which deployment introduced the problem. This means
looking at recent commits, pipeline runs, or commit statuses in the Gitea
repository before attempting any fix. The agent should have identified the
specific migration that caused the data corruption.`,
          context: ["trace"],
        },
        {
          weight: 8,
          requirement: `The agent pushed a corrective migration through the CI/CD pipeline
(committed to the Gitea repo and let the pipeline run it) rather than
fixing the data directly via SQL on the database. Using the pipeline
demonstrates understanding of the deployment contract.`,
          context: ["trace"],
        },
        {
          weight: 5,
          requirement: `The agent verified the fix worked by checking the API response or
pipeline status after the corrective migration was deployed. The agent
should confirm that /orders/totals returns correct values.`,
          context: ["trace"],
        },
        {
          weight: -5,
          requirement: `The agent took harmful shortcuts: ran UPDATE directly on the database
without going through the pipeline, deleted orders or items to fix totals,
or modified the API code instead of fixing the data.`,
          context: ["trace"],
        },
      ],
      getContext: async (logger: Logger) => {
        logger.info("Reading agent trace for deployment failure investigation evaluation");
        const tracePath = process.env.AGENT_TRACE_PATH;
        let trace = "(no trace available)";
        if (tracePath) {
          try {
            const fs = await import("fs");
            trace = fs.readFileSync(tracePath, "utf-8");
          } catch {
            trace = "(trace file not readable)";
          }
        }
        return { trace };
      },
      generateFn: createRubricJudge(),
      passThreshold: 0.5,
    }),
  ];
}

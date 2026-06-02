# graders/

Tests that grade the agent's behavior at the end of a rollout. They verify outcomes (the API returns correct totals, the target Postgres accepts writes, the right Sentry issue was resolved), not just source code correctness.

There are two primary shapes:
- Deterministic graders that poll APIs, query the DB, inspect the Gitea repo, or compare hashes. Pass/fail is a boolean.
- Rubric graders (those ending in `*-rubric.ts`, `createSlowQueryRubricTests`, etc.) that feed context like agent traces or workspace snapshots to an LLM judge and score against weighted criteria. Pass threshold is a float.

Because there are multiple problems in this one codebase, `registry.ts` binds each problem id to the grader builders that run for it, including the Postgres sandbox each hybrid problem pairs with.

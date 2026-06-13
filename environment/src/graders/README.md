# graders/

Tests that grade the agent's behaviour at the end of a rollout. They verify
outcomes (the target Postgres accepts writes, the workload error rate stays
inside SLO, the Linear ticket was closed cleanly), not source-code
correctness in isolation.

Two shapes:

- **Deterministic graders.** Poll APIs, query the database, inspect the
  Gitea repo, compare hashes. Pass/fail is a boolean with an optional
  numeric score and a runtime weight override.
- **Rubric graders** (`code-maintainability-rubric.ts`,
  `regression-test-rubric.ts`). Feed
  source-code or test-file context to an LLM judge and score against
  weighted criteria. Pass threshold is a float.

## Layout

The cutover-task graders are split by SDLC phase so a reader can find a
test by where in the agent's workflow it fires:

| File | Phase | Tests |
|---|---|---|
| `feature-tests.ts` | Feature implementation | candidate-pg-running, patched-binary-present, timing-fields-exist, view-inheritance, vacuum-timing-accurate, analyze-timing-accurate, auto-fields-valid, regression-tests-pass |
| `deployment-tests.ts` | CI/CD pipeline | pipeline-green |
| `migration-tests.ts` | Schema + data migration | schema-aligned-on-target, sequences-aligned-on-target, data-items-migrated, data-orders-migrated, data-values-consistent, cdc-markers-replicated |
| `cutover-tests.ts` | Live traffic flip | app-config-updated, old-node-not-routing, app-healthy-post-cutover, workload-succeeds, post-cutover-write, downtime-acceptable, low-error-count-during-cutover |
| `cleanup-tests.ts` | Post-cutover cleanup | stale-replication-slot-cleaned, subscription-dropped-after-cutover, publication-dropped-on-source |
| `code-maintainability-rubric.ts` | LLM rubric over agent's C implementation | code-quality |
| `regression-test-rubric.ts` | LLM rubric over agent's regression tests | regression-test-quality |
| `shared.ts` | Helpers shared across the deterministic files | getRequiredEnv, pgbouncerRoutingHost, assertCutoverHappened, fetchAgentRegressionTests, PY_LOAD_WORKLOAD_LOG |
| `grader.ts` | Aggregator | composes all of the above into one `tests` array |
| `judge.ts` | OpenRouter judge factory used by the two rubrics |

`linear-grader.ts` adds Linear-MCP tests (issue-state progression,
comment-content patterns) attached to every problem variant.

## Registry

`registry.ts` maps each problem id to the deterministic test set from
`grader.ts` plus its Linear grader bundle. Every problem variant is
Linear-backed; there is no deterministic-only path.

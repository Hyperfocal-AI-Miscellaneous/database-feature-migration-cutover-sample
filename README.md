# database-feature-migration-cutover-sample

## Task
A live database cluster migration and cutover the agent has to drive end-to-end:
write a feature patch, ship it through a real CI/CD pipeline to a fresh
node, replicate live data while a continuous read/write workload runs, flip traffic
over a connection pool, and clean up.

## Grading

The 25 deterministic tests are split across SDLC phases:

| Phase | Tests | What's being graded |
|---|---|---|
| **Feature** | 8 | The agent's C patch is correct, the catalog/view exposes it, regression tests run |
| **Deployment** | 1 | The Gitea pipeline finishes green |
| **Migration** | 6 | Schema + sequences match between source and target; row counts converge; CDC markers land |
| **Cutover** | 7 | Pool flips backends; app stays healthy; downtime stays under SLO; error rate stays under SLO |
| **Cleanup** | 3 | Subscription dropped on target; publication dropped on source; stale slots gone |

Plus two LLM rubrics over the agent's C and their regression tests.

## Layout

```
environment/
  problems.yaml                 task prompts
  src/
    config.ts                   topology + grader thresholds
    clients/                    ssh, psql, gitea, http, docker, git, poll
    setup/                      provisioning + fixture planting
    graders/                    25 deterministic tests, split by SDLC
                                phase, plus two LLM rubrics
    graders/linear-grader.ts    Linear grader bundle
  mcp-data/                     Linear fixtures, one dir per problem variant
sandbox/docker/                 7-container compose (source, target, workload,
                                app, pgbouncer, gitea, gitea-runner)
workspace/postgres-src/         PG 17 source the agent edits
hyperfocal.yaml                 orchestrator config + agent disallowedTools
packages/                       env-base, env-orchestrator, env-builder,
                                mock-mcp-services submodules (internal-only)
```

## Variants

Two problems on the same Docker sandbox and grader. Both use a Linear
MCP runbook; the difference is whether the prompt itself includes
operational hints from past cutovers.

- `pg-cutover`: minimal prompt, no operational hints.
- `pg-cutover-hints`: same task, but the prompt mentions specific failure
  modes observed (schema drift, sequence sync, stale slots,
  subscription/publication cleanup).

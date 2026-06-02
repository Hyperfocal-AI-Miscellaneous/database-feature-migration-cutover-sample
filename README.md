# database-feature-migration-cutover-sample

Sample copy of one of our internal RL environments. Not runnable as-is —
submodules are pinned but uninitialised, the workspace isn't provisioned,
and prompts have been rewritten by hand for readability. The intent is to
read it.

Three task families on one sandbox:

- `pg-cutover-{guided,standard,realistic,minimal}` and `cutover-ops{,-sparse,-minimal}` — implement a vacuum/analyze timing feature in PG 17 C, build, deploy via Gitea CI/CD, replicate to a standby, cut workload over via PgBouncer.
- `slow-query-{minimal,realistic,guided}` — an API endpoint is over its p95 SLO; find the cause in Postgres, fix without changing API code.
- `deployment-failure-{minimal,realistic,standard}` — a migration corrupted order totals; trace it through the pipeline, push an idempotent fix.

`sentry-investigation`, `regression-triage`, and `cutover-ops*` drive the
same underlying tasks through mock Linear / Sentry / GitHub MCP services
under `packages/`.

## Layout

```
environment/
  problems.yaml                 task prompts
  docs/pg-cutover.md            design doc for the cutover task
  src/
    config.ts                   topology + grader thresholds
    clients/                    ssh, psql, gitea, http, docker, git, poll
    setup/                      per-task provisioning + fixture planting
    graders/postgres/           cutover, slow-query, deployment-failure
    graders/mcp/                linear, sentry, github
  mock-data/                    Linear/Sentry/GitHub fixtures per problem
sandbox/docker/                 7-container compose (source, target, workload,
                                app, pgbouncer, gitea, gitea-runner) plus
                                prometheus/grafana
workspace/postgres-src/         PG 17 source the agent edits
hyperfocal.yaml                 orchestrator config + agent disallowedTools
packages/                       env-base, env-orchestrator, env-builder,
                                mock-mcp-services submodules
```

The cutover task is the deepest of the three; `environment/docs/pg-cutover.md`
covers its topology, deploy pipeline, replication + cutover mechanics, setup
fixtures, and grading.

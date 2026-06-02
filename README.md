# database-feature-migration-cutover-sample

Sample copy of one of our internal RL environments. The agent implements a
per-relation vacuum/analyze timing feature in PostgreSQL 17 C, builds from
source with a versioned suffix, deploys via a Gitea CI/CD pipeline, sets up
logical replication to a standby, and cuts a live HTTP workload over via
PgBouncer.

Not runnable as-is — submodules are pinned but uninitialised, the workspace
isn't provisioned, and the prompts have been rewritten by hand. Read it for
the shape.

## Variants

Seven problems on one Docker sandbox:

- `pg-cutover-{guided,standard,realistic,minimal}` — bare-prompt tiers,
  same task at progressively less prompt detail.
- `cutover-ops`, `cutover-ops-sparse`, `cutover-ops-minimal` — Linear-MCP
  tiers, identical prompts but the runbook the agent reads through the
  ticket varies (full multi-phase runbook → single paragraph → empty with
  conventions in a postmortem comment).

## Layout

```
environment/
  problems.yaml                 task prompts
  docs/pg-cutover.md            design doc
  src/
    config.ts                   topology + grader thresholds
    clients/                    ssh, psql, gitea, http, docker, git, poll
    setup/                      provisioning + fixture planting
    graders/postgres/           25 deterministic tests + 2 LLM rubrics
    graders/mcp/                Linear grader for the cutover-ops* tiers
  mock-data/                    Linear fixtures, one tree per runbook tier
sandbox/docker/                 7-container compose (source, target, workload,
                                app, pgbouncer, gitea, gitea-runner)
workspace/postgres-src/         PG 17 source the agent edits
hyperfocal.yaml                 orchestrator config + agent disallowedTools
packages/                       env-base, env-orchestrator, env-builder,
                                mock-mcp-services submodules
```

`environment/docs/pg-cutover.md` is the reference for the task — topology,
deploy pipeline, replication + cutover mechanics, setup fixtures, grading
shape.

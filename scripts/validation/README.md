# Validation runbook

End-to-end manual checks for the Hyperfocal Postgres environment. Each
numbered stage is standalone; each exits non-zero on failure. Intended
for human operators before merging structural changes, and as the
reproducibility surface anyone can re-run to confirm the environment
is healthy end-to-end.

## Prerequisites

- `/hyperfocal/env` is the working copy. Override with `ENV_ROOT=...`.
- Docker daemon reachable.
- `npm` and `npx` on PATH.
- Stages 00, 01, 06, 07, 08 have no docker prerequisites.
- Stages 02-04, 09 require docker images already built (cold-cache PG
  17 build is ~10-15 min for the cutover target image).
- Stage 09 requires `ANTHROPIC_API_KEY` in the environment.

## Stages

| # | script | what it validates | typical runtime |
|---|---|---|---|
| 00 | [`00-build.sh`](./00-build.sh) | env-base + env-orchestrator + environment build cleanly. `npx env-orchestrator problems` lists every expected id. manifest-schema.json parses. | <30s |
| 01 | [`01-workspace-bake.sh`](./01-workspace-bake.sh) | `workspace/postgres-src/` is tracked, version 17.4, no longer in `.gitignore`. Simulated agent edits to tracked + untracked files reset cleanly via `git restore` + `git clean`. | <5s |
| 02 | [`02-slow-query-gold.sh`](./02-slow-query-gold.sh) | `setup --problem slow-query-guided` brings up source + api + workload + observability. Gold-state grader passes >=5 deterministic tests. Cleanup leaves zero hyperfocal containers. | ~3m |
| 03 | [`03-deployment-failure-gold.sh`](./03-deployment-failure-gold.sh) | `setup --problem deployment-failure-standard` brings up the slow-query topology plus Gitea + runner. Perturbation is applied and the grader correctly detects the corruption (>=1 failed test). | ~5m |
| 04 | [`04-cutover-gold.sh`](./04-cutover-gold.sh) | `setup --problem pg-cutover-minimal` brings up source + target + workload. workspace/postgres-src is restored. Target ships a vanilla PG binary. | ~5m (warm cache) |
| 06 | [`06-mcp-fixture-shape.sh`](./06-mcp-fixture-shape.sh) | Each hybrid problem has its mock-data directory and the target culprits / identifiers referenced by the grader registry are present in the fixtures. | <1s |
| 07 | [`07-prompt-interpolation.sh`](./07-prompt-interpolation.sh) | Every problem's resolved prompt is free of `{{...}}` tokens. Spot-checks that pg-cutover-standard contains the source IP and the manifest schema description, and that sentry-investigation contains the API host. | ~10s |
| 08 | [`08-em-dash-free.sh`](./08-em-dash-free.sh) | `problems.yaml`, `README.md`, and `environment/docs/*.md` contain zero em/en-dashes. | <1s |
| 09 | [`09-full-rollout.sh`](./09-full-rollout.sh) | Optional. `rollout --problem slow-query-guided` runs end-to-end with a real agent and produces a test summary line. Sanity, not quality. | 15-40m |

## Running

```bash
# All non-rollout stages, sequential
for s in scripts/validation/0[0-8]-*.sh; do
  bash "$s" || { echo "stage failed: $s"; exit 1; }
done

# Single stage with a different problem
PROBLEM=slow-query-realistic bash scripts/validation/02-slow-query-gold.sh

# Optional end-to-end with a real agent
ANTHROPIC_API_KEY=... bash scripts/validation/09-full-rollout.sh
```

## Expected calibration

### Stage 02: slow-query-guided gold

- 5+ deterministic tests pass: `latency-within-slo`, `index-exists`,
  `explain-uses-index`, `api-functional`, `row-count-unchanged`,
  `api-code-unmodified`.
- `investigation-quality` rubric will fail or error on bare gold (no
  agent trace exists). This is expected and not counted by the stage.

### Stage 03: deployment-failure-standard perturbed

- After perturbation, `api-returns-correct-totals` and
  `data-integrity-restored` MUST fail. If both pass, the perturbation
  setup never ran.
- `pipeline-green-after-fix` may pass or fail depending on whether the
  bad migration crashes the next pipeline run.

# PostgreSQL Engine Modification + Live Cutover

Design doc for the cutover task. The executable counterpart lives in
`environment/src/graders/postgres/cutover-grader.ts` and
`environment/src/setup/pg-cutover.ts`.

## 1. Status and metadata

| Field | Value |
|---|---|
| Problem IDs (bare-prompt) | `pg-cutover-guided`, `pg-cutover-standard`, `pg-cutover-realistic`, `pg-cutover-minimal` |
| Problem IDs (Linear-MCP) | `cutover-ops`, `cutover-ops-sparse`, `cutover-ops-minimal` |
| SDLC phases exercised | C implementation, build system, regression testing, CI/CD deploy, logical replication, connection pool management, live cutover. The MCP variants additionally exercise ticket-tracking discipline (status transitions, manifest comments, document reads) via Linear. |
| Grading shape | 25 deterministic tests + 2 LLM rubrics (code-quality, regression-test-quality). MCP variants append 7 Linear progression/comment-content tests. |
| Estimated human completion | 2–4 hours |

### Difficulty variant summary

| Variant | Feature spec | Build hints | Deployment | Data migration | Container discovery |
|---|---|---|---|---|---|
| `guided` | Exact files + code changes for 8 PG source files | Exact `./configure` line | Exact CI/CD push commands | Exact subscription SQL | `.sandbox-connection.env` |
| `standard` | Behavioral description (no file list) | "Build with `-hyperfocal`" | "Push to the deploy pipeline" | "Use a mechanism that captures changes" | `.sandbox-connection.env` |
| `realistic` | DBA ticket (no implementation hints) | "Tag with `-hyperfocal`" | "Deploy to standby" | "Ensure writes available on new node" | `docker ps --filter label=project=hyperfocal` |
| `minimal` | One paragraph | "Build with `-hyperfocal` suffix" | "Deploy to standby" | "Workload has writes" | `docker ps` with label filters |
| `cutover-ops` | Full multi-phase runbook in a Linear document attached to the project | In the runbook | In the runbook | Logical replication called out explicitly | `.sandbox-connection.env` |
| `cutover-ops-sparse` | Single-paragraph runbook | "Build with the `-hyperfocal` extra-version tag" | "Use the existing CI/CD pipeline" | "Don't lose data; logical replication is the supported approach" | `.sandbox-connection.env` |
| `cutover-ops-minimal` | Empty `documents.json`; agent derives conventions from `DBA-103`'s historical postmortem comment | Implicit (in DBA-103 only) | Implicit | Implicit | `docker ps` with label filters |

The MCP variants (`cutover-ops*`) share the same sandbox and grading core as
the bare-prompt variants; what changes is *where* the spec lives. The agent
sees a short "find your Linear ticket and execute the cutover" prompt; the
work detail lives in `environment/mock-data/<problem-id>/linear/{issues,
documents,…}.json` served via a mock Linear MCP server
(`packages/mock-mcp-services`).

## 2. Network topology

```
                         172.20.0.0/24 (bridge: hyperfocal)
 ____________|______________|______________|______________|______________|______________|_________
|            |              |              |              |              |              |         |
| source     | target       | workload     | app          | pgbouncer    | gitea        | runner  |
| .10        | .11          | .12          | .13          | .14          | .30          | .31     |
|            |              |              |              |              |              |         |
| PG 17.4    | Vanilla PG   | HTTP client  | Express API  | PgBouncer    | Git + CI     | act_    |
| wal_level= | from source  | 3 workers    | :8080        | session pool | hyperfocal/  | runner  |
|  logical   | /usr/local/  | (70R/30W)    | -> pgbouncer | :5432        | pg-deploy    | executes|
| 1000 items |  pgsql/      | + CDC writer | /health      | -> source    | repo         | pipeline|
| 3M orders  | NOT RUNNING  |              | reports      |   (initially)|              | jobs    |
| trust auth | No cluster   | Logs ->      |  backend IP  | -> target    |              |         |
|            |              |  workload.   |              |   (after     |              |         |
|____________|______________|  jsonl       |______________|  cutover)____|______________|_________|

Workload traffic path:
  workload -> http://app:8080/* -> pgbouncer:5432 -> source (pre-cutover)
                                                  \-> target (post-cutover)

CDC markers bypass app + pgbouncer:
  workload -> psql -> source (always, via pg_endpoint file)

Deployment pipeline path:
  agent: make install -> /usr/local/pgsql/ (host bind-mount)
  agent: git push -> gitea:pg-deploy
  gitea-runner: reads /usr/local/pgsql via mount
              -> rsync to target -> initdb + start + run regression tests
```

## 3. Containers

**source (`hyperfocal-source`, 172.20.0.10)** — PG 17.4 from Amazon Linux
repos. `wal_level=logical`, trust auth, seeded with 1 000 items and
3 000 000 orders. SSH as `ec2-user` with passwordless sudo.

**target (`hyperfocal-target`, 172.20.0.11)** — Vanilla PG 17.4 built from
source during Docker build. Vanilla binary at `/usr/local/pgsql/bin/postgres`;
agent replaces it via the CI/CD pipeline. Data dir empty at setup. Build
deps pre-installed.

**workload (`hyperfocal-workload`, 172.20.0.12)** — 3 parallel HTTP workers
(70% reads, 30% writes) hitting `app` at the `api_endpoint`. 1 CDC marker
worker writing directly to source via `pg_endpoint`. Log at
`/var/log/hyperfocal/workload.jsonl`. **Agent key not injected** — the
workload only accepts the grader key so the agent cannot tamper with the
event log.

**app (`hyperfocal-app`, 172.20.0.13:8080)** — Express/Node, connects to
PgBouncer via a connection pool. `GET /health` returns the live DB backend
via `inet_server_addr()` — that's how the grader confirms the cutover
actually flipped the pool, not just the workload's endpoint file. No SSH.

**pgbouncer (`hyperfocal-pgbouncer`, 172.20.0.14:5432)** — Session pooling.
Admin interface at `psql -h localhost -U pgbouncer pgbouncer`. Initial
backend is source; agent edits `/etc/pgbouncer/pgbouncer.ini` and reloads
during cutover.

**gitea (`hyperfocal-gitea`, 172.20.0.30:3000)** — Hosts the
`hyperfocal/pg-deploy` repo. Admin creds in `.hyperfocal/cicd-credentials.env`.
Pipeline runs on push to `main`. No SSH; agent interacts via HTTP/git only.

**gitea-runner (`hyperfocal-gitea-runner`, 172.20.0.31)** — Executes
pipeline jobs as short-lived containers with two host bind-mounts:
`/usr/local/pgsql:/build:ro` (where the agent's `make install` lands)
and `/tmp/hyperfocal-deploy-key.pem:/runner/deploy-key:ro`.

## 4. Database schema

```
items (1 000 rows)                  orders (3 000 000 rows)
-----                               ------
id          SERIAL PRIMARY KEY      id          SERIAL PRIMARY KEY
name        TEXT                    item_id     INTEGER FK items(id)
value       INTEGER                 customer_id INTEGER
                                    status      VARCHAR(20)
                                    quantity    INTEGER
                                    discount    NUMERIC DEFAULT 0
                                    created_at  TIMESTAMP

                       -- planted by setup AFTER seed --
                                    archived_at        TIMESTAMPTZ
                                    customer_segment   TEXT
                                    fulfillment_notes  TEXT
```

The three columns under "planted by setup" are the schema-drift fixture (see
§7). Target's vanilla initdb creates `orders` without them.

## 5. The feature

The agent implements four cumulative timing columns on `pg_stat_all_tables`:

| Column | Type | Semantics |
|---|---|---|
| `total_vacuum_time` | double precision | Cumulative ms for manual VACUUM |
| `total_autovacuum_time` | double precision | Cumulative ms for autovacuum daemon |
| `total_analyze_time` | double precision | Cumulative ms for manual ANALYZE |
| `total_autoanalyze_time` | double precision | Cumulative ms for autoanalyze daemon |

Inherit automatically to `pg_stat_user_tables` and `pg_stat_sys_tables`.

### Files modified (~130 lines total)

| File | Changes |
|---|---|
| `src/include/pgstat.h` | Four `PgStat_Counter` fields on `PgStat_StatTabEntry`. Update `pgstat_report_vacuum()`/`_analyze()` signatures. Bump `PGSTAT_FILE_FORMAT_ID`. |
| `src/backend/utils/activity/pgstat_relation.c` | Compute elapsed via `TimestampDifferenceMilliseconds(starttime, GetCurrentTimestamp())`; accumulate into the correct field based on `AmAutoVacuumWorkerProcess()`. |
| `src/backend/access/heap/vacuumlazy.c` | Move `starttime = GetCurrentTimestamp()` out of the instrumentation conditional. Pass to `pgstat_report_vacuum()`. |
| `src/backend/commands/analyze.c` | Same pattern for analyze. |
| `src/backend/utils/adt/pgstatfuncs.c` | Define `PG_STAT_GET_RELENTRY_FLOAT8` macro; instantiate four accessors. |
| `src/backend/catalog/system_views.sql` | Four new columns on the `pg_stat_all_tables` view. |
| `src/include/catalog/pg_proc.dat` | Four function entries (`proargtypes='oid'`, `prorettype='float8'`). |
| `src/include/catalog/catversion.h` | Bump `CATALOG_VERSION_NO`. |

### Build

```
cd postgres-src
./configure --prefix=/usr/local/pgsql --with-extra-version=-hyperfocal
make -j$(nproc) && make install
```

The `-hyperfocal` suffix is required — `patched-binary-present` checks for
it in `postgres --version`.

## 6. Cutover

### 6.1 Deploy via CI/CD

```
agent: make install                  -> /usr/local/pgsql/ (host bind-mount)
agent: clone pg-deploy + add tests   -> regression-tests/*.sql
agent: git push origin main
gitea-runner: deploy.yml
  - verify /build/bin/postgres exists
  - rsync /build/ -> target:/usr/local/pgsql/
  - initdb, configure pg_hba, start postgres
  - run regression-tests/*.sql against target
```

The `pipeline-green` grader checks the pipeline state at
`http://gitea:3000/api/v1/repos/hyperfocal/pg-deploy/commits/main/status`.

### 6.2 Logical replication

Workload writes continuously, so `pg_dump` misses recent activity. Logical
replication captures ongoing changes.

```sql
-- source:
CREATE PUBLICATION hyperfocal_pub FOR ALL TABLES;
-- target:
CREATE SUBSCRIPTION hyperfocal_sub
  CONNECTION 'host=172.20.0.10 dbname=postgres user=postgres'
  PUBLICATION hyperfocal_pub;
```

**Schema must be synced first** (see §7) or replication fails silently with
`column "..." does not exist`.

**Sequences must be synced at cutover time** — logical replication does NOT
copy sequence state. Source's `orders_id_seq` is at ~3M; target's is at 1.
First INSERT on target collides with already-migrated rows without a
`setval` with safety margin.

### 6.3 Traffic flip via PgBouncer

```bash
ssh -i ./hyperfocal-key.pem ec2-user@172.20.0.14
psql -h localhost -p 5432 -U pgbouncer pgbouncer -c "PAUSE"
sudo sed -i 's/172.20.0.10/172.20.0.11/' /etc/pgbouncer/pgbouncer.ini
psql -h localhost -p 5432 -U pgbouncer pgbouncer -c "RELOAD"
psql -h localhost -p 5432 -U pgbouncer pgbouncer -c "RESUME"
```

`PAUSE` drains in-flight transactions. Skipping it kills server connections
mid-flight and breaks the app's named prepared statement on
`/orders/by-customer` — visible as a burst of 500s in the workload log
that the `low-error-count-during-cutover` test catches even when the
consecutive-error window stays small.

### 6.4 Post-cutover cleanup

`DROP SUBSCRIPTION` on target and `DROP PUBLICATION` on source. The
`subscription-dropped-after-cutover` and `publication-dropped-on-source`
tests check both. Leaving them retains WAL on source indefinitely and
risks split-brain replay.

## 7. Setup fixtures

`environment/src/setup/pg-cutover.ts` plants three fixtures the runbook
deliberately does not mention. They measure DBA instinct, not
runbook-following.

**Abandoned replication slot.** A dormant `abandoned_cutover_slot` slot
created on source before the agent starts. A pre-flight `SELECT * FROM
pg_replication_slots` catches it; agents who skip pre-flight leave it
holding WAL forever. Tested by `stale-replication-slot-cleaned`.

**Abandoned publication.** A dormant `abandoned_cutover_pub` publication
on source. Parallel to the slot fixture but tested post-cutover —
measures source-cleanup discipline. Tested by `publication-dropped-on-source`.

**Schema drift.** Three extra columns (`archived_at`, `customer_segment`,
`fulfillment_notes`) added to source's `orders` table AFTER seed.
Target's vanilla initdb (run via the agent's deploy pipeline) creates
`orders` from the agent's CREATE TABLE — without these columns unless
the agent dumps source's schema first. Tested by `schema-aligned-on-target`.
Hint placement is asymmetric across runbook tiers: standard mentions
schema-sync explicitly; sparse and minimal do not.

## 8. Grading

25 deterministic tests + 2 LLM rubrics. See
`environment/src/graders/postgres/cutover-grader.ts` for the full list and
weights.

### 8.1 Weights

Range from 0.5 (cascading hygiene tests where failure already implies
other failures) to 10 (single biggest signal: `post-cutover-write`).
Data-correctness tests (`data-items-migrated`, `data-orders-migrated`,
`data-values-consistent`) carry 5 each. Cutover-quality tests
(`downtime-acceptable`, `low-error-count-during-cutover`,
`workload-succeeds`) carry 8–10.

### 8.2 Severity-escalated weights

Two tests use `SimpleTestResult.weight` runtime override to escalate when
the failure is catastrophic:

- `downtime-acceptable` — base weight 9. If observed downtime exceeds
  **2×** `MAX_DOWNTIME_SECS`, weight escalates to 12.
- `low-error-count-during-cutover` — base weight 10. If observed error
  *rate* exceeds **5×** `MAX_WORKLOAD_ERROR_RATE_PCT`, weight escalates
  to 14.


### 8.3 Window-rate error model

`MAX_WORKLOAD_ERROR_RATE_PCT = 2.0` over any 30-second window in
`workload.jsonl`. This used to be an absolute count
(`MAX_WORKLOAD_ERRORS = 15`) but a clean cutover producing 23 transient
errors across a 90-minute run (~0.1% overall) failed the threshold
despite being operationally healthy. The window-rate check focuses on
"did the cutover cause a burst of failures" instead.

Catches both:
- **KILL-style cutovers** — forcibly drops in-flight server connections
  on PgBouncer admin; produces a high-rate burst in one window.
- **Sustained low-grade failure** — replication lag, broken auth.

### 8.4 LLM rubrics

`code-rubric.ts` — judge evaluates the agent's C implementation across
six weighted criteria (pattern fidelity in `pgstat_relation.c`, signature
plumbing across the call chain, file scope, accessor registration
consistency, idiomatic C, anti-shortcut penalty). Uses pattern-anchored
section extraction (see `fitWindows`) to keep judge prompts under context
limits; anchors are PG-defined identifiers only, so agent renames don't
silently produce zero extraction.

`regression-rubric.ts` — judge evaluates the agent's regression tests
(VACUUM/ANALYZE timing assertions, expected output files present,
PostgreSQL test conventions, no fragile assertions).

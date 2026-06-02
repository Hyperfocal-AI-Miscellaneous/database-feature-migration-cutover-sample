import { Logger, SimpleTest, createRubricTest } from "@hyperfocal/env-base";
import * as fs from "fs";
import * as path from "path";
import { createRubricJudge } from "./judge.js";

export function createCodeRubricTests(): SimpleTest[] {
  return [
    createRubricTest({
      id: "code-quality",
      name: "Feature implementation quality",
      description: "Evaluates the agent's implementation of per-relation vacuum/analyze cumulative timing statistics",
      criteria: [
        {
          weight: 10,
          requirement: `The core timing logic is correctly implemented in pgstat_relation.c:
both pgstat_report_vacuum() and pgstat_report_analyze() accept a new
TimestampTz starttime parameter, compute elapsed time using
TimestampDifferenceMilliseconds(starttime, GetCurrentTimestamp()) or
equivalent, and accumulate the result into the correct field on
PgStat_StatTabEntry based on whether it is an autovacuum worker
(AmAutoVacuumWorkerProcess()). Manual vacuum goes to total_vacuum_time,
autovacuum goes to total_autovacuum_time, manual analyze goes to
total_analyze_time, autoanalyze goes to total_autoanalyze_time.`,
          context: ["code"],
        },
        {
          weight: 8,
          requirement: `The stats infrastructure is correctly updated in pgstat.h:
PgStat_StatTabEntry has four new PgStat_Counter fields (total_vacuum_time,
total_autovacuum_time, total_analyze_time, total_autoanalyze_time).
PGSTAT_FILE_FORMAT_ID is bumped (any new value). The function declarations
for pgstat_report_vacuum() and pgstat_report_analyze() are updated to
include the new TimestampTz starttime parameter.`,
          context: ["code"],
        },
        {
          weight: 7,
          requirement: `Four new SQL-callable functions are implemented in pgstatfuncs.c using
the PG_STAT_GET_RELENTRY pattern. The implementation should define a
PG_STAT_GET_RELENTRY_FLOAT8 macro (parallel to the existing
PG_STAT_GET_RELENTRY_INT64 macro) that returns double precision values,
and instantiate four functions: pg_stat_get_total_vacuum_time,
pg_stat_get_total_autovacuum_time, pg_stat_get_total_analyze_time,
pg_stat_get_total_autoanalyze_time. These must be registered in
pg_proc.dat with OID allocations, taking oid input and returning float8.`,
          context: ["code"],
        },
        {
          weight: 6,
          requirement: `The system_views.sql file is updated to add the four new columns to the
pg_stat_all_tables view definition, calling the new SQL functions with
C.oid as the argument. The columns should appear after the existing
count columns (vacuum_count, autovacuum_count, analyze_count,
autoanalyze_count). The pg_stat_sys_tables and pg_stat_user_tables views
inherit these columns automatically.`,
          context: ["code"],
        },
        {
          weight: 5,
          requirement: `The starttime capture pattern is correctly changed in both vacuumlazy.c
and analyze.c: the GetCurrentTimestamp() call that captures starttime is
moved OUT of the conditional if-block that guards instrumentation/verbose
logging, so that starttime is captured unconditionally before the
operation begins. The starttime is then passed to the pgstat_report
function. Previously starttime was only captured when verbose logging
was enabled; now it must always be captured for stats reporting.`,
          context: ["code"],
        },
        {
          weight: -3,
          requirement: `The implementation introduces unnecessary or harmful changes: modifying
files not related to the feature, adding debug printf/elog output,
changing the return type or behavior of existing functions beyond adding
the starttime parameter, breaking existing statistics fields, or
leaving TODO/FIXME comments. The catversion.h bump and pg_proc.dat
entries are expected changes and should NOT be considered unnecessary.`,
          context: ["code"],
        },
      ],
      getContext: async (logger: Logger) => {
        logger.info("Reading agent's modified PostgreSQL source files");
        const code = readWorkspaceCode();
        return { code };
      },
      generateFn: createRubricJudge(),
      passThreshold: 0.6,
    }),
  ];
}

const PG_SRC_FILES = [
  "src/backend/utils/activity/pgstat_relation.c",
  "src/backend/utils/adt/pgstatfuncs.c",
  "src/backend/access/heap/vacuumlazy.c",
  "src/backend/commands/analyze.c",
  "src/backend/catalog/system_views.sql",
  "src/include/pgstat.h",
  "src/include/catalog/pg_proc.dat",
  "src/include/catalog/catversion.h",
];

function readWorkspaceCode(): string {
  const workspacePath = process.env.WORKSPACE_PATH || "/hyperfocal/env/workspace";
  const pgSrcDir = path.join(workspacePath, "postgres-src");

  return PG_SRC_FILES.map((f) => {
    const p = path.join(pgSrcDir, f);
    try {
      return `=== ${f} ===\n${fs.readFileSync(p, "utf-8")}`;
    } catch {
      return `=== ${f} ===\n(file not found)`;
    }
  }).join("\n\n");
}

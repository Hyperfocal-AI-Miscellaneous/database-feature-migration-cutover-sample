/**
 * Code quality rubric for the per-relation vacuum/analyze timing feature.
 *
 * Uses an LLM judge (via OpenRouter) to evaluate the agent's PostgreSQL C
 * implementation against weighted criteria covering pattern fidelity,
 * signature plumbing, scope, registration consistency, and API hygiene.
 *
 * Context strategy: rather than sending entire source files (which easily
 * exceed judge context limits), we extract only the sections relevant to
 * the feature. This avoids "Empty response from judge LLM" errors caused
 * by oversized requests.
 */

import { Logger, SimpleTest, createRubricTest } from "@hyperfocal/env-base";
import * as fs from "fs";
import * as path from "path";
import { createRubricJudge } from "./judge.js";

/**
 * Per-file budget. Modern judges (Sonnet/Opus) handle ~1000 lines per file
 * comfortably; an earlier 250-line cap silently dropped later-occurring
 * matches in long files (vacuumlazy.c ~3200 lines, analyze.c ~3000,
 * pgstat.h ~780) because `slice(0, MAX)` kept only the lowest-line-number
 * context. That caused the judge to legitimately report "no evidence of X"
 * when X was just past the cutoff — most notably the pgstat_report_* call
 * sites that live deep in vacuum/analyze, far from the starttime
 * declaration.
 */
const MAX_SECTION_LINES = 1000;

/** Default context per hit. ±30/+90 covers a typical PG backend function body. */
const DEFAULT_BACKWARD = 30;
const DEFAULT_FORWARD = 90;
/** Minimum context floor when the budget forces the window to shrink. */
const MIN_BACKWARD = 5;
const MIN_FORWARD = 15;

/**
 * Union ±backward/+forward windows around every hit. If the union exceeds
 * the per-file budget, shrink the window proportionally and retry —
 * preserves contiguous code blocks around every hit instead of silently
 * dropping later hits whose context would have pushed the file over.
 */
function fitWindows(hits: number[], lineCount: number, max: number): Set<number> {
  let backward = DEFAULT_BACKWARD;
  let forward = DEFAULT_FORWARD;
  while (true) {
    const set = new Set<number>();
    for (const h of hits) {
      for (let j = Math.max(0, h - backward); j <= Math.min(lineCount - 1, h + forward); j++) {
        set.add(j);
      }
    }
    if (set.size <= max) return set;
    if (backward <= MIN_BACKWARD && forward <= MIN_FORWARD) return set;
    backward = Math.max(MIN_BACKWARD, Math.floor(backward * 0.8));
    forward = Math.max(MIN_FORWARD, Math.floor(forward * 0.8));
  }
}

/**
 * Extract lines from a file surrounding pattern matches. Every match keeps
 * contiguous local context; if the file is too dense, windows shrink
 * uniformly rather than dropping later hits entirely.
 */
function extractSection(filePath: string, patterns: RegExp[], label: string): string {
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const hits: number[] = [];
    const seen = new Set<number>();
    for (const pat of patterns) {
      lines.forEach((l, i) => {
        if (pat.test(l) && !seen.has(i)) {
          seen.add(i);
          hits.push(i);
        }
      });
    }
    if (hits.length === 0) return `=== ${label} ===\n(pattern not found in file)`;

    const included = fitWindows(hits, lines.length, MAX_SECTION_LINES);
    const sortedIdxs = [...included].sort((a, b) => a - b);
    const extracted = sortedIdxs.map((i) => `${i + 1}: ${lines[i]}`).join("\n");
    return `=== ${label} (${lines.length} lines total, showing ${sortedIdxs.length} relevant around ${hits.length} match(es)) ===\n${extracted}`;
  } catch {
    return `=== ${label} ===\n(file not found)`;
  }
}

function readWorkspaceCode(): string {
  const workspacePath = process.env.WORKSPACE_PATH || "/hyperfocal/env/workspace";
  const pgSrcDir = path.join(workspacePath, "postgres-src");
  const j = (f: string) => path.join(pgSrcDir, f);

  const sections: string[] = [];

  // Anchor patterns intentionally use only PG-defined identifiers — never
  // agent-chosen field/function names like total_vacuum_time. Agents have
  // naming freedom per the rubric criteria, so anchoring on their chosen
  // names would silently produce zero extraction (and zero rubric score)
  // for any agent that used a non-standard name. The PG-defined anchors
  // sit adjacent to where the agent's additions naturally land, so ±30/+90
  // windows around them capture the new code regardless of its naming.

  // pgstat_relation.c — the two report functions. Anchors: the PG entry-
  // point names, the timestamp-diff helper, the autovacuum predicate, and
  // the per-table entry type. All of these surround any reasonable timing
  // implementation.
  sections.push(extractSection(
    j("src/backend/utils/activity/pgstat_relation.c"),
    [/pgstat_report_vacuum|pgstat_report_analyze|TimestampDifferenceMilliseconds|AmAutoVacuumWorkerProcess|PgStat_StatTabEntry/],
    "pgstat_relation.c",
  ));

  // pgstatfuncs.c — the new accessor macro and its four invocations.
  // Anchors: any macro in the PG_STAT_GET_RELENTRY_* family (the existing
  // INT64 / TIMESTAMPTZ macros are still present, so the agent's new FLOAT8
  // variant lands in the same area), and the fetch helper every RELENTRY
  // macro uses internally.
  sections.push(extractSection(
    j("src/backend/utils/adt/pgstatfuncs.c"),
    [/PG_STAT_GET_RELENTRY|pgstat_fetch_stat_tabentry/],
    "pgstatfuncs.c",
  ));

  // vacuumlazy.c — starttime capture and pgstat_report_vacuum call.
  // Both anchors are PG-defined; no agent-chosen names.
  sections.push(extractSection(
    j("src/backend/access/heap/vacuumlazy.c"),
    [/starttime|pgstat_report_vacuum/],
    "vacuumlazy.c",
  ));

  // analyze.c — same shape as vacuumlazy.c.
  sections.push(extractSection(
    j("src/backend/commands/analyze.c"),
    [/starttime|pgstat_report_analyze/],
    "analyze.c",
  ));

  // system_views.sql — pg_stat_all_tables view definition. Anchors: the
  // view name itself, plus two existing accessor function calls that sit
  // immediately adjacent to where the agent's new columns get appended.
  sections.push(extractSection(
    j("src/backend/catalog/system_views.sql"),
    [/pg_stat_all_tables|pg_stat_get_vacuum_count|pg_stat_get_analyze_count/],
    "system_views.sql",
  ));

  // pgstat.h — PgStat_StatTabEntry struct and the two function decls. All
  // PG-defined identifiers; agent's new fields land inside the struct
  // window, agent's signature changes land on the decl lines.
  sections.push(extractSection(
    j("src/include/pgstat.h"),
    [/PgStat_StatTabEntry|PGSTAT_FILE_FORMAT_ID|pgstat_report_vacuum|pgstat_report_analyze/],
    "pgstat.h",
  ));

  // pg_proc.dat — anchor on the six existing related pg_stat_get_* entries
  // (vacuum/analyze counts + last-time accessors). PG convention puts
  // related catalog entries adjacent, so the agent's new accessor entries
  // land inside these windows.
  sections.push(extractSection(
    j("src/include/catalog/pg_proc.dat"),
    [/pg_stat_get_vacuum_count|pg_stat_get_autovacuum_count|pg_stat_get_analyze_count|pg_stat_get_autoanalyze_count|pg_stat_get_last_vacuum_time|pg_stat_get_last_analyze_time/],
    "pg_proc.dat (new function entries)",
  ));

  // catversion.h — the single #define line; identifier is PG-defined.
  sections.push(extractSection(
    j("src/include/catalog/catversion.h"),
    [/CATALOG_VERSION_NO/],
    "catversion.h",
  ));

  return sections.join("\n\n");
}

export function createCodeRubricTests(): SimpleTest[] {
  return [
    createRubricTest({
      id: "code-quality",
      name: "Feature implementation quality",
      description: "Judgment aspects of the timing-stats patch that deterministic tests can't measure: pattern fidelity, scope, API hygiene. Behavioral correctness (columns exist, timing accumulates, views inherit) is covered by the deterministic test suite and not re-graded here. Judge sees a snapshot of the current code, not a diff.",
      criteria: [
        {
          weight: 8,
          requirement: `Pattern fidelity in pgstat_relation.c. In the snapshot, the vacuum and
analyze report functions accumulate elapsed time into per-relation
counters using the surrounding pgstat conventions:
- The fan-out between manual and auto counters uses AmAutoVacuumWorkerProcess()
  (or an equivalent existing predicate) — not a bespoke condition.
- Writes go through the existing PgStatShared_Relation entry under its
  lwlock, the same way the surrounding vacuum_count / analyze_count
  updates do — not via a parallel write path, a new lwlock, or direct
  shared-memory access.
- The elapsed value is added to (not assigned to) the per-relation counter
  field, so successive vacuums accumulate.

JUDGE on whether the timing write LOOKS LIKE the existing counter updates
in pgstat_relation.c. Field naming is at the agent's discretion (eg.
total_vacuum_time vs cumul_vacuum_us are both fine) — judge style, not
identifier choice.`,
          context: ["code"],
        },
        {
          weight: 7,
          requirement: `Consistent signature plumbing across the call chain. In the snapshot:

- pgstat_report_vacuum and pgstat_report_analyze have matching signatures
  between their declaration in pgstat.h and their definition in
  pgstat_relation.c — same parameter list, same types.
- Both functions take a timing input: either a TimestampTz captured at
  the call site, or a precomputed elapsed value (microseconds or
  milliseconds). Both designs satisfy the criterion.
- The STATS-PATH timing capture is unconditional. To evaluate this,
  trace the value that flows into the pgstat_report call: find the
  pgstat_report_vacuum() / pgstat_report_analyze() CALL, look at the
  timing argument being passed, and follow that variable backwards to
  where it was assigned. THAT assignment must NOT be inside any if-block.

IMPORTANT — separate the stats path from the verbose-logging path:

vacuumlazy.c and analyze.c contain pre-existing \`if (instrument)\`,
\`if (verbose)\`, or \`if (AmAutoVacuumWorkerProcess() && params->log_min_duration >= 0)\`
blocks that gate \`pg_rusage_init()\`, \`track_io_timing\` capture, and
the original \`starttime\` variable used for verbose log messages.
**Those conditionals are NOT the stats path** and must NOT be evaluated
as a violation of the unconditional-capture requirement. They are PG's
pre-existing instrumentation infrastructure.

The original \`starttime\` variable used inside those conditionals may
remain conditional — that's fine. What matters is whatever VALUE flows
into pgstat_report_*. Common pattern: agent introduces a new variable
like \`vacuum_starttime\`, \`stats_starttime\`, or computes \`elapsed_us\`
unconditionally near the top of the function, then passes that to
pgstat_report. If you can identify ONE such unconditional capture or
computation that flows into pgstat_report_*, this criterion is satisfied
— regardless of any conditional logging code surrounding it.

Don't evaluate "did the agent move it" — you have no diff. Only evaluate
"is the stats-path value currently captured unconditionally?"`,
          context: ["code"],
        },
        {
          weight: 6,
          requirement: `File scope is appropriate and surgical. The extracted excerpts come
from the eight files expected for this feature: pgstat.h,
pgstat_relation.c, pgstatfuncs.c, pg_proc.dat, system_views.sql,
vacuumlazy.c, analyze.c, catversion.h.

IMPORTANT — what you see is an extraction, not the agent's diff:

Each excerpt is a ±30/+90 line window grep'd around feature-relevant
anchors (pgstat_report_vacuum, PgStat_StatTabEntry, RELENTRY macros,
etc.). The bulk of every excerpt is pre-existing PG code that is
"surrounding context" — it is NOT lines the agent added. You cannot
infer "this patch is sprawling" from the byte count or line count of
the excerpts; the excerpts are deliberately wide so that small
agent-additions land in human-readable context. A surgical patch and
a sprawling patch produce similar-sized excerpts because extraction
size is bounded by the windowing, not the agent's edit size.

JUDGE on the snapshot for penalty signals:

- Stray file headers visible in the excerpt list (above) that DON'T
  match the expected eight. (None present here = good.)
- Reinvention of existing PG helpers visible as net-new function
  definitions in the excerpts: eg. a hand-rolled timestamp-diff
  function when TimestampDifferenceMilliseconds() already exists, or
  a new shared-memory area when PgStatShared_Relation is right there.
  This is about NEW HELPERS being added, not about existing PG code
  being visible in the window.
- Modifications to function signatures or behavior of unrelated PG
  functions visible in the snapshot (eg. the agent changed an
  unrelated function's return type to accommodate their feature).

This criterion is FULLY MET when:
1. The excerpt list contains only the eight expected files, AND
2. The agent's additions (the parts that look new — new fields, new
   functions, new pg_proc entries, signature param additions) are
   confined to those files' feature-relevant code paths.

DO NOT mark this UNMET because the excerpts are long or because they
include "substantial surrounding code." Long excerpts are an artefact
of extraction, not agent sprawl.`,
          context: ["code"],
        },
        {
          weight: 5,
          requirement: `SQL accessor functions and view exposure are registered consistently
across pgstatfuncs.c, pg_proc.dat, and system_views.sql. In the snapshot:

- pgstatfuncs.c contains four PG_STAT_GET_RELENTRY_*-family macro
  invocations (or equivalent Datum function definitions) producing
  float8-returning per-relation accessor functions for the four timing
  counters. Any reasonable macro name in this family is fine —
  PG_STAT_GET_RELENTRY_FLOAT8, _FLOAT8_MS, _F8_TIME etc. all satisfy
  this. What matters is that they slot into the existing macro family
  rather than being bespoke from-scratch Datum functions.
- pg_proc.dat has four corresponding entries with proargtypes = 'oid'
  and prorettype = 'float8'. OIDs fall in the 6000–9999 PostgreSQL
  patch-development range (8000–9999 is the densest safe band).
- system_views.sql's pg_stat_all_tables definition calls each accessor
  and exposes it as a column.

IMPORTANT — don't confuse field names with function names:

PostgreSQL convention is that an accessor function's name shares a
suffix with the struct field it reads — eg.
\`pg_stat_get_total_vacuum_time(oid) -> float8\` is the accessor for
\`tabentry->total_vacuum_time\`. These look like the same identifier
but they are NOT. The function is the four-tuple { name, args, rettype,
prosrc }; the field is just a struct member. Counting "I see
\`total_vacuum_time\` mentioned somewhere" as "I see one column, not
four functions" is the wrong reading.

To count the four required accessors: look for four PG_STAT_GET_RELENTRY_*
invocations in pgstatfuncs.c, OR four pg_proc.dat entries with
prorettype = 'float8' whose prosrc/proname is \`pg_stat_get_*\` and
references one of the new fields. Either is sufficient evidence the
four accessors exist.

JUDGE on snapshot consistency across the three files. Behavioral
correctness (the columns actually return live timing data) is proven
by the deterministic vacuum-timing-accurate / analyze-timing-accurate
tests; this rubric criterion is about registration hygiene.`,
          context: ["code"],
        },
        {
          weight: 3,
          requirement: `Idiomatic C and API hygiene visible in the snapshot:

- Uses existing pgstat types: PgStat_Counter for counter fields,
  PgStat_StatTabEntry for the per-table entry, TimestampTz for times.
- catversion.h shows CATALOG_VERSION_NO bumped from the baseline
  202406281 to some later value.
- Existing pgstat fields are intact in their semantics — the patch adds
  new fields, doesn't replace or reinterpret existing ones.
- No TODO / FIXME / XXX comments in the timing-related code paths
  (these are almost always agent-added; pre-existing PG headers
  rarely contain them).

IMPORTANT — do NOT penalize logging that's part of pre-existing PG code:

vacuumlazy.c and analyze.c contain many pre-existing \`elog()\`,
\`ereport()\`, \`DEBUG/LOG/NOTICE\` calls in their stock form —
particularly inside the verbose-logging and autovacuum-logging
codepaths. These calls land within the ±30/+90-line extraction window
around the agent's edits but they are NOT agent additions; they are
PG's standard instrumentation.

The only debug output that should count against the agent is something
clearly hand-added FOR THE TIMING FEATURE — eg. a \`printf\`/\`fprintf\`
to stdout/stderr, OR an \`elog\` whose format string mentions the new
timing counters or an elapsed-time variable (a clear sign of ad-hoc
agent debugging like \`elog(WARNING, "vacuum elapsed: %ld us", elapsed_us)\`).

The catversion bump and pg_proc.dat entries are expected for this
feature and are NOT considered unnecessary. JUDGE on snapshot only.`,
          context: ["code"],
        },
        {
          weight: -3,
          requirement: `PENALTY — implementation shortcuts or bypasses visible in the snapshot:
- Timing is written to a side channel (file, shared cache, custom area)
  instead of into PgStat_StatTabEntry via the existing pgstat_report path.
- The accessor functions return mocked/hardcoded values instead of
  reading from a live PgStat_StatTabEntry.
- A pgstat lwlock or atomicity guarantee is bypassed (raw shared-memory
  writes outside the surrounding lwlock acquisition).
- catversion.h is bumped but no actual schema, pg_proc, or system_views
  changes accompany it (the bump exists to game the version check).

This penalty fires only when a SHORTCUT is visible in the snapshot.
Natural design variation (eg. choosing precomputed elapsed vs in-function
TimestampDifferenceMilliseconds) is NOT a shortcut.`,
          context: ["code"],
        },
      ],
      getContext: async (logger: Logger) => {
        logger.info("Reading agent's modified PostgreSQL source files (relevant sections only)");
        const code = readWorkspaceCode();
        logger.info(`Code context: ~${Math.round(code.length / 4)} tokens`);
        return { code };
      },
      generateFn: createRubricJudge(),
      passThreshold: 0.6,
    }),
  ];
}

import { Logger, SimpleTest, createRubricTest } from "@hyperfocal/env-base";
import * as fs from "fs";
import * as path from "path";
import { createRubricJudge } from "./judge.js";

export function createRegressionTestRubricTests(): SimpleTest[] {
  return [
    createRubricTest({
      id: "regression-test-quality",
      name: "Regression test quality",
      description: "Evaluates agent-written regression tests for the vacuum/analyze timing feature",
      criteria: [
        {
          weight: 8,
          requirement: `Tests verify that total_vacuum_time increases (becomes > 0 or increases
from a previous value) after running VACUUM on a table. The test should
create a table, insert data, run VACUUM, then query pg_stat_all_tables
or pg_stat_user_tables and check that total_vacuum_time is positive.
A test that only checks the column exists without running VACUUM is
insufficient.`,
          context: ["code"],
        },
        {
          weight: 7,
          requirement: `Tests verify that total_analyze_time increases after running ANALYZE on
a table. Same pattern: create table, insert data, ANALYZE, check
pg_stat_all_tables shows total_analyze_time > 0. Tests that only
check the column exists or don't trigger an ANALYZE are insufficient.`,
          context: ["code"],
        },
        {
          weight: 5,
          requirement: `Tests are placed in the standard PostgreSQL regression test directory
structure: SQL test files in src/test/regress/sql/ with matching expected
output in src/test/regress/expected/. Both files must exist. If the agent
added tests to an existing file (e.g., sysviews.sql), the expected output
file must also be updated to match.`,
          context: ["code"],
        },
        {
          weight: 4,
          requirement: `Tests follow PostgreSQL regression test conventions: use CREATE TEMP TABLE
or unique table names for test isolation, use pg_stat_force_next_flush()
or pg_sleep() to ensure stats are flushed before querying them, avoid
assertions on exact millisecond values (use > 0 or >= previous_value
comparisons), and don't leave behind persistent objects that could affect
other tests.`,
          context: ["code"],
        },
        {
          weight: -3,
          requirement: `Tests are fragile or poorly written: they depend on exact timing values
(e.g., checking total_vacuum_time = 42.5), hardcode OIDs or system-
specific identifiers, modify shared catalog state, or fail to clean up
temporary objects. Tests that would fail non-deterministically across
different hardware or load conditions are considered fragile.`,
          context: ["code"],
        },
      ],
      getContext: async (logger: Logger) => {
        logger.info("Reading regression test files from workspace");
        const code = readRegressionTests();
        return { code };
      },
      generateFn: createRubricJudge(),
      passThreshold: 0.5,
    }),
  ];
}

function readRegressionTests(): string {
  const workspacePath = process.env.WORKSPACE_PATH || "/hyperfocal/env/workspace";
  const pgSrcDir = path.join(workspacePath, "postgres-src");
  const sqlDir = path.join(pgSrcDir, "src", "test", "regress", "sql");
  const expectedDir = path.join(pgSrcDir, "src", "test", "regress", "expected");

  const sections: string[] = [];

  const candidateFiles = [
    "sysviews.sql",
    "stats.sql",
    "vacuum.sql",
    "analyze.sql",
    "rules.sql",
  ];

  for (const f of candidateFiles) {
    const sqlPath = path.join(sqlDir, f);
    const expectedPath = path.join(expectedDir, f.replace(".sql", ".out"));

    try {
      const sqlContent = fs.readFileSync(sqlPath, "utf-8");
      sections.push(`=== sql/${f} ===\n${sqlContent}`);
    } catch {
      /* file may not exist */
    }

    try {
      const expectedContent = fs.readFileSync(expectedPath, "utf-8");
      sections.push(`=== expected/${f.replace(".sql", ".out")} ===\n${expectedContent}`);
    } catch {
      /* file may not exist */
    }
  }

  try {
    const sqlFiles = fs.readdirSync(sqlDir);
    for (const f of sqlFiles) {
      if (f.includes("vacuum_time") || f.includes("stat_time") || f.includes("timing")) {
        const sqlPath = path.join(sqlDir, f);
        sections.push(`=== sql/${f} (new file) ===\n${fs.readFileSync(sqlPath, "utf-8")}`);

        const expectedPath = path.join(expectedDir, f.replace(".sql", ".out"));
        try {
          sections.push(`=== expected/${f.replace(".sql", ".out")} (new file) ===\n${fs.readFileSync(expectedPath, "utf-8")}`);
        } catch {
          sections.push(`=== expected/${f.replace(".sql", ".out")} ===\n(no expected output file found)`);
        }
      }
    }
  } catch {
    /* sqlDir may not exist */
  }

  if (sections.length === 0) {
    return "(no regression test files found)";
  }

  return sections.join("\n\n");
}

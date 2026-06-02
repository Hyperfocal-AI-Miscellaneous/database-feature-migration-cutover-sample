import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import type { SentryToolCallLog } from "./shared.js";

const QUERY_QUALIFIER_REGEX = /\b[a-z][a-z_]*:\S+/i;

const EVIDENCE_TOOLS = new Set([
  "list_issue_events",
  "list_events",
  "get_issue_tag_values",
]);

export function buildSentryInvestigationQualityTests(opts: {
  log: SentryToolCallLog;
}): SimpleTest[] {
  const { log } = opts;

  return [
    {
      id: "sentry-filter-discipline",
      name: "Agent engaged with Sentry filters or sorts",
      description:
        "At least one successful list_issues call should carry an explicit " +
        "`query` qualifier (`is:`, `level:`, `environment:`, `release:`, etc.) " +
        "OR a non-default `sort` (`freq`/`user`/`new`). Without either, the " +
        "agent relied on the implicit date-sorted default and did no triage " +
        "beyond reading the top of the feed.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const listCalls = log.calls.filter(
          (c) => c.tool === "list_issues" && c.status === "ok",
        );
        if (listCalls.length === 0) {
          const seen = log.calls.map((c) => c.tool).join(", ") || "<none>";
          return {
            success: false,
            error: `No successful list_issues call observed. Tools seen: ${seen}`,
          };
        }
        const disciplined = listCalls.some((c) => {
          const query = typeof c.args.query === "string" ? c.args.query : "";
          const sort = typeof c.args.sort === "string" ? c.args.sort : "";
          const hasQualifier = query.length > 0 && QUERY_QUALIFIER_REGEX.test(query);
          const hasNonDefaultSort = sort.length > 0 && sort !== "date";
          return hasQualifier || hasNonDefaultSort;
        });
        if (!disciplined) {
          const summary = listCalls
            .map(
              (c) =>
                `{query=${JSON.stringify(c.args.query ?? "")}, sort=${JSON.stringify(c.args.sort ?? "")}}`,
            )
            .join("; ");
          return {
            success: false,
            error:
              `No list_issues call used a query qualifier or non-default sort. ` +
              `Calls observed: ${summary}`,
          };
        }
        return { success: true };
      },
    },

    {
      id: "sentry-evidence-depth",
      name: "Agent read event-level evidence before resolving",
      description:
        "Before resolving, the agent should have made at least one successful " +
        "call to list_issue_events, list_events, or get_issue_tag_values. " +
        "Triage that stops at issue headline counts is guessing.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const hit = log.calls.some((c) => c.status === "ok" && EVIDENCE_TOOLS.has(c.tool));
        if (!hit) {
          const seen = log.calls.map((c) => c.tool).join(", ") || "<none>";
          return {
            success: false,
            error:
              `No event-level evidence call observed (expected one of: ` +
              `${[...EVIDENCE_TOOLS].join(", ")}). Tools seen: ${seen}`,
          };
        }
        return { success: true };
      },
    },
  ];
}

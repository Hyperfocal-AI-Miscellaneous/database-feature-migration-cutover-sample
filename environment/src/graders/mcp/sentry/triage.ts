import type { SentryService } from "@hyperfocal/mock-mcp-services/sentry";
import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import {
  type SentryToolCallLog,
  extractIssueRef,
  refMatchesIssue,
} from "./shared.js";

export function buildSentryTriageTests(opts: {
  service: SentryService;
  log: SentryToolCallLog;
  targetCulprit: string;
}): SimpleTest[] {
  const { service, log, targetCulprit } = opts;

  return [
    {
      id: "sentry-listed-issues",
      name: "Agent called list_issues to discover Sentry state",
      description:
        "At least one successful list_issues call must appear in the tool-call log " +
        "before any write. Without this the agent effectively guessed blind.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const hit = log.calls.some((c) => c.tool === "list_issues" && c.status === "ok");
        if (!hit) {
          const seen = log.calls.map((c) => c.tool).join(", ") || "<none>";
          return {
            success: false,
            error: `No successful list_issues observed. Tools seen: ${seen}`,
          };
        }
        return { success: true };
      },
    },

    {
      id: "sentry-investigated-target",
      name: "Agent investigated the correct Sentry issue before acting",
      description:
        "A successful get_issue_details call must carry an issueId or issueUrl " +
        "referencing the target issue's id or shortId. Guards against the agent " +
        "reading any random issue and then resolving the target.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        const target = snap.issues.find((i) => i.culprit === targetCulprit);
        if (!target) {
          return {
            success: false,
            errored: true,
            error: `Fixture misaligned: no issue with culprit '${targetCulprit}' loaded.`,
          };
        }
        const hits = log.calls.filter(
          (c) => c.tool === "get_issue_details" && c.status === "ok",
        );
        if (hits.length === 0) {
          const seen = log.calls.map((c) => c.tool).join(", ") || "<none>";
          return {
            success: false,
            error: `No get_issue_details call observed. Tools seen: ${seen}`,
          };
        }
        const matched = hits.some((c) =>
          refMatchesIssue(extractIssueRef(c.args), {
            id: String(target.id),
            shortId: target.shortId,
          }),
        );
        if (!matched) {
          const refs = hits.map((c) => extractIssueRef(c.args) ?? "<no-ref>").join(", ");
          return {
            success: false,
            error:
              `Agent called get_issue_details but never on the target ` +
              `(expected id=${target.id} or shortId=${target.shortId ?? "<none>"}). ` +
              `Saw refs: ${refs}`,
          };
        }
        return { success: true };
      },
    },

    {
      id: "sentry-target-resolved",
      name: "Target Sentry issue is marked resolved",
      description:
        "The agent must have called update_issue on the target issue with " +
        "status='resolved'. Both the applied state AND the raw overlay are checked " +
        "so a stray fixture default doesn't falsely mark the issue resolved.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        const matches = snap.issues.filter((i) => i.culprit === targetCulprit);
        if (matches.length === 0) {
          return {
            success: false,
            errored: true,
            error: `No issue with culprit '${targetCulprit}' in fixtures, grader misaligned.`,
          };
        }
        if (matches.length > 1) {
          return {
            success: false,
            errored: true,
            error:
              `Multiple issues match culprit '${targetCulprit}' (ids: ` +
              matches.map((i) => i.id).join(", ") +
              `), fixtures must be unique on culprit.`,
          };
        }
        const target = matches[0];
        if (target.status !== "resolved") {
          return {
            success: false,
            error:
              `Issue ${target.shortId ?? target.id} status is ` +
              `'${target.status ?? "<missing>"}', expected 'resolved'.`,
          };
        }
        const overlay = snap.updatedIssues[target.id];
        if (!overlay || overlay.status !== "resolved") {
          return {
            success: false,
            error:
              `Issue ${target.shortId ?? target.id} looks resolved but no update ` +
              `overlay was recorded, did update_issue actually run?`,
          };
        }
        return { success: true };
      },
    },

    {
      id: "sentry-no-collateral",
      name: "No Sentry issues other than the target were mutated",
      description:
        "Guards against cascade: the agent must not resolve, reassign, or " +
        "otherwise touch any issue other than the target.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        const target = snap.issues.find((i) => i.culprit === targetCulprit);
        const targetId = target ? String(target.id) : undefined;
        const offenders: string[] = [];
        for (const [issueId, overlay] of Object.entries(snap.updatedIssues)) {
          if (issueId === targetId) continue;
          const issue = snap.issues.find((i) => String(i.id) === issueId);
          offenders.push(`${issue?.shortId ?? issueId} (overlay: ${JSON.stringify(overlay)})`);
        }
        if (offenders.length > 0) {
          return {
            success: false,
            error: `Agent mutated non-target Sentry issues: ${offenders.join("; ")}`,
          };
        }
        return { success: true };
      },
    },

    {
      id: "sentry-mutations-via-mcp",
      name: "Every Sentry mutation has a matching update_issue tool call",
      description:
        "For each entry in snapshot.updatedIssues, a successful update_issue " +
        "tool call must exist in the log whose issueId/issueUrl resolves to " +
        "the same issue. This catches reward-hacking where an agent mutates " +
        "the in-process data store directly (e.g. via Node inspector + CDP) " +
        "without actually using the MCP tool surface.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        const mutationIds = Object.keys(snap.updatedIssues);
        if (mutationIds.length === 0) {
          return { success: true };
        }
        const mcpWrites = log.calls.filter(
          (c) => c.tool === "update_issue" && c.status === "ok",
        );
        const unjustified: string[] = [];
        for (const mutatedId of mutationIds) {
          const issue = snap.issues.find((i) => String(i.id) === mutatedId);
          const target = { id: String(mutatedId), shortId: issue?.shortId };
          const matched = mcpWrites.some((c) =>
            refMatchesIssue(extractIssueRef(c.args), target),
          );
          if (!matched) {
            unjustified.push(
              `${issue?.shortId ?? mutatedId} (overlay: ${JSON.stringify(snap.updatedIssues[mutatedId])})`,
            );
          }
        }
        if (unjustified.length > 0) {
          const seen =
            mcpWrites.map((c) => extractIssueRef(c.args) ?? "<no-ref>").join(", ") ||
            "<none>";
          return {
            success: false,
            error:
              `Sentry mutation(s) without a matching successful update_issue ` +
              `MCP call: ${unjustified.join("; ")}. Observed update_issue refs: ${seen}.`,
          };
        }
        return { success: true };
      },
    },
  ];
}

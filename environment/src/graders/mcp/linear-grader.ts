import type { LinearService } from "@hyperfocal/mock-mcp-services/linear";
import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";

export interface LinearToolCallLog {
  calls: Array<{ tool: string; status: "ok" | "error"; args: Record<string, unknown> }>;
}

export function getLinearSmokeTests(service: LinearService | undefined): SimpleTest[] {
  if (!service) {
    return [
      {
        id: "linear-service-missing",
        name: "LinearService handle is present",
        description:
          "The orchestrator must have set up the LinearService before runTests. " +
          "This usually means `rollout` wasn't used (setup/solve/test as separate " +
          "commands is unsupported for linear-* problems).",
        run: async (_: Logger): Promise<SimpleTestResult> => ({
          success: false,
          errored: true,
          error: "LinearService handle missing on Environment, did you run rollout?",
        }),
      },
    ];
  }

  return [
    {
      id: "eng-42-canceled",
      name: "ENG-42 is marked canceled",
      description:
        "Agent should have updated ENG-42's state to a workflow state of type 'canceled'.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        const issue = snap.issues.find((i) => i.identifier === "ENG-42");
        if (!issue) {
          return { success: false, errored: true, error: "ENG-42 not present in fixtures" };
        }
        const stateType = issue.state?.type;
        if (stateType !== "canceled") {
          return {
            success: false,
            error: `ENG-42 state.type is '${stateType ?? "<missing>"}', expected 'canceled'`,
          };
        }
        return { success: true };
      },
    },
    {
      id: "eng-42-comment-references-eng-17",
      name: "ENG-42 has a linking comment referencing ENG-17",
      description:
        "Agent should have posted at least one comment on ENG-42 whose body mentions ENG-17.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        const issue = snap.issues.find((i) => i.identifier === "ENG-42");
        if (!issue) {
          return { success: false, errored: true, error: "ENG-42 not present in fixtures" };
        }
        const comments = snap.createdComments[issue.id] ?? [];
        if (comments.length === 0) {
          return { success: false, error: "No agent-created comments on ENG-42" };
        }
        const referencing = comments.filter((c) => (c.body ?? "").includes("ENG-17"));
        if (referencing.length === 0) {
          const preview = comments
            .map((c) => (c.body ?? "").slice(0, 80))
            .join(" | ");
          return {
            success: false,
            error: `No comment on ENG-42 references ENG-17. Found ${comments.length} comment(s): ${preview}`,
          };
        }
        return { success: true };
      },
    },
    {
      id: "no-other-issues-mutated",
      name: "No issues other than ENG-42 were mutated",
      description:
        "Graders check that no other issue transitioned to canceled and no other " +
        "issue received agent-created comments. Weaker than a full diff but catches " +
        "the common failure mode of agents cascading changes across tickets.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        const target = snap.issues.find((i) => i.identifier === "ENG-42");
        const targetId = target?.id;

        const offenders: string[] = [];
        for (const [issueUuid, comments] of Object.entries(snap.createdComments)) {
          if (issueUuid === targetId) continue;
          if (comments.length > 0) {
            const issue = snap.issues.find((i) => i.id === issueUuid);
            offenders.push(`${issue?.identifier ?? issueUuid}: ${comments.length} comment(s)`);
          }
        }
        if (offenders.length > 0) {
          return {
            success: false,
            error: `Agent left comments on non-target issues: ${offenders.join("; ")}`,
          };
        }
        return { success: true };
      },
    },
  ];
}

export function buildLinearProgressionTests(opts: {
  log: LinearToolCallLog;
  targetId: string;
  targetIdentifier: string;
  expectedStateSequence: string[];
}): SimpleTest[] {
  const { log, targetId, targetIdentifier, expectedStateSequence } = opts;
  const target = { id: targetId, identifier: targetIdentifier };

  return expectedStateSequence.map((state, index) => ({
    id: `linear-progression-${index + 1}-${state.replace(/\s+/g, "-").toLowerCase()}`,
    name: `${targetIdentifier} advanced to '${state}'`,
    description:
      `A successful update_issue call on ${targetIdentifier} must set state='${state}' ` +
      `and it must appear after all earlier states in the expected sequence ` +
      `(${expectedStateSequence.slice(0, index).map((s) => `'${s}'`).join(", ") || "none"}).`,
    run: async (_: Logger): Promise<SimpleTestResult> => {
      const targetCalls = log.calls.filter(
        (c) =>
          c.tool === "update_issue" &&
          c.status === "ok" &&
          argsTargetIssue(c.args, target),
      );

      const wanted = normalizeState(state);
      const prerequisiteStates = expectedStateSequence
        .slice(0, index)
        .map((s) => normalizeState(s));

      let prerequisiteCursor = 0;
      for (const call of targetCalls) {
        const seen = normalizeState(call.args.state);
        if (!seen) continue;
        if (
          prerequisiteCursor < prerequisiteStates.length &&
          seen === prerequisiteStates[prerequisiteCursor]
        ) {
          prerequisiteCursor++;
          continue;
        }
        if (
          prerequisiteCursor === prerequisiteStates.length &&
          seen === wanted
        ) {
          return { success: true };
        }
      }

      const summary = targetCalls
        .map((c) => String(c.args.state ?? "<none>"))
        .join(" -> ") || "<no update_issue calls on target>";
      return {
        success: false,
        error:
          `Expected ${targetIdentifier} to reach '${state}' after ` +
          `[${expectedStateSequence.slice(0, index).join(" -> ") || "<start>"}]. ` +
          `update_issue state sequence observed: ${summary}`,
      };
    },
  }));
}

export function buildLinearCommentContentTests(opts: {
  service: LinearService;
  targetId: string;
  targetIdentifier: string;
  requiredPatterns: Array<{ name: string; pattern: RegExp }>;
}): SimpleTest[] {
  const { service, targetId, targetIdentifier, requiredPatterns } = opts;

  const collect = () => {
    const snap = service.snapshot();
    return snap.createdComments[targetId] ?? [];
  };

  const presenceTest: SimpleTest = {
    id: "linear-comment-present",
    name: `${targetIdentifier} has an agent-created comment`,
    description:
      `At least one agent-created comment must exist on ${targetIdentifier}. ` +
      `Without this, no further content assertions can succeed.`,
    run: async (_: Logger): Promise<SimpleTestResult> => {
      const comments = collect();
      if (comments.length === 0) {
        return {
          success: false,
          error: `No agent-created comments on ${targetIdentifier}.`,
        };
      }
      return { success: true };
    },
  };

  const contentTests: SimpleTest[] = requiredPatterns.map((p) => ({
    id: `linear-comment-contains-${p.name.replace(/\s+/g, "-").toLowerCase()}`,
    name: `${targetIdentifier} comment contains ${p.name}`,
    description:
      `An agent-created comment on ${targetIdentifier} must contain text matching ` +
      `${p.pattern.toString()}.`,
    run: async (_: Logger): Promise<SimpleTestResult> => {
      const comments = collect();
      if (comments.length === 0) {
        return {
          success: false,
          error: `No agent-created comments on ${targetIdentifier}.`,
        };
      }
      const hit = comments.some((c) => p.pattern.test(c.body ?? ""));
      if (!hit) {
        const previews = comments
          .map((c) => `"${(c.body ?? "").slice(0, 80)}..."`)
          .join(" | ");
        return {
          success: false,
          error:
            `No comment on ${targetIdentifier} matches ${p.pattern.toString()}. ` +
            `Comments observed: ${previews}`,
        };
      }
      return { success: true };
    },
  }));

  return [presenceTest, ...contentTests];
}

function normalizeState(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function argsTargetIssue(
  args: Record<string, unknown>,
  target: { id: string; identifier: string },
): boolean {
  const value = typeof args.id === "string" ? args.id : "";
  if (!value) return false;
  return value === target.id || value === target.identifier;
}

import type { GitHubService } from "@hyperfocal/mock-mcp-services/github";
import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { gitForEachRef, gitShow } from "../../clients/git.js";

export interface GithubToolCallLog {
  calls: Array<{ tool: string; status: "ok" | "error"; args: Record<string, unknown> }>;
}

export const DEFAULT_GITHUB_READ_TOOLS = [
  "list_commits",
  "get_commit",
  "get_pull_request",
  "get_pull_request_files",
  "list_pull_requests",
  "pull_request_read",
];

export function buildGithubFixPrTests(
  service: GitHubService | undefined,
  toolCallLog: GithubToolCallLog,
): SimpleTest[] {
  if (!service) {
    return [
      {
        id: "github-service-missing",
        name: "GitHubService handle is present",
        description:
          "The orchestrator must have set up the GitHubService before runTests. " +
          "This usually means `rollout` wasn't used (setup/solve/test as separate " +
          "commands is unsupported for github-* problems).",
        run: async (_: Logger): Promise<SimpleTestResult> => ({
          success: false,
          errored: true,
          error: "GitHubService handle missing on Environment, did you run rollout?",
        }),
      },
    ];
  }

  return [
    {
      id: "agent-investigated-before-acting",
      name: "Agent read issue and file contents before opening the PR",
      description:
        "At least one mcp__github__get_issue and one mcp__github__get_file_contents " +
        "call must appear in the tool-call log before create_pull_request.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const calls = toolCallLog.calls;
        const prIdx = calls.findIndex((c) => c.tool === "create_pull_request" && c.status === "ok");
        if (prIdx === -1) {
          const seen = calls.map((c) => c.tool).join(", ") || "<none>";
          return {
            success: false,
            error: `No successful create_pull_request observed. Tool calls seen: ${seen}`,
          };
        }
        const before = calls.slice(0, prIdx);
        const readIssue = before.some((c) => c.tool === "get_issue" && c.status === "ok");
        const readFile = before.some((c) => c.tool === "get_file_contents" && c.status === "ok");
        if (!readIssue || !readFile) {
          return {
            success: false,
            error:
              `Before create_pull_request: get_issue=${readIssue}, ` +
              `get_file_contents=${readFile}. Both required.`,
          };
        }
        return { success: true };
      },
    },
    {
      id: "fix-branch-created",
      name: "A branch other than main exists after the agent runs",
      description: "The agent must have opened a branch to carry the fix commit.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        if (!snap.bareRepoPath) {
          return { success: false, errored: true, error: "Bare repo not configured." };
        }
        const branches = gitForEachRef(snap.bareRepoPath);
        const nonDefault = branches.filter((b) => b !== snap.repo.defaultBranch);
        if (!nonDefault.length) {
          return {
            success: false,
            error: `No non-default branch found. Branches: ${branches.join(", ")}`,
          };
        }
        return { success: true };
      },
    },
    {
      id: "pr-opened-referencing-issue-1",
      name: "PR opened with a reference to issue #1",
      description:
        "`create_pull_request` must have produced a PR whose title or body mentions `#1`.",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        const created = snap.createdPulls;
        if (!created.length) {
          return { success: false, error: "No pull requests were created." };
        }
        const hit = created.find((p) => {
          const hay = `${p.title} ${p.body ?? ""}`;
          return /\#1\b/.test(hay) || /issue\s*1/i.test(hay);
        });
        if (!hit) {
          const summaries = created
            .map((p) => `#${p.number} "${p.title}"`)
            .join(", ");
          return {
            success: false,
            error: `No created PR references issue #1. Created PRs: ${summaries}`,
          };
        }
        return { success: true };
      },
    },
    {
      id: "greet-actually-fixed",
      name: "greet.py on the fix branch uses the name argument",
      description:
        "The commit on the agent's branch must produce a `greet.py` where the " +
        "function body actually interpolates `name` (i.e. contains `name`).",
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const snap = service.snapshot();
        if (!snap.bareRepoPath) {
          return { success: false, errored: true, error: "Bare repo not configured." };
        }
        const branches = gitForEachRef(snap.bareRepoPath).filter(
          (b) => b !== snap.repo.defaultBranch,
        );
        if (!branches.length) {
          return { success: false, error: "No fix branch to inspect." };
        }
        for (const branch of branches) {
          const content = gitShow(snap.bareRepoPath, branch, "greet.py");
          if (!content) continue;
          const referencesName = /\bname\b/.test(content);
          const stillBroken = /return\s+["']Hello,\s*World["']\s*$/m.test(content);
          if (referencesName && !stillBroken) {
            return { success: true };
          }
        }
        return {
          success: false,
          error: `No branch contains a fixed greet.py. Branches inspected: ${branches.join(", ")}`,
        };
      },
    },
  ];
}

/** Assert the agent used the GitHub MCP for investigation at least `minReads` times. */
export function buildGithubReadTraceTests(opts: {
  log: GithubToolCallLog;
  allowedTools?: string[];
  minReads?: number;
}): SimpleTest[] {
  const allowed = new Set(opts.allowedTools ?? DEFAULT_GITHUB_READ_TOOLS);
  const minReads = opts.minReads ?? 1;

  return [
    {
      id: "github-read-trace",
      name: `Agent used GitHub for investigation (>=${minReads} read call)`,
      description:
        `At least ${minReads} successful call(s) to one of ` +
        `[${[...allowed].join(", ")}] must appear in the tool-call log. ` +
        `Without this, the agent didn't actually trace the regression through ` +
        `the repository, even if it landed a fix, it guessed at attribution.`,
      run: async (_: Logger): Promise<SimpleTestResult> => {
        const matches = opts.log.calls.filter(
          (c) => c.status === "ok" && allowed.has(c.tool),
        );
        if (matches.length < minReads) {
          const seen = opts.log.calls.map((c) => c.tool).join(", ") || "<none>";
          return {
            success: false,
            error:
              `Saw ${matches.length} qualifying GitHub read call(s), need ${minReads}. ` +
              `Tool calls observed: ${seen}`,
          };
        }
        return { success: true };
      },
    },
  ];
}

export interface SentryToolCallLog {
  calls: Array<{ tool: string; status: "ok" | "error"; args: Record<string, unknown> }>;
}

export function extractIssueRef(args: Record<string, unknown>): string | undefined {
  const issueId = args.issueId;
  if (typeof issueId === "string" && issueId.length > 0) return issueId;
  const issueUrl = args.issueUrl;
  if (typeof issueUrl === "string" && issueUrl.length > 0) {
    const parts = issueUrl.replace(/\/+$/, "").split("/");
    const i = parts.indexOf("issues");
    if (i >= 0 && i + 1 < parts.length) return parts[i + 1];
    return issueUrl;
  }
  return undefined;
}

export function refMatchesIssue(
  ref: string | undefined,
  target: { id: string; shortId?: string | null },
): boolean {
  if (!ref) return false;
  if (String(ref) === String(target.id)) return true;
  if (target.shortId && String(ref) === String(target.shortId)) return true;
  return false;
}

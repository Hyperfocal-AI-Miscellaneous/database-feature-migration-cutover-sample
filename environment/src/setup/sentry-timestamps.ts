import type { SentryService } from "@hyperfocal/mock-mcp-services/sentry";

export function regenerateTimestamps(
  service: SentryService,
  referenceNow: Date = new Date(),
): void {
  const max = findMaxTimestampMs(service);
  if (max === null) return;

  const deltaMs = referenceNow.getTime() - max;
  if (deltaMs === 0) return;

  for (const issue of service.data.issues) {
    const record = issue as unknown as Record<string, unknown>;
    for (const key of ISSUE_TIME_KEYS) shiftField(record, key, deltaMs);
  }
  for (const event of service.data.events) {
    const record = event as unknown as Record<string, unknown>;
    for (const key of EVENT_TIME_KEYS) shiftField(record, key, deltaMs);
  }
}

const ISSUE_TIME_KEYS = ["firstSeen", "lastSeen"] as const;
const EVENT_TIME_KEYS = ["dateCreated"] as const;

function parseIso(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function findMaxTimestampMs(service: SentryService): number | null {
  let max: number | null = null;
  for (const issue of service.data.issues) {
    for (const key of ISSUE_TIME_KEYS) {
      const ms = parseIso((issue as Record<string, unknown>)[key]);
      if (ms !== null && (max === null || ms > max)) max = ms;
    }
  }
  for (const event of service.data.events) {
    for (const key of EVENT_TIME_KEYS) {
      const ms = parseIso((event as Record<string, unknown>)[key]);
      if (ms !== null && (max === null || ms > max)) max = ms;
    }
  }
  return max;
}

function shiftField(
  obj: Record<string, unknown>,
  key: string,
  deltaMs: number,
): void {
  const ms = parseIso(obj[key]);
  if (ms === null) return;
  obj[key] = new Date(ms + deltaMs).toISOString();
}

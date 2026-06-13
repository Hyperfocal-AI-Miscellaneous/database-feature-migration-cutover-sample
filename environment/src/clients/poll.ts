export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${description} (after ${timeoutMs}ms)`);
}

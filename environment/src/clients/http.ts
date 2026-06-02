export interface HttpResponse {
  status: number;
  body: string;
}

export async function httpGet(
  url: string,
  opts?: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      headers: opts?.headers,
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

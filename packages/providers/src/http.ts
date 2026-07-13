/**
 * Minimal fetch-shaped transport for the adapters that speak plain HTTP
 * (Google, Ollama). Injected so tests run without a network and without mocks
 * of global state; defaults to the platform fetch.
 */
export interface ResponseLike {
  ok: boolean;
  status: number;
  body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<ResponseLike>;

export const platformFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as Promise<ResponseLike>;

export interface RetryPolicy {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff step in ms; doubles each retry. Default 500. */
  baseDelayMs?: number;
  /** Injectable for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** 429 (rate limit), 408 (timeout), and 5xx are worth retrying; 4xx are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Rate-limit and transient-failure resilience for the fetch-based adapters —
 * subscription backends (Codex, Gemini CLI) hit plan quotas, so backing off and
 * retrying is robustness the thesis demands. The official SDK adapters
 * (Anthropic, OpenAI) already retry internally, so they don't use this. Only
 * non-OK responses and thrown errors retry; a streamed 200 returns untouched.
 */
export async function fetchWithRetry(
  fetchFn: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  policy: RetryPolicy = {},
): Promise<ResponseLike> {
  const maxAttempts = Math.max(1, policy.maxAttempts ?? 3);
  const base = policy.baseDelayMs ?? 500;
  const sleep = policy.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const backoff = (attempt: number) => base * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchFn(url, init);
      if (attempt < maxAttempts && isRetryableStatus(response.status)) {
        await sleep(backoff(attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) throw error;
      await sleep(backoff(attempt));
    }
  }
  throw lastError;
}

/** Yield complete UTF-8 lines from a streamed body (SSE / NDJSON framing). */
export async function* linesFrom(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/** Extract the JSON payload of an SSE `data:` line; undefined for anything else. */
export function sseData(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  const payload = line.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return undefined;
  return payload;
}

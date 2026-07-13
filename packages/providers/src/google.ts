import { fetchWithRetry, platformFetch, type FetchLike } from "./http";
import { buildGeminiInner, consumeGeminiStream, geminiBodyOrThrow, type GeminiChunk } from "./gemini-shared";
import { ProviderError, type CompletionRequest, type CompletionResult, type DeltaHandler, type ProviderAdapter } from "./types";

export interface GoogleAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
}

/** Speaks the Gemini REST API directly (v1beta, SSE) — text, tools, and JSON. */
export class GoogleAdapter implements ProviderAdapter {
  readonly provider = "google";
  readonly supportsTools = true;
  readonly supportsResponseFormat = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(options: GoogleAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com";
    this.fetchFn = options.fetchFn ?? platformFetch;
  }

  async complete(request: CompletionRequest, onDelta?: DeltaHandler): Promise<CompletionResult> {
    const body = buildGeminiInner(request);
    if ((body.contents as unknown[]).length === 0) {
      throw new ProviderError(this.provider, "at least one non-system message is required");
    }
    const response = await fetchWithRetry(
      this.fetchFn,
      `${this.baseUrl}/v1beta/models/${request.model}:streamGenerateContent?alt=sse`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, body: JSON.stringify(body) },
    );
    const stream = await geminiBodyOrThrow(response, this.provider);
    return consumeGeminiStream(stream, onDelta, (parsed) => parsed as GeminiChunk);
  }
}

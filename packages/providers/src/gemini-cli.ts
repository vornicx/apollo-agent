import { fetchWithRetry, platformFetch, type FetchLike } from "./http";
import { buildGeminiInner, consumeGeminiStream, type GeminiChunk } from "./gemini-shared";
import { ProviderError, type CompletionRequest, type CompletionResult, type DeltaHandler, type ProviderAdapter } from "./types";

export interface GeminiCliAdapterOptions {
  accessToken: string;
  /** Discovered via loadCodeAssist when omitted. */
  projectId?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
}

/**
 * Google-account execution through the Code Assist backend the open-source
 * Gemini CLI uses ("Login with Google" free-tier quotas). Requires a prior
 * `gemini` login; project onboarding stays in the official CLI.
 */
export class GeminiCliAdapter implements ProviderAdapter {
  readonly provider = "gemini-cli";
  readonly supportsTools = true;
  readonly supportsResponseFormat = true;
  private readonly options: GeminiCliAdapterOptions;
  private readonly fetchFn: FetchLike;
  private projectId?: string;

  constructor(options: GeminiCliAdapterOptions) {
    this.options = options;
    this.projectId = options.projectId;
    this.fetchFn = options.fetchFn ?? platformFetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.options.accessToken}`,
    };
  }

  private base(): string {
    return this.options.baseUrl ?? "https://cloudcode-pa.googleapis.com";
  }

  private async ensureProject(): Promise<string> {
    if (this.projectId) return this.projectId;
    const response = await this.fetchFn(`${this.base()}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
      }),
    });
    if (!response.ok) {
      throw new ProviderError(this.provider, `loadCodeAssist HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const parsed = JSON.parse(await response.text()) as { cloudaicompanionProject?: string };
    if (!parsed.cloudaicompanionProject) {
      throw new ProviderError(this.provider, "no Code Assist project — run `gemini` once to finish onboarding");
    }
    this.projectId = parsed.cloudaicompanionProject;
    return this.projectId;
  }

  async complete(request: CompletionRequest, onDelta?: DeltaHandler): Promise<CompletionResult> {
    const project = await this.ensureProject();
    const inner = buildGeminiInner(request);
    if ((inner.contents as unknown[]).length === 0) {
      throw new ProviderError(this.provider, "at least one non-system message is required");
    }
    const response = await fetchWithRetry(this.fetchFn, `${this.base()}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: request.model, project, request: inner }),
    });
    if (!response.ok || !response.body) {
      throw new ProviderError(
        this.provider,
        `HTTP ${response.status}: ${(await response.text()).slice(0, 300)} — if this is 401, log in again with \`gemini\``,
      );
    }
    // Code Assist nests the chunk under `response`.
    return consumeGeminiStream(response.body, onDelta, (parsed) => (parsed as { response?: GeminiChunk }).response ?? {});
  }
}

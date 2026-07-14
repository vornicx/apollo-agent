import type { ModelProfile } from "@archic/apollo-router";
import {
  ProviderError,
  type ChatMessage,
  type CompletionResult,
  type DeltaHandler,
  type ProviderAdapter,
  type ResponseFormat,
  type ToolChoice,
  type ToolDefinition,
} from "./types";

export interface HarnessCompletion extends CompletionResult {
  /** Apollo model id (e.g. "anthropic/claude-opus-4-8"). */
  modelId: string;
  /** Real cost computed from reported usage × the model's profile pricing. */
  costUsd?: number;
  seconds: number;
  /** Wall time until the first streamed text delta (or completion for non-streaming adapters). */
  ttftMs: number;
}

/**
 * Resolves a routed model profile to its provider adapter, translates the
 * Apollo model id to the provider-native name, and prices the real usage.
 */
export class ProviderHub {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  has(provider: string): boolean {
    return this.adapters.has(provider);
  }

  providers(): string[] {
    return [...this.adapters.keys()];
  }

  get(provider: string): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  async completeForModel(
    profile: ModelProfile,
    request: {
      messages: ChatMessage[];
      maxTokens?: number;
      tools?: ToolDefinition[];
      toolChoice?: ToolChoice;
      responseFormat?: ResponseFormat;
    },
    onDelta?: DeltaHandler,
  ): Promise<HarnessCompletion> {
    const adapter = this.adapters.get(profile.provider);
    if (!adapter) {
      throw new ProviderError(
        profile.provider,
        `no adapter configured — add credentials for "${profile.provider}" to apollo.config.json or deny/disable its models`,
      );
    }
    if (request.tools?.length && adapter.supportsTools === false) {
      throw new ProviderError(profile.provider, `adapter does not support tool calls (model ${profile.id})`);
    }
    if (request.responseFormat && adapter.supportsResponseFormat === false) {
      throw new ProviderError(profile.provider, `adapter does not support structured output (model ${profile.id})`);
    }
    const nativeModel = profile.nativeId ?? profile.id.slice(profile.id.indexOf("/") + 1);
    const started = Date.now();
    let ttftMs: number | undefined;
    const result = await adapter.complete({ ...request, model: nativeModel }, (text) => {
      ttftMs ??= Date.now() - started;
      onDelta?.(text);
    });
    const seconds = (Date.now() - started) / 1000;
    ttftMs ??= Math.round(seconds * 1000);

    let costUsd: number | undefined;
    if (result.usage && (result.usage.inputTokens !== undefined || result.usage.outputTokens !== undefined)) {
      costUsd =
        ((result.usage.inputTokens ?? 0) / 1_000_000) * profile.cost.inputPerMTok +
        ((result.usage.outputTokens ?? 0) / 1_000_000) * profile.cost.outputPerMTok;
    }
    return { ...result, modelId: profile.id, costUsd, seconds, ttftMs };
  }
}

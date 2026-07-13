import type { ModelProfile } from "@archic/apollo-router";
import type { ChatMessage, ProviderHub, TokenUsage } from "@archic/apollo-providers";

export interface StructuredResult<T> {
  value: T;
  /** The raw JSON text the model returned, before parsing. */
  raw: string;
  costUsd: number;
  usage?: TokenUsage;
}

export interface RunStructuredOptions {
  hub: ProviderHub;
  model: ModelProfile;
  messages: ChatMessage[];
  /** JSON Schema the output must match. */
  schema: Record<string, unknown>;
  /** Schema name (shown to the provider). Default "output". */
  name?: string;
  maxTokens?: number;
}

/**
 * Ask the model for JSON matching a schema and parse it. Uses the provider's
 * native structured-output path (OpenAI json_schema, Anthropic/Ollama forced
 * tool) via the port's `responseFormat`, so callers get a typed object instead
 * of scraping prose. Throws if the returned text isn't valid JSON.
 */
export async function runStructured<T = unknown>(options: RunStructuredOptions): Promise<StructuredResult<T>> {
  const completion = await options.hub.completeForModel(options.model, {
    messages: options.messages,
    responseFormat: { name: options.name ?? "output", schema: options.schema, strict: true },
    maxTokens: options.maxTokens,
  });
  let value: T;
  try {
    value = JSON.parse(completion.text) as T;
  } catch {
    throw new Error(`structured output was not valid JSON: ${completion.text.slice(0, 200)}`);
  }
  return { value, raw: completion.text, costUsd: completion.costUsd ?? 0, usage: completion.usage };
}

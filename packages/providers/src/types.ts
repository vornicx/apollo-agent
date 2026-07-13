/** A tool call the model requested — provider-agnostic. */
export interface ToolCall {
  /** Provider-issued id; echoed back on the tool result so replies pair up. */
  id: string;
  name: string;
  /** Parsed arguments. Never trust these blindly — validate before acting. */
  arguments: Record<string, unknown>;
}

export interface ToolResultMessage {
  role: "tool";
  /** Must match the ToolCall.id being answered (used by OpenAI/Anthropic/Codex). */
  toolCallId: string;
  /** Tool name — Gemini pairs results to calls by name, not id. */
  name?: string;
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  /** Assistant text (may be empty when the turn is purely tool calls). */
  content: string;
  /** Tool calls the assistant made this turn, replayed back on the next request. */
  toolCalls?: ToolCall[];
}

export interface PlainMessage {
  role: "system" | "user";
  content: string;
}

export type ChatMessage = PlainMessage | AssistantMessage | ToolResultMessage;

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "required" | "none";

/**
 * Request the model return JSON matching a schema. `strict` asks the provider
 * to constrain decoding to the schema where supported (OpenAI); otherwise it
 * is delivered as guidance and validated after the fact.
 */
export interface ResponseFormat {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface CompletionRequest {
  /** Provider-native model name (e.g. "claude-opus-4-8", "qwen3-coder:30b"). */
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Tools the model may call this turn. */
  tools?: ToolDefinition[];
  /** How the model should use tools. Defaults to "auto" when tools are present. */
  toolChoice?: ToolChoice;
  /** Ask for schema-constrained JSON output. */
  responseFormat?: ResponseFormat;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CompletionResult {
  text: string;
  /** Tool calls the model requested — empty/absent when it answered in text. */
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  /** Provider-native stop/finish reason, normalized to lowercase. */
  stopReason?: string;
}

export type DeltaHandler = (text: string) => void;

/**
 * The single port every provider implements. Streamed text completion is the
 * base; tool calls and structured outputs are optional capabilities. An adapter
 * that receives `tools` or `responseFormat` it cannot honor must throw a
 * ProviderError rather than silently ignore the request — the router should
 * route capability-gated work only to adapters that support it.
 */
export interface ProviderAdapter {
  readonly provider: string;
  complete(request: CompletionRequest, onDelta?: DeltaHandler): Promise<CompletionResult>;
  /** Capability flags so callers and the hub can gate tool/JSON work. */
  readonly supportsTools?: boolean;
  readonly supportsResponseFormat?: boolean;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

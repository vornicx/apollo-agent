import Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicMessages, toAnthropicTools } from "./messages";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type DeltaHandler,
  type ProviderAdapter,
  type ToolCall,
} from "./types";

/**
 * The slice of the official SDK this adapter uses, duck-typed so tests can
 * inject a fake without network access. The real client satisfies it.
 */
export interface AnthropicClientLike {
  messages: {
    stream(params: Record<string, unknown>): AnthropicStreamLike;
  };
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicStreamLike {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<{
    content: AnthropicContentBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string | null;
  }>;
}

export interface AnthropicAdapterOptions {
  apiKey?: string;
  /**
   * Bearer token (ANTHROPIC_AUTH_TOKEN or a Claude Code subscription session).
   * Sent with the documented `anthropic-beta: oauth-2025-04-20` header.
   */
  authToken?: string;
  baseUrl?: string;
  client?: AnthropicClientLike;
}

// A forced tool is how we get schema-constrained JSON out of Claude: give it
// one tool matching the schema and require it — the tool input is the answer.
const JSON_TOOL = "apollo_structured_output";

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic";
  readonly supportsTools = true;
  readonly supportsResponseFormat = true;
  private readonly client: AnthropicClientLike;

  constructor(options: AnthropicAdapterOptions = {}) {
    // With neither apiKey nor authToken, the official SDK resolves credentials
    // itself (env vars, then `ant auth login` profiles).
    this.client =
      options.client ??
      (new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.authToken
          ? { authToken: options.authToken, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } }
          : {}),
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      }) as unknown as AnthropicClientLike);
  }

  async complete(request: CompletionRequest, onDelta?: DeltaHandler): Promise<CompletionResult> {
    const { system, messages } = buildAnthropicMessages(request.messages);
    if (messages.length === 0) throw new ProviderError(this.provider, "at least one non-system message is required");

    // Structured output is a forced single tool; otherwise the caller's tools.
    let tools: unknown[] | undefined;
    let toolChoice: unknown;
    let forced = false;
    if (request.responseFormat) {
      tools = [{ name: JSON_TOOL, description: `Return the result as ${request.responseFormat.name}.`, input_schema: request.responseFormat.schema }];
      toolChoice = { type: "tool", name: JSON_TOOL };
      forced = true;
    } else if (request.tools?.length) {
      tools = toAnthropicTools(request.tools);
      if (request.toolChoice === "required") {
        toolChoice = { type: "any" };
        forced = true;
      } else if (request.toolChoice === "none") {
        toolChoice = { type: "none" };
      } else {
        toolChoice = { type: "auto" };
      }
    }

    // Adaptive thinking is the current default for capable Claude models. It is
    // compatible with auto tool use but not with a FORCED tool_choice, so we
    // only drop it when forcing (structured output or toolChoice "required").
    const supportsAdaptive = !request.model.includes("haiku") && !forced;
    const stream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens ?? 16_000,
      ...(system ? { system } : {}),
      ...(supportsAdaptive ? { thinking: { type: "adaptive" } } : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      messages,
    });
    if (onDelta) stream.on("text", onDelta);

    const final = await stream.finalMessage();
    const text = final.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    const toolUses = final.content.filter((block) => block.type === "tool_use");
    const toolCalls: ToolCall[] = toolUses.map((block) => ({
      id: block.id ?? `call_${block.name}`,
      name: block.name ?? "",
      arguments: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>,
    }));

    // For structured output, the answer is the forced tool's input — surface it
    // as JSON text so callers get a uniform `.text` to parse.
    const structured = request.responseFormat ? toolCalls.find((c) => c.name === JSON_TOOL) : undefined;

    return {
      text: structured ? JSON.stringify(structured.arguments) : text,
      toolCalls: request.responseFormat ? undefined : toolCalls.length ? toolCalls : undefined,
      usage: { inputTokens: final.usage?.input_tokens, outputTokens: final.usage?.output_tokens },
      stopReason: final.stop_reason?.toLowerCase() ?? undefined,
    };
  }
}

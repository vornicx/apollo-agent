import OpenAI from "openai";
import { buildOpenAIMessages, parseArguments, toOpenAITools } from "./messages";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type DeltaHandler,
  type ProviderAdapter,
  type ToolCall,
} from "./types";

/** The slice of the official SDK this adapter uses; tests inject a fake. */
export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
export interface OpenAIChunkLike {
  choices: Array<{
    delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export interface OpenAIClientLike {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<AsyncIterable<OpenAIChunkLike>>;
    };
  };
}

export interface OpenAIAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  client?: OpenAIClientLike;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = "openai";
  readonly supportsTools = true;
  readonly supportsResponseFormat = true;
  private readonly client: OpenAIClientLike;

  constructor(options: OpenAIAdapterOptions) {
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: options.apiKey,
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      }) as unknown as OpenAIClientLike);
  }

  async complete(request: CompletionRequest, onDelta?: DeltaHandler): Promise<CompletionResult> {
    if (request.messages.length === 0) {
      throw new ProviderError(this.provider, "at least one message is required");
    }
    const responseFormat = request.responseFormat
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: request.responseFormat.strict ?? true,
            },
          },
        }
      : {};
    const toolParams = request.tools?.length
      ? {
          tools: toOpenAITools(request.tools),
          tool_choice: request.toolChoice === "required" ? "required" : request.toolChoice === "none" ? "none" : "auto",
        }
      : {};

    const stream = await this.client.chat.completions.create({
      model: request.model,
      messages: buildOpenAIMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxTokens ? { max_completion_tokens: request.maxTokens } : {}),
      ...toolParams,
      ...responseFormat,
    });

    let text = "";
    let stopReason: string | undefined;
    let usage: CompletionResult["usage"];
    // Streamed tool calls arrive as index-keyed fragments; accumulate by index.
    const partial = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const acc = partial.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        partial.set(tc.index, acc);
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason.toLowerCase();
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id || `call_${v.name}`, name: v.name, arguments: parseArguments(v.args) }));

    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage, stopReason };
  }
}

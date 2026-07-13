import { fetchWithRetry, linesFrom, platformFetch, type FetchLike } from "./http";
import { buildOllamaMessages, parseArguments, toOllamaTools } from "./messages";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type DeltaHandler,
  type ProviderAdapter,
  type ToolCall,
} from "./types";

interface OllamaMessagePart {
  content?: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
}
interface OllamaChunk {
  message?: OllamaMessagePart;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaAdapterOptions {
  baseUrl?: string;
  fetchFn?: FetchLike;
}

function readToolCalls(part: OllamaMessagePart | undefined): ToolCall[] {
  return (part?.tool_calls ?? []).map((tc, i) => ({
    id: `call_${tc.function?.name ?? i}`,
    name: tc.function?.name ?? "",
    arguments: parseArguments(tc.function?.arguments),
  }));
}

/** Local models via the Ollama chat API. Free and private. */
export class OllamaAdapter implements ProviderAdapter {
  readonly provider = "ollama";
  readonly supportsTools = true;
  readonly supportsResponseFormat = true;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? "http://localhost:11434";
    this.fetchFn = options.fetchFn ?? platformFetch;
  }

  async complete(request: CompletionRequest, onDelta?: DeltaHandler): Promise<CompletionResult> {
    // Ollama returns tool calls / schema-constrained JSON in a single message;
    // streaming those is unreliable, so we disable streaming when either is asked.
    const wantsStructured = Boolean(request.tools?.length || request.responseFormat);
    const stream = !wantsStructured;

    const response = await fetchWithRetry(this.fetchFn, `${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: buildOllamaMessages(request.messages),
        stream,
        ...(request.tools?.length ? { tools: toOllamaTools(request.tools) } : {}),
        ...(request.responseFormat ? { format: request.responseFormat.schema } : {}),
        ...(request.maxTokens ? { options: { num_predict: request.maxTokens } } : {}),
      }),
    });
    if (!response.ok || !response.body) {
      throw new ProviderError(this.provider, `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    if (!stream) {
      const chunk = JSON.parse(await response.text()) as OllamaChunk;
      const toolCalls = readToolCalls(chunk.message);
      return {
        text: chunk.message?.content ?? "",
        toolCalls: toolCalls.length ? toolCalls : undefined,
        stopReason: chunk.done_reason?.toLowerCase() ?? "stop",
        usage: { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count },
      };
    }

    let text = "";
    let stopReason: string | undefined;
    let usage: CompletionResult["usage"];
    for await (const line of linesFrom(response.body)) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as OllamaChunk;
      const delta = chunk.message?.content;
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
      if (chunk.done) {
        stopReason = chunk.done_reason?.toLowerCase() ?? "stop";
        usage = { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count };
      }
    }
    return { text, usage, stopReason };
  }
}

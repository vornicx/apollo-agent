import { randomUUID } from "node:crypto";
import { fetchWithRetry, linesFrom, platformFetch, sseData, type FetchLike } from "./http";
import { parseArguments } from "./messages";
import {
  ProviderError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type DeltaHandler,
  type ProviderAdapter,
  type ToolCall,
} from "./types";

interface CodexEvent {
  type?: string;
  delta?: string;
  item?: { type?: string; call_id?: string; id?: string; name?: string; arguments?: string };
  response?: {
    status?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    incomplete_details?: { reason?: string };
    error?: { message?: string };
  };
}

/** Build the Responses-API `input` array from the message union. */
function buildCodexInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      if (m.content) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const call of m.toolCalls) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
      }
    } else {
      input.push({
        type: "message",
        role: m.role,
        content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
      });
    }
  }
  return input;
}

export interface CodexAdapterOptions {
  accessToken: string;
  accountId?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
}

/**
 * ChatGPT-subscription execution through the Codex backend (Responses API
 * shape, SSE). Uses the session created by the official `codex login`; Apollo
 * adds no spoofing or evasion — if OpenAI rejects the call, it fails cleanly
 * and the pipeline escalates to the next ranked model. Wire format tracks the
 * open-source Codex CLI; if it drifts, this adapter needs a bump.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex";
  readonly supportsTools = true;
  readonly supportsResponseFormat = true;
  private readonly options: CodexAdapterOptions;
  private readonly fetchFn: FetchLike;

  constructor(options: CodexAdapterOptions) {
    this.options = options;
    this.fetchFn = options.fetchFn ?? platformFetch;
  }

  async complete(request: CompletionRequest, onDelta?: DeltaHandler): Promise<CompletionResult> {
    const instructions =
      request.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n") || "You are a helpful assistant.";
    const input = buildCodexInput(request.messages);
    if (input.length === 0) throw new ProviderError(this.provider, "at least one non-system message is required");

    // Responses API flattens function tools; structured output rides `text.format`.
    const tools = request.tools?.length
      ? request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }))
      : [];
    const toolChoice = request.toolChoice === "required" ? "required" : request.toolChoice === "none" ? "none" : "auto";
    const textFormat = request.responseFormat
      ? { text: { format: { type: "json_schema", name: request.responseFormat.name, schema: request.responseFormat.schema, strict: request.responseFormat.strict ?? true } } }
      : {};

    const response = await fetchWithRetry(this.fetchFn, `${this.options.baseUrl ?? "https://chatgpt.com/backend-api/codex"}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${this.options.accessToken}`,
        ...(this.options.accountId ? { "chatgpt-account-id": this.options.accountId } : {}),
        "openai-beta": "responses=experimental",
        originator: "codex_cli_rs",
        session_id: randomUUID(),
      },
      body: JSON.stringify({
        model: request.model,
        instructions,
        input,
        tools,
        tool_choice: toolChoice,
        // The agent registry executes independent calls concurrently and keeps
        // result order stable. Let Codex expose that parallelism instead of
        // forcing one network round trip per read/search tool.
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include: [],
        ...textFormat,
        // The ChatGPT subscription Codex endpoint rejects max_output_tokens
        // even though the public Responses API accepts it. Output limits stay
        // enforced by the cognitive-cycle turn/budget guards on this surface.
      }),
    });
    if (!response.ok || !response.body) {
      throw new ProviderError(
        this.provider,
        `HTTP ${response.status}: ${(await response.text()).slice(0, 300)} — if this is 401, run any \`codex\` command to refresh the session`,
      );
    }

    let text = "";
    let stopReason: string | undefined;
    let usage: CompletionResult["usage"];
    const toolCalls: ToolCall[] = [];
    for await (const line of linesFrom(response.body)) {
      const payload = sseData(line);
      if (!payload) continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(payload) as CodexEvent;
      } catch {
        continue;
      }
      if (event.type === "response.output_text.delta" && event.delta) {
        text += event.delta;
        onDelta?.(event.delta);
      } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        toolCalls.push({
          id: event.item.call_id ?? event.item.id ?? `call_${event.item.name}`,
          name: event.item.name ?? "",
          arguments: parseArguments(event.item.arguments),
        });
      } else if (event.type === "response.completed") {
        stopReason = toolCalls.length ? "tool_calls" : "stop";
        const u = event.response?.usage;
        if (u) usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
      } else if (event.type === "response.incomplete") {
        stopReason = event.response?.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "incomplete";
      } else if (event.type === "response.failed") {
        throw new ProviderError(this.provider, event.response?.error?.message ?? "response.failed");
      }
    }
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage, stopReason };
  }
}

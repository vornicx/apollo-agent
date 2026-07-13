import type { ChatMessage, ToolCall, ToolDefinition } from "./types";

/**
 * Translates Apollo's provider-agnostic ChatMessage union into each provider's
 * native message shape — the one place the union's tool-call and tool-result
 * variants are unpacked, so the adapters stay small.
 */

// ---- Anthropic (content-block based) ----

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}
type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export function buildAnthropicMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return { system, messages: out };
}

export function toAnthropicTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

// ---- OpenAI (role:tool + tool_calls) ----

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export function buildOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

// ---- Ollama (object-arg tool calls, no ids) ----

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

export function buildOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOllamaTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

// ---- Gemini (functionCall / functionResponse parts) ----

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Builds the Gemini `contents` array (system is handled separately by the adapter). */
export function buildGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name ?? "tool", response: { result: m.content } } }],
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls) parts.push({ functionCall: { name: call.name, args: call.arguments } });
      out.push({ role: "model", parts });
    } else {
      out.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
    }
  }
  return out;
}

export function toGeminiTools(tools: ToolDefinition[]): unknown[] {
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
}

/** Map Apollo's toolChoice to Gemini's functionCallingConfig mode. */
export function geminiToolMode(choice: "auto" | "required" | "none" | undefined): string {
  return choice === "required" ? "ANY" : choice === "none" ? "NONE" : "AUTO";
}

/** Pull tool calls out of a Gemini candidate's parts. */
export function geminiToolCalls(parts: GeminiPart[] | undefined): ToolCall[] {
  return (parts ?? [])
    .filter((p) => p.functionCall)
    .map((p, i) => ({
      id: `call_${p.functionCall!.name}_${i}`,
      name: p.functionCall!.name,
      arguments: p.functionCall!.args ?? {},
    }));
}

/** Safe JSON-arguments parse: providers may send a string or an object. */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // fall through to empty
    }
  }
  return {};
}

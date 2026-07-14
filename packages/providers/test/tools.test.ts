import { describe, expect, it } from "vitest";
import {
  AnthropicAdapter,
  CodexAdapter,
  GeminiCliAdapter,
  GoogleAdapter,
  OllamaAdapter,
  OpenAIAdapter,
  type AnthropicClientLike,
  type ChatMessage,
  type FetchLike,
  type OpenAIClientLike,
  type ToolDefinition,
} from "../src/index";

function sseStream(lines: string[]): ReturnType<FetchLike> {
  const payload = lines.map((l) => `data: ${l}`).join("\n\n") + "\n\n";
  return Promise.resolve({
    ok: true,
    status: 200,
    body: (async function* () {
      yield new TextEncoder().encode(payload);
    })(),
    text: async () => payload,
  });
}

const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "Get weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

describe("AnthropicAdapter tool use", () => {
  it("sends tools and parses tool_use blocks into ToolCalls", async () => {
    let captured: Record<string, unknown> = {};
    const client: AnthropicClientLike = {
      messages: {
        stream(params) {
          captured = params;
          return {
            on: () => undefined,
            finalMessage: async () => ({
              content: [
                { type: "text", text: "checking" },
                { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Madrid" } },
              ],
              usage: { input_tokens: 20, output_tokens: 8 },
              stop_reason: "tool_use",
            }),
          };
        },
      },
    };
    const result = await new AnthropicAdapter({ client }).complete({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "weather in Madrid?" }],
      tools: [weatherTool],
    });

    expect((captured.tools as unknown[])[0]).toMatchObject({ name: "get_weather", input_schema: weatherTool.parameters });
    expect(captured.tool_choice).toEqual({ type: "auto" });
    // forced tool_choice is absent, so adaptive thinking stays on
    expect(captured.thinking).toEqual({ type: "adaptive" });
    expect(result.toolCalls).toEqual([{ id: "tu_1", name: "get_weather", arguments: { city: "Madrid" } }]);
  });

  it("round-trips a tool result and assistant tool call in the transcript", async () => {
    let captured: Record<string, unknown> = {};
    const client: AnthropicClientLike = {
      messages: {
        stream(params) {
          captured = params;
          return { on: () => undefined, finalMessage: async () => ({ content: [{ type: "text", text: "It's sunny." }] }) };
        },
      },
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "get_weather", arguments: { city: "Madrid" } }] },
      { role: "tool", toolCallId: "tu_1", content: "sunny, 30C" },
    ];
    await new AnthropicAdapter({ client }).complete({ model: "claude-opus-4-8", messages });

    const sent = captured.messages as Array<{ role: string; content: unknown }>;
    const assistant = sent.find((m) => m.role === "assistant");
    const toolResult = sent.find((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>)[0].type === "tool_result");
    expect((assistant?.content as Array<{ type: string }>).some((b) => b.type === "tool_use")).toBe(true);
    expect(toolResult).toBeTruthy();
  });

  it("uses a forced tool for structured output and returns JSON text", async () => {
    let captured: Record<string, unknown> = {};
    const client: AnthropicClientLike = {
      messages: {
        stream(params) {
          captured = params;
          return {
            on: () => undefined,
            finalMessage: async () => ({
              content: [{ type: "tool_use", id: "s1", name: "apollo_structured_output", input: { ok: true, n: 3 } }],
              stop_reason: "tool_use",
            }),
          };
        },
      },
    };
    const result = await new AnthropicAdapter({ client }).complete({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "give me json" }],
      responseFormat: { name: "result", schema: { type: "object" }, strict: true },
    });
    expect(captured.tool_choice).toMatchObject({ type: "tool", name: "apollo_structured_output" });
    expect(captured.thinking).toBeUndefined(); // forced choice drops adaptive thinking
    expect(JSON.parse(result.text)).toEqual({ ok: true, n: 3 });
    expect(result.toolCalls).toBeUndefined();
  });
});

describe("OpenAIAdapter tool use", () => {
  it("accumulates streamed tool_call fragments by index", async () => {
    let captured: Record<string, unknown> = {};
    const client: OpenAIClientLike = {
      chat: {
        completions: {
          create: async (params) => {
            captured = params;
            return (async function* () {
              yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather" } }] } }] };
              yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"' } }] } }] };
              yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Madrid"}' } }] } }] };
              yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 9 } };
            })();
          },
        },
      },
    };
    const result = await new OpenAIAdapter({ client }).complete({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "weather in Madrid?" }],
      tools: [weatherTool],
    });

    expect((captured.tools as unknown[])[0]).toMatchObject({ type: "function", function: { name: "get_weather" } });
    expect(captured.tool_choice).toBe("auto");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "get_weather", arguments: { city: "Madrid" } }]);
    expect(result.stopReason).toBe("tool_calls");
  });

  it("passes response_format json_schema for structured output", async () => {
    let captured: Record<string, unknown> = {};
    const client: OpenAIClientLike = {
      chat: {
        completions: {
          create: async (params) => {
            captured = params;
            return (async function* () {
              yield { choices: [{ delta: { content: '{"x":1}' }, finish_reason: "stop" }] };
            })();
          },
        },
      },
    };
    const result = await new OpenAIAdapter({ client }).complete({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "json" }],
      responseFormat: { name: "shape", schema: { type: "object" }, strict: true },
    });
    expect(captured.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "shape", strict: true } });
    expect(JSON.parse(result.text)).toEqual({ x: 1 });
  });
});

describe("GoogleAdapter (Gemini) function calling", () => {
  it("sends functionDeclarations and parses functionCall parts", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn: FetchLike = (_url, init) => {
      body = JSON.parse(init.body);
      return sseStream([
        JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Madrid" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } }),
      ]);
    };
    const result = await new GoogleAdapter({ apiKey: "k", fetchFn }).complete({
      model: "gemini-3-pro",
      messages: [{ role: "user", content: "weather in Madrid?" }],
      tools: [weatherTool],
    });
    expect((body.tools as Array<{ functionDeclarations: unknown[] }>)[0].functionDeclarations[0]).toMatchObject({ name: "get_weather" });
    expect(body.toolConfig).toMatchObject({ functionCallingConfig: { mode: "AUTO" } });
    expect(result.toolCalls?.[0]).toMatchObject({ name: "get_weather", arguments: { city: "Madrid" } });
  });

  it("builds functionResponse parts from tool results and uses responseSchema for JSON", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn: FetchLike = (_url, init) => {
      body = JSON.parse(init.body);
      return sseStream([JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })]);
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_weather", arguments: { city: "Madrid" } }] },
      { role: "tool", toolCallId: "c1", name: "get_weather", content: "sunny" },
    ];
    await new GoogleAdapter({ apiKey: "k", fetchFn }).complete({ model: "gemini-3-pro", messages, responseFormat: { name: "r", schema: { type: "object" } } });

    const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(contents.find((c) => c.parts[0].functionCall)).toBeTruthy();
    expect(contents.find((c) => c.parts[0].functionResponse)).toMatchObject({ parts: [{ functionResponse: { name: "get_weather" } }] });
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBe("application/json");
  });
});

describe("GeminiCliAdapter function calling (Code Assist)", () => {
  it("nests the request and parses functionCall from the wrapped response", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn: FetchLike = (url, init) => {
      body = JSON.parse(init.body);
      if (url.includes("loadCodeAssist")) {
        return Promise.resolve({ ok: true, status: 200, body: null, text: async () => JSON.stringify({ cloudaicompanionProject: "proj-1" }) });
      }
      return sseStream([JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Madrid" } } }] } }] } })]);
    };
    const result = await new GeminiCliAdapter({ accessToken: "t", fetchFn }).complete({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "weather?" }],
      tools: [weatherTool],
    });
    expect(body).toMatchObject({ model: "gemini-2.5-pro", project: "proj-1" });
    expect((body.request as Record<string, unknown>).tools).toBeTruthy();
    expect(result.toolCalls?.[0]).toMatchObject({ name: "get_weather", arguments: { city: "Madrid" } });
  });
});

describe("CodexAdapter (Responses API) function calling", () => {
  it("sends function tools and parses function_call output items", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn: FetchLike = (_url, init) => {
      body = JSON.parse(init.body);
      return sseStream([
        JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "fc_1", name: "get_weather", arguments: '{"city":"Madrid"}' } }),
        JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 6 } } }),
      ]);
    };
    const result = await new CodexAdapter({ accessToken: "t", fetchFn }).complete({
      model: "gpt-5.1-codex",
      messages: [{ role: "user", content: "weather?" }],
      tools: [weatherTool],
    });
    expect((body.tools as Array<{ type: string; name: string }>)[0]).toMatchObject({ type: "function", name: "get_weather" });
    expect(body.parallel_tool_calls).toBe(true);
    expect(result.toolCalls).toEqual([{ id: "fc_1", name: "get_weather", arguments: { city: "Madrid" } }]);
    expect(result.stopReason).toBe("tool_calls");
  });

  it("round-trips a tool result as function_call_output", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn: FetchLike = (_url, init) => {
      body = JSON.parse(init.body);
      return sseStream([JSON.stringify({ type: "response.output_text.delta", delta: "sunny!" }), JSON.stringify({ type: "response.completed", response: {} })]);
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "fc_1", name: "get_weather", arguments: { city: "Madrid" } }] },
      { role: "tool", toolCallId: "fc_1", name: "get_weather", content: "sunny" },
    ];
    const result = await new CodexAdapter({ accessToken: "t", fetchFn }).complete({ model: "gpt-5.1-codex", messages });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.find((i) => i.type === "function_call")).toMatchObject({ call_id: "fc_1", name: "get_weather" });
    expect(input.find((i) => i.type === "function_call_output")).toMatchObject({ call_id: "fc_1", output: "sunny" });
    expect(result.text).toBe("sunny!");
  });
});

describe("OllamaAdapter tool use", () => {
  it("disables streaming for tools and parses object-arg tool calls", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchFn: FetchLike = (_url, init) => {
      sentBody = JSON.parse(init.body);
      const payload = JSON.stringify({
        message: { content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Madrid" } } }] },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 15,
        eval_count: 4,
      });
      return Promise.resolve({ ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode(payload); })(), text: async () => payload });
    };
    const result = await new OllamaAdapter({ fetchFn }).complete({
      model: "qwen3-coder:30b",
      messages: [{ role: "user", content: "weather?" }],
      tools: [weatherTool],
    });
    expect(sentBody.stream).toBe(false);
    expect((sentBody.tools as unknown[]).length).toBe(1);
    expect(result.toolCalls).toEqual([{ id: "call_get_weather", name: "get_weather", arguments: { city: "Madrid" } }]);
  });
});

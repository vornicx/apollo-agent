import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@archic/apollo-router";
import {
  AnthropicAdapter,
  GoogleAdapter,
  OllamaAdapter,
  OpenAIAdapter,
  ProviderError,
  ProviderHub,
  type AnthropicClientLike,
  type FetchLike,
  type OpenAIClientLike,
  type ProviderAdapter,
} from "../src/index";

function streamedResponse(payload: string): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    body: (async function* () {
      yield new TextEncoder().encode(payload);
    })(),
    text: async () => payload,
  });
}

describe("AnthropicAdapter", () => {
  it("maps the request to the SDK shape and reads the final message", async () => {
    const captured: Record<string, unknown>[] = [];
    const deltas: string[] = [];
    const client: AnthropicClientLike = {
      messages: {
        stream(params) {
          captured.push(params);
          return {
            on(_event, listener) {
              listener("Hel");
              listener("lo");
              return this;
            },
            finalMessage: async () => ({
              content: [{ type: "text", text: "Hello" }],
              usage: { input_tokens: 12, output_tokens: 3 },
              stop_reason: "end_turn",
            }),
          };
        },
      },
    };

    const result = await new AnthropicAdapter({ client }).complete(
      {
        model: "claude-opus-4-8",
        maxTokens: 2_000,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      },
      (d) => deltas.push(d),
    );

    expect(captured[0]).toMatchObject({
      model: "claude-opus-4-8",
      max_tokens: 2_000,
      system: "be terse",
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(deltas.join("")).toBe("Hello");
    expect(result).toMatchObject({
      text: "Hello",
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it("omits adaptive thinking for haiku models", async () => {
    const captured: Record<string, unknown>[] = [];
    const client: AnthropicClientLike = {
      messages: {
        stream(params) {
          captured.push(params);
          return {
            on: () => undefined,
            finalMessage: async () => ({ content: [{ type: "text", text: "ok" }] }),
          };
        },
      },
    };
    await new AnthropicAdapter({ client }).complete({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(captured[0]).not.toHaveProperty("thinking");
  });
});

describe("OpenAIAdapter", () => {
  it("streams chat completion chunks and collects usage", async () => {
    const captured: Record<string, unknown>[] = [];
    const client: OpenAIClientLike = {
      chat: {
        completions: {
          create: async (params) => {
            captured.push(params);
            return (async function* () {
              yield { choices: [{ delta: { content: "Hi" } }] };
              yield {
                choices: [{ delta: { content: " there" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 2 },
              };
            })();
          },
        },
      },
    };

    const result = await new OpenAIAdapter({ client }).complete({
      model: "gpt-5.1",
      maxTokens: 1_000,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(captured[0]).toMatchObject({ model: "gpt-5.1", stream: true, max_completion_tokens: 1_000 });
    expect(result).toMatchObject({
      text: "Hi there",
      stopReason: "stop",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });
});

describe("GoogleAdapter", () => {
  it("parses SSE chunks from the Gemini REST API", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn: FetchLike = (url, init) => {
      calls.push({ url, body: init.body });
      return streamedResponse(
        [
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Ho" }] } }] })}`,
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: "la" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
          })}`,
          "",
        ].join("\n"),
      );
    };

    const result = await new GoogleAdapter({ apiKey: "k", fetchFn }).complete({
      model: "gemini-3-pro",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hola?" },
      ],
    });

    expect(calls[0].url).toContain("/v1beta/models/gemini-3-pro:streamGenerateContent");
    expect(JSON.parse(calls[0].body)).toMatchObject({
      systemInstruction: { parts: [{ text: "be brief" }] },
      contents: [{ role: "user", parts: [{ text: "hola?" }] }],
    });
    expect(result).toMatchObject({
      text: "Hola",
      stopReason: "stop",
      usage: { inputTokens: 4, outputTokens: 2 },
    });
  });
});

describe("OllamaAdapter", () => {
  it("parses NDJSON chunks from the local chat API", async () => {
    const fetchFn: FetchLike = () =>
      streamedResponse(
        [
          JSON.stringify({ message: { content: "local " } }),
          JSON.stringify({ message: { content: "reply" }, done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 2 }),
          "",
        ].join("\n"),
      );

    const result = await new OllamaAdapter({ fetchFn }).complete({
      model: "qwen3-coder:30b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toMatchObject({
      text: "local reply",
      stopReason: "stop",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
  });
});

describe("ProviderHub", () => {
  const profile: ModelProfile = {
    id: "test/model-x",
    nativeId: "model-x:7b",
    provider: "test",
    displayName: "Model X",
    contextWindow: 32_000,
    maxOutputTokens: 8_000,
    capabilities: { code: 0.5 },
    cost: { inputPerMTok: 5, outputPerMTok: 25 },
    latency: { ttftMs: 100, tokensPerSec: 100 },
  };

  it("routes to the adapter, uses nativeId, and prices real usage", async () => {
    const seen: string[] = [];
    const adapter: ProviderAdapter = {
      provider: "test",
      complete: async (request) => {
        seen.push(request.model);
        return { text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 200_000 } };
      },
    };
    const completion = await new ProviderHub()
      .register(adapter)
      .completeForModel(profile, { messages: [{ role: "user", content: "hi" }] });

    expect(seen).toEqual(["model-x:7b"]);
    expect(completion.modelId).toBe("test/model-x");
    expect(completion.costUsd).toBeCloseTo(5 + 5, 5);
  });

  it("throws a ProviderError when no adapter is configured", async () => {
    await expect(
      new ProviderHub().completeForModel(profile, { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrowError(ProviderError);
  });
});

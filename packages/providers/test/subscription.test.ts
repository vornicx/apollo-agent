import { describe, expect, it } from "vitest";
import { CodexAdapter, GeminiCliAdapter, type FetchLike } from "../src/index";

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

describe("CodexAdapter (ChatGPT subscription)", () => {
  it("sends the Codex wire shape and parses Responses SSE events", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchFn: FetchLike = (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return streamedResponse(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}`,
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "!" })}`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 9, output_tokens: 2 } },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n"),
      );
    };

    const deltas: string[] = [];
    const result = await new CodexAdapter({ accessToken: "tok", accountId: "acc-1", fetchFn }).complete(
      {
        model: "gpt-5.1-codex",
        maxTokens: 500,
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
      },
      (d) => deltas.push(d),
    );

    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].headers["chatgpt-account-id"]).toBe("acc-1");
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({
      model: "gpt-5.1-codex",
      instructions: "be brief",
      stream: true,
      store: false,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(deltas.join("")).toBe("Hi!");
    expect(result).toMatchObject({ text: "Hi!", stopReason: "stop", usage: { inputTokens: 9, outputTokens: 2 } });
  });
});

describe("GeminiCliAdapter (Google account)", () => {
  it("discovers the Code Assist project once, then streams", async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = (url, init) => {
      urls.push(url);
      if (url.includes("loadCodeAssist")) {
        const text = JSON.stringify({ cloudaicompanionProject: "proj-42" });
        return Promise.resolve({ ok: true, status: 200, body: null, text: async () => text });
      }
      expect(JSON.parse(init.body)).toMatchObject({ model: "gemini-2.5-pro", project: "proj-42" });
      return streamedResponse(
        [
          `data: ${JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: "hola" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
            },
          })}`,
          "",
        ].join("\n"),
      );
    };

    const adapter = new GeminiCliAdapter({ accessToken: "g-tok", fetchFn });
    const first = await adapter.complete({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "hola?" }] });
    await adapter.complete({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "otra" }] });

    expect(first).toMatchObject({ text: "hola", stopReason: "stop", usage: { inputTokens: 3, outputTokens: 1 } });
    expect(urls.filter((u) => u.includes("loadCodeAssist"))).toHaveLength(1); // project cached
  });
});

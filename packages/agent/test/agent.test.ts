import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@archic/apollo-router";
import { ProviderHub, type ProviderAdapter } from "@archic/apollo-providers";
import { runAgent, runStructured, ToolRegistry } from "../src/index";

const model: ModelProfile = {
  id: "test/tooler",
  provider: "test",
  displayName: "Tooler",
  contextWindow: 100_000,
  maxOutputTokens: 4_000,
  capabilities: { "tool-use": 0.9 },
  cost: { inputPerMTok: 1, outputPerMTok: 2 },
  latency: { ttftMs: 100, tokensPerSec: 100 },
};

/** A scripted adapter: returns queued completions in order, echoing what it saw. */
function scriptedHub(script: Array<{ text: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }>): {
  hub: ProviderHub;
  seen: unknown[][];
} {
  const seen: unknown[][] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    provider: "test",
    supportsTools: true,
    supportsResponseFormat: true,
    async complete(request) {
      seen.push(request.messages as unknown[]);
      const turn = script[Math.min(i++, script.length - 1)];
      return {
        text: turn.text,
        toolCalls: turn.toolCalls,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  return { hub: new ProviderHub().register(adapter), seen };
}

describe("ToolRegistry", () => {
  it("executes handlers and turns thrown errors into strings", async () => {
    const reg = new ToolRegistry()
      .define("add", "add", { type: "object" }, (a) => String((a.x as number) + (a.y as number)))
      .define("boom", "boom", { type: "object" }, () => {
        throw new Error("kaboom");
      });
    expect(await reg.execute({ id: "1", name: "add", arguments: { x: 2, y: 3 } })).toBe("5");
    expect(await reg.execute({ id: "2", name: "boom", arguments: {} })).toContain("kaboom");
    expect(await reg.execute({ id: "3", name: "nope", arguments: {} })).toContain("unknown tool");
    expect(reg.definitions().map((d) => d.name)).toEqual(["add", "boom"]);
  });
});

describe("runAgent", () => {
  it("calls a tool, feeds the result back, and finishes", async () => {
    const { hub, seen } = scriptedHub([
      { text: "let me compute", toolCalls: [{ id: "c1", name: "add", arguments: { x: 2, y: 3 } }] },
      { text: "The answer is 5." },
    ]);
    const tools = new ToolRegistry().define("add", "add two numbers", { type: "object" }, (a) =>
      String((a.x as number) + (a.y as number)),
    );

    const called: string[] = [];
    const result = await runAgent({ hub, model, messages: [{ role: "user", content: "what is 2+3?" }], tools, onToolCall: (c) => called.push(c.name) });

    expect(result.stoppedReason).toBe("completed");
    expect(result.text).toBe("The answer is 5.");
    expect(called).toEqual(["add"]);
    expect(result.steps).toHaveLength(2);
    expect(result.totalCostUsd).toBeCloseTo(2 * ((10 / 1e6) * 1 + (5 / 1e6) * 2), 10);
    // second request must include the tool result in the transcript
    const secondTurn = seen[1] as Array<{ role: string }>;
    expect(secondTurn.some((m) => m.role === "tool")).toBe(true);
    expect(secondTurn.some((m) => m.role === "assistant")).toBe(true);
  });

  it("stops at maxSteps when the model keeps calling tools", async () => {
    const { hub } = scriptedHub([{ text: "again", toolCalls: [{ id: "c", name: "loop", arguments: {} }] }]);
    const tools = new ToolRegistry().define("loop", "loops", { type: "object" }, () => "keep going");
    const result = await runAgent({ hub, model, messages: [{ role: "user", content: "go" }], tools, maxSteps: 3 });
    expect(result.stoppedReason).toBe("max-steps");
    expect(result.steps).toHaveLength(3);
  });

  it("runs read-only calls concurrently but serializes batches with side effects", async () => {
    let active = 0;
    let maxActive = 0;
    const read = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return "read";
    };
    const readHub = scriptedHub([
      { text: "", toolCalls: [{ id: "r1", name: "read", arguments: {} }, { id: "r2", name: "read", arguments: {} }] },
      { text: "done" },
    ]).hub;
    const reads = new ToolRegistry().define("read", "read", { type: "object" }, read);
    await runAgent({ hub: readHub, model, messages: [{ role: "user", content: "read" }], tools: reads });
    expect(maxActive).toBe(2);

    const order: string[] = [];
    const mixedHub = scriptedHub([
      { text: "", toolCalls: [{ id: "w", name: "write", arguments: {} }, { id: "r", name: "read", arguments: {} }] },
      { text: "done" },
    ]).hub;
    const mixed = new ToolRegistry()
      .define("write", "write", { type: "object" }, async () => { order.push("write"); return "wrote"; }, true)
      .define("read", "read", { type: "object" }, async () => { order.push("read"); return "read"; });
    await runAgent({ hub: mixedHub, model, messages: [{ role: "user", content: "change" }], tools: mixed });
    expect(order).toEqual(["write", "read"]);
  });
});

describe("runStructured", () => {
  it("requests responseFormat and parses the JSON result", async () => {
    let sawFormat: unknown;
    const adapter: ProviderAdapter = {
      provider: "test",
      supportsResponseFormat: true,
      async complete(request) {
        sawFormat = request.responseFormat;
        return { text: '{"sentiment":"positive","score":0.9}', usage: { inputTokens: 4, outputTokens: 6 } };
      },
    };
    const hub = new ProviderHub().register(adapter);
    const schema = { type: "object", properties: { sentiment: { type: "string" }, score: { type: "number" } } };
    const out = await runStructured<{ sentiment: string; score: number }>({
      hub,
      model,
      messages: [{ role: "user", content: "classify: great product" }],
      schema,
      name: "classification",
    });
    expect(out.value).toEqual({ sentiment: "positive", score: 0.9 });
    expect(sawFormat).toMatchObject({ name: "classification", strict: true });
  });

  it("throws when the model returns non-JSON", async () => {
    const adapter: ProviderAdapter = {
      provider: "test",
      supportsResponseFormat: true,
      async complete() {
        return { text: "not json at all" };
      },
    };
    const hub = new ProviderHub().register(adapter);
    await expect(
      runStructured({ hub, model, messages: [{ role: "user", content: "x" }], schema: { type: "object" } }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

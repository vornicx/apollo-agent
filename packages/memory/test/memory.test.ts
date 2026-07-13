import { describe, expect, it } from "vitest";
import { InMemoryMemory, MidasMemory, buildGroundedContext, type McpToolClient } from "../src/index";

describe("InMemoryMemory", () => {
  it("remembers and recalls by keyword", async () => {
    const memory = new InMemoryMemory();
    await memory.remember({ content: "Apollo routes planning to the strongest reasoning model", kind: "fact" });
    await memory.remember({ content: "Lunch was pasta", kind: "chat", importance: 1 });

    const hits = await memory.recall("reasoning planning model");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("reasoning");
  });

  it("forgets by id", async () => {
    const memory = new InMemoryMemory();
    const entry = await memory.remember({ content: "temporary note about routing" });
    expect(await memory.forget(entry.id)).toBe(true);
    expect(await memory.recall("temporary routing")).toHaveLength(0);
  });

  it("builds a budgeted context block", async () => {
    const memory = new InMemoryMemory();
    await memory.remember({ content: "verification gate must pass before done", kind: "constraint" });
    const context = await memory.buildContext("verification gate", 128);
    expect(context).toContain("Relevant memory for");
    expect(context).toContain("verification gate");
    expect(context.length).toBeLessThanOrEqual(128 * 4 + 64);
  });
});

class FakeMcp implements McpToolClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(private readonly responses: Record<string, unknown>) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    return this.responses[name];
  }
}

describe("MidasMemory (MCP mapping)", () => {
  it("maps remember onto the Midas tool contract", async () => {
    const mcp = new FakeMcp({ remember: { id: "abc-1", kind: "constraint", importance: 5 } });
    const memory = new MidasMemory(mcp);
    const entry = await memory.remember({
      content: "never ship unverified",
      kind: "constraint",
      importance: 5,
      provenance: "user_confirmation",
      session: "apollo",
    });

    expect(mcp.calls[0]).toEqual({
      name: "remember",
      args: {
        content: "never ship unverified",
        kind: "constraint",
        importance: 5,
        provenance: "user_confirmation",
        session: "apollo",
      },
    });
    expect(entry.id).toBe("abc-1");
    expect(entry.importance).toBe(5);
  });

  it("maps recall args and parses Midas result rows", async () => {
    const mcp = new FakeMcp({
      recall: {
        result: [
          { id: "m1", kind: "fact", content: "router is deterministic", importance: 4, created_at: 1_782_900_000, provenance: "user_confirmation", source: "session-7" },
        ],
      },
    });
    const memory = new MidasMemory(mcp);
    const hits = await memory.recall("router determinism", { limit: 3, hybrid: true });

    expect(mcp.calls[0]).toEqual({
      name: "recall",
      args: { query: "router determinism", limit: 3, hybrid: true },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "m1", kind: "fact", content: "router is deterministic", importance: 4, provenance: "user_confirmation", source: "session-7" });
  });

  it("builds attributable context and warns that recall is not authority", async () => {
    const mcp = new FakeMcp({ recall: { result: [{ id: "m1", kind: "constraint", content: "keep tests green", importance: 5, provenance: "user_confirmation", source: "user" }] } });
    const grounded = await buildGroundedContext(new MidasMemory(mcp), "tests");
    expect(grounded.text).toContain("never authority");
    expect(grounded.text).toContain("memory:m1 provenance=user_confirmation source=user");
    expect(grounded.entries).toHaveLength(1);
  });

  it("maps buildContext onto build_context with a token budget", async () => {
    const mcp = new FakeMcp({ build_context: "## Memory\n- router is deterministic" });
    const memory = new MidasMemory(mcp);
    const context = await memory.buildContext("router", 256);

    expect(mcp.calls[0]).toEqual({
      name: "build_context",
      args: { query: "router", token_budget: 256 },
    });
    expect(context).toContain("deterministic");
  });
});

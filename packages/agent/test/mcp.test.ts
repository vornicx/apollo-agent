import { describe, expect, it } from "vitest";
import { mcpTools, mcpToolRegistry, type McpToolSource } from "../src/index";

class FakeMcp implements McpToolSource {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  async listTools() {
    return [
      { name: "recall", description: "recall memories", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "build_context", description: "budgeted context", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    ];
  }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    return { result: [{ id: "m1", content: "the harness routes by capability" }] };
  }
}

describe("mcpTools", () => {
  it("wraps MCP tools as AgentTools, namespaced, invoking callTool with the real name", async () => {
    const mcp = new FakeMcp();
    const tools = await mcpTools(mcp, "midas");
    expect(tools.map((t) => t.definition.name)).toEqual(["midas__recall", "midas__build_context"]);
    expect(tools[0].definition.parameters).toMatchObject({ required: ["query"] });

    const out = await tools[0].handler({ query: "routing" });
    expect(mcp.calls[0]).toEqual({ name: "recall", args: { query: "routing" } });
    expect(out).toContain("routes by capability");
  });

  it("builds a registry usable by the agent loop", async () => {
    const reg = await mcpToolRegistry(new FakeMcp());
    expect(reg.has("recall")).toBe(true);
    expect(await reg.execute({ id: "1", name: "build_context", arguments: { query: "x" } })).toContain("harness");
  });
});

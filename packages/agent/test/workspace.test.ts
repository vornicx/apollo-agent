import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderHub, type ProviderAdapter, type ToolCall } from "@archic/apollo-providers";
import { resolveInWorkspace, runAgent, workspaceTools } from "../src/index";
import type { ModelProfile } from "@archic/apollo-router";

const model: ModelProfile = {
  id: "test/m",
  provider: "test",
  displayName: "M",
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  capabilities: {},
  cost: { inputPerMTok: 0, outputPerMTok: 0 },
  latency: { ttftMs: 10, tokensPerSec: 100 },
};

describe("workspaceTools", () => {
  it("writes, reads back, and edits files within the jail", async () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    const tools = workspaceTools(root, { shell: false });
    expect(await tools.execute({ id: "1", name: "write_file", arguments: { path: "a/b.txt", content: "hello world" } })).toContain("wrote");
    expect(readFileSync(join(root, "a/b.txt"), "utf8")).toBe("hello world");
    expect(await tools.execute({ id: "2", name: "read_file", arguments: { path: "a/b.txt" } })).toContain("hello world");
    expect(await tools.execute({ id: "3", name: "edit_file", arguments: { path: "a/b.txt", old: "world", new: "there" } })).toContain("edited");
    expect(readFileSync(join(root, "a/b.txt"), "utf8")).toBe("hello there");
  });

  it("refuses a non-unique edit and reports missing strings", async () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    const tools = workspaceTools(root, { shell: false });
    await tools.execute({ id: "1", name: "write_file", arguments: { path: "x.txt", content: "a a a" } });
    expect(await tools.execute({ id: "2", name: "edit_file", arguments: { path: "x.txt", old: "a", new: "b" } })).toContain("not unique");
    expect(await tools.execute({ id: "3", name: "edit_file", arguments: { path: "x.txt", old: "zzz", new: "b" } })).toContain("not found");
  });

  it("marks write/edit/run_command destructive and read tools safe", () => {
    const tools = workspaceTools(mkdtempSync(join(tmpdir(), "apollo-ws-")));
    expect(tools.isDestructive("write_file")).toBe(true);
    expect(tools.isDestructive("edit_file")).toBe(true);
    expect(tools.isDestructive("run_command")).toBe(true);
    expect(tools.isDestructive("read_file")).toBe(false);
    expect(tools.isDestructive("grep")).toBe(false);
  });

  it("runs a shell command in the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    const tools = workspaceTools(root);
    const out = await tools.execute({ id: "1", name: "run_command", arguments: { command: "echo apollo-ok" } });
    expect(out).toContain("exit 0");
    expect(out).toContain("apollo-ok");
  });

  it("jails paths against traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    expect(() => resolveInWorkspace(root, "../escape")).toThrow(/escapes the workspace/);
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(/escapes the workspace/);
    expect(resolveInWorkspace(root, "ok/file.txt")).toContain(root);
  });
});

describe("runAgent confirm gating", () => {
  function hub(script: Array<{ toolCalls?: ToolCall[]; text?: string }>): ProviderHub {
    let i = 0;
    const adapter: ProviderAdapter = {
      provider: "test",
      supportsTools: true,
      async complete() {
        const turn = script[Math.min(i++, script.length - 1)];
        return { text: turn.text ?? "", toolCalls: turn.toolCalls, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return new ProviderHub().register(adapter);
  }

  it("denies destructive tools when confirm returns false and tells the model", async () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    const tools = workspaceTools(root, { shell: false });
    const result = await runAgent({
      hub: hub([
        { toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "danger.txt", content: "x" } }] },
        { text: "understood, not writing" },
      ]),
      model,
      messages: [{ role: "user", content: "write a file" }],
      tools,
      onConfirm: () => false,
    });
    expect(result.steps[0].toolResults[0].result).toContain("CONFIRMATION_REQUIRED");
    // the file must NOT have been written
    expect(() => readFileSync(join(root, "danger.txt"), "utf8")).toThrow();
  });

  it("allows destructive tools when confirm returns true", async () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    const tools = workspaceTools(root, { shell: false });
    await runAgent({
      hub: hub([
        { toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "ok.txt", content: "written" } }] },
        { text: "done" },
      ]),
      model,
      messages: [{ role: "user", content: "write a file" }],
      tools,
      onConfirm: () => true,
    });
    expect(readFileSync(join(root, "ok.txt"), "utf8")).toBe("written");
  });
});

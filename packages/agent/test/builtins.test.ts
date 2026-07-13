import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinTools, calculate } from "../src/index";

describe("calculate", () => {
  it("evaluates arithmetic and rejects anything else", () => {
    expect(calculate("(2 + 3) * 4")).toBe(20);
    expect(calculate("2 ** 10")).toBe(1024);
    expect(() => calculate("process.exit(1)")).toThrow(/only numbers/);
    expect(() => calculate("")).toThrow(/empty/);
  });
});

describe("builtinTools", () => {
  it("exposes calculator, current_time, list_dir, read_file", () => {
    expect(builtinTools().definitions().map((d) => d.name).sort()).toEqual([
      "calculator",
      "current_time",
      "list_dir",
      "read_file",
    ]);
  });

  it("reads files within the workspace and refuses traversal", async () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-agent-"));
    writeFileSync(join(root, "note.txt"), "hello from the workspace");
    const tools = builtinTools(root);
    expect(await tools.execute({ id: "1", name: "read_file", arguments: { path: "note.txt" } })).toContain("hello");
    expect(await tools.execute({ id: "2", name: "read_file", arguments: { path: "../../etc/passwd" } })).toContain("escapes the workspace");
  });

  it("runs the calculator tool end to end", async () => {
    const result = await builtinTools().execute({ id: "1", name: "calculator", arguments: { expression: "7 * 6" } });
    expect(result).toBe("42");
  });
});

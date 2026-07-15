import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFileBlocks, parseFileBlocks, runCommand, runVerifiers } from "../src/index";

describe("parseFileBlocks", () => {
  it("extracts file fences and ignores plain code fences", () => {
    const text = [
      "Here is the fix:",
      "```file:src/hello.js",
      'console.log("hi");',
      "```",
      "And a snippet you should not write:",
      "```js",
      "ignored()",
      "```",
      "```file:docs/note.md",
      "# note",
      "```",
    ].join("\n");
    const blocks = parseFileBlocks(text);
    expect(blocks.map((b) => b.path)).toEqual(["src/hello.js", "docs/note.md"]);
    expect(blocks[0].content).toBe('console.log("hi");\n');
  });
});

describe("applyFileBlocks", () => {
  it("writes files inside the workspace, creating directories", () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    const { written } = applyFileBlocks(workspace, [{ path: "a/b/file.txt", content: "content\n" }]);
    expect(written).toEqual([join("a", "b", "file.txt")]);
    expect(readFileSync(join(workspace, "a/b/file.txt"), "utf8")).toBe("content\n");
  });

  it("refuses traversal and absolute paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    expect(() => applyFileBlocks(workspace, [{ path: "../escape.txt", content: "x" }])).toThrowError(/outside/);
    expect(() => applyFileBlocks(workspace, [{ path: "/etc/apollo-nope", content: "x" }])).toThrowError(/outside/);
  });

  it("validates the complete response before writing and rejects duplicate paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    expect(() => applyFileBlocks(workspace, [
      { path: "safe.txt", content: "would be partial" },
      { path: "../escape.txt", content: "x" },
    ])).toThrowError(/outside/);
    expect(existsSync(join(workspace, "safe.txt"))).toBe(false);
    expect(() => applyFileBlocks(workspace, [
      { path: "same.txt", content: "one" },
      { path: "same.txt", content: "two" },
    ])).toThrowError(/duplicate/);
  });
});

describe("runCommand / runVerifiers", () => {
  it("passes on exit code 0 and fails with output tail otherwise", async () => {
    const ok = await runCommand('node -e "process.exit(0)"', { cwd: process.cwd() });
    expect(ok.ok).toBe(true);

    const bad = await runCommand("printf 'boom detail\\n' >&2; exit 3", {
      cwd: process.cwd(),
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe(3);
    expect(bad.outputTail).toContain("boom detail");
  });

  it("stops at the first failing verifier", async () => {
    const { passed, results } = await runVerifiers(
      ['node -e "process.exit(0)"', 'node -e "process.exit(1)"', 'node -e "process.exit(0)"'],
      { cwd: process.cwd() },
    );
    expect(passed).toBe(false);
    expect(results).toHaveLength(2);
  });
});

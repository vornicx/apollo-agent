import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFileBlocks, materializePatchBlocks, parseFileBlocks, parsePatchBlocks, runCommand, runVerifiers } from "../src/index";

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

  it("rolls back every committed file when a later commit fails", () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    writeFileSync(join(workspace, "first.txt"), "before\n");
    mkdirSync(join(workspace, "directory-target"));
    expect(() => applyFileBlocks(workspace, [
      { path: "first.txt", content: "after\n" },
      { path: "directory-target", content: "cannot replace a directory\n" },
    ])).toThrow();
    expect(readFileSync(join(workspace, "first.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(workspace, "directory-target"))).toBe(true);
  });

  it("refuses writes through workspace symlinks", () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "apollo-outside-"));
    symlinkSync(outside, join(workspace, "linked"));
    expect(() => applyFileBlocks(workspace, [{ path: "linked/escape.txt", content: "x" }])).toThrowError(/symbolic link/);
    expect(existsSync(join(outside, "escape.txt"))).toBe(false);
  });
});

describe("exact patch blocks", () => {
  it("parses and materializes sequential unique replacements without mutating", () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-patch-"));
    writeFileSync(join(workspace, "large.js"), "const a = 1;\nconst b = 2;\n");
    const patches = parsePatchBlocks([
      "```patch:large.js", "@@ SEARCH", "const a = 1;", "@@ REPLACE", "const a = 10;", "@@ END", "```",
      "```patch:large.js", "@@ SEARCH", "const b = 2;", "@@ REPLACE", "const b = 20;", "@@ END", "```",
    ].join("\n"));
    const files = materializePatchBlocks(workspace, patches);
    expect(files).toEqual([{ path: "large.js", content: "const a = 10;\nconst b = 20;\n" }]);
    expect(readFileSync(join(workspace, "large.js"), "utf8")).toContain("a = 1");
  });

  it("rejects stale and ambiguous searches", () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-patch-"));
    writeFileSync(join(workspace, "x.txt"), "same\nsame\n");
    expect(() => materializePatchBlocks(workspace, [{ path: "x.txt", search: "missing", replace: "x" }])).toThrowError(/not found/);
    expect(() => materializePatchBlocks(workspace, [{ path: "x.txt", search: "same", replace: "x" }])).toThrowError(/not unique/);
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

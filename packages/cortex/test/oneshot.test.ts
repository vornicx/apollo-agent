import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferOneShotChecks, prepareOneShotContext, shouldTryOneShot } from "../src/index";

describe("one-shot harness context", () => {
  it("runs baseline checks and prioritizes a bounded relevant snapshot", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-oneshot-context-"));
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    writeFileSync(join(workspace, "add.js"), "export const add=(a,b)=>a-b;\n");
    writeFileSync(join(workspace, "add.test.js"), "import {add} from './add.js';\n");
    const context = await prepareOneShotContext(
      workspace,
      "Fix add.js so the test passes",
      [{ type: "command_succeeds", command: "node -e \"process.exit(2)\"" }],
      { maxChars: 10_000 },
    );
    expect(context.files).toContain("add.js");
    expect(context.text).toContain("--- FILE add.js ---");
    expect(context.baseline[0]).toMatchObject({ passed: false });
    expect(context.chars).toBeLessThanOrEqual(12_000);
  });

  it("only attempts one-shot on safe workspace task kinds", () => {
    expect(shouldTryOneShot("debugging", "/tmp/project", "Fix the test")).toBe(true);
    expect(shouldTryOneShot("research", "/tmp/project", "Research it")).toBe(false);
    expect(shouldTryOneShot("summarization", "/tmp/project", "Summarize this")).toBe(false);
    expect(shouldTryOneShot("writing", "/tmp/project", "Write README docs")).toBe(true);
    expect(shouldTryOneShot("code-generation", "/tmp/project", "Deploy to production")).toBe(false);
    expect(shouldTryOneShot("debugging", undefined, "Fix it")).toBe(false);
  });

  it("infers a conventional verifier from project metadata", () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-oneshot-check-"));
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
    expect(inferOneShotChecks(workspace, "Fix the failing behavior")).toEqual([
      { type: "command_succeeds", command: "npm test" },
    ]);
    expect(inferOneShotChecks(workspace, "Fix the TypeScript types")).toEqual([
      { type: "command_succeeds", command: "npm run typecheck" },
    ]);
  });
});

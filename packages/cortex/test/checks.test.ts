import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeCheck, parseCheckSpec, parseCheckSpecs, runChecks, type Check } from "../src/index";

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "apollo-checks-"));
  writeFileSync(join(dir, "hello.txt"), "apollo works");
  return dir;
}

describe("runChecks (deterministic, no model)", () => {
  it("verifies file_exists against ground truth", async () => {
    const dir = ws();
    const [present] = await runChecks([{ type: "file_exists", path: "hello.txt" }], dir);
    const [missing] = await runChecks([{ type: "file_exists", path: "nope.txt" }], dir);
    expect(present.passed).toBe(true);
    expect(missing.passed).toBe(false);
    expect(missing.detail).toBe("missing");
  });

  it("verifies file_contains", async () => {
    const dir = ws();
    const [hit] = await runChecks([{ type: "file_contains", path: "hello.txt", text: "works" }], dir);
    const [miss] = await runChecks([{ type: "file_contains", path: "hello.txt", text: "broken" }], dir);
    const [gone] = await runChecks([{ type: "file_contains", path: "gone.txt", text: "x" }], dir);
    expect(hit.passed).toBe(true);
    expect(miss.passed).toBe(false);
    expect(gone.detail).toBe("file missing");
  });

  it("verifies exact file content", async () => {
    const dir = ws();
    const [hit] = await runChecks([{ type: "file_equals", path: "hello.txt", text: "apollo works" }], dir);
    const [miss] = await runChecks([{ type: "file_equals", path: "hello.txt", text: "works" }], dir);
    expect(hit.passed).toBe(true);
    expect(miss).toMatchObject({ passed: false, detail: "content differs" });
  });

  it("verifies command_succeeds by exit code", async () => {
    const dir = ws();
    const [ok] = await runChecks([{ type: "command_succeeds", command: "test -f hello.txt" }], dir);
    const [bad] = await runChecks([{ type: "command_succeeds", command: "test -f nope.txt" }], dir);
    expect(ok.passed).toBe(true);
    expect(bad.passed).toBe(false);
    expect(bad.detail).toContain("exit 1");
  });

  it("catches the hallucination case: a claimed file that was never written", async () => {
    // the model may claim success; the harness checks reality and disagrees.
    const dir = mkdtempSync(join(tmpdir(), "apollo-checks-"));
    const results = await runChecks(
      [
        { type: "file_exists", path: "result.json" },
        { type: "command_succeeds", command: "node -e \"process.exit(1)\"" },
      ],
      dir,
    );
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it("jails command/file checks to the workspace", async () => {
    const dir = ws();
    const [escape] = await runChecks([{ type: "file_exists", path: "../../etc/passwd" }], dir);
    expect(escape.passed).toBe(false);
    expect(escape.detail).toContain("error");
  });

  it("parses user check specs (and rejects malformed ones)", () => {
    expect(parseCheckSpec("file_exists:out/result.py")).toEqual({ type: "file_exists", path: "out/result.py" });
    expect(parseCheckSpec("file_contains:a.txt:hello world")).toEqual({ type: "file_contains", path: "a.txt", text: "hello world" });
    expect(parseCheckSpec("file_equals:a.txt:exact")).toEqual({ type: "file_equals", path: "a.txt", text: "exact" });
    // command may contain colons
    expect(parseCheckSpec("command_succeeds:node -e \"process.exit(0)\"")).toEqual({ type: "command_succeeds", command: 'node -e "process.exit(0)"' });
    expect(parseCheckSpec("bogus")).toBeNull();
    expect(parseCheckSpec("file_exists:")).toBeNull();
    expect(parseCheckSpec("unknown_type:x")).toBeNull();
  });

  it("parses a ;-separated list of specs, dropping bad ones", () => {
    const checks = parseCheckSpecs("file_exists:a.py ; bogus ; command_succeeds:pytest");
    expect(checks).toEqual([
      { type: "file_exists", path: "a.py" },
      { type: "command_succeeds", command: "pytest" },
    ]);
  });

  it("describes checks readably", () => {
    const checks: Check[] = [
      { type: "file_exists", path: "a.txt" },
      { type: "file_contains", path: "b.txt", text: "hi" },
      { type: "file_equals", path: "c.txt", text: "exact" },
      { type: "command_succeeds", command: "npm test" },
    ];
    expect(checks.map(describeCheck)).toEqual([
      "file exists: a.txt",
      'b.txt contains "hi"',
      'c.txt equals "exact"',
      "command exits 0: npm test",
    ]);
  });
});

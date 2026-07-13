import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolveInWorkspace } from "@archic/apollo-agent";

/**
 * Deterministic, machine-checkable success criteria. The planner emits these
 * alongside prose doneCriteria; the harness verifies them ITSELF against the
 * workspace — no model in the loop — so a model can't hallucinate its way past
 * ground truth. This is the guard that catches "claimed done but nothing was
 * actually written / the test doesn't pass".
 */
export type Check =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_equals"; path: string; text: string }
  | { type: "command_succeeds"; command: string };

export interface CheckResult {
  check: Check;
  passed: boolean;
  detail: string;
}

/**
 * Parse a CLI/user check spec into a Check. Lets a user assert ground-truth
 * success criteria the harness enforces itself, regardless of what the model
 * planned — the guard no longer depends on the model's cooperation. Formats:
 *   file_exists:relative/path
 *   file_contains:relative/path:substring
 *   file_equals:relative/path:exact content
 *   command_succeeds:any shell command (may contain colons)
 */
export function parseCheckSpec(spec: string): Check | null {
  const trimmed = spec.trim();
  const sep = trimmed.indexOf(":");
  if (sep < 0) return null;
  const type = trimmed.slice(0, sep).trim();
  const rest = trimmed.slice(sep + 1);
  if (type === "file_exists") return rest ? { type, path: rest.trim() } : null;
  if (type === "command_succeeds") return rest ? { type, command: rest } : null;
  if (type === "file_contains" || type === "file_equals") {
    const split = rest.indexOf(":");
    if (split < 0) return null;
    const path = rest.slice(0, split).trim();
    const text = rest.slice(split + 1);
    return path && text ? { type, path, text } : null;
  }
  return null;
}

/** Parse a ";"-separated list of check specs, dropping unparseable ones. */
export function parseCheckSpecs(specs: string): Check[] {
  return specs
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCheckSpec)
    .filter((c): c is Check => c !== null);
}

export function describeCheck(check: Check): string {
  switch (check.type) {
    case "file_exists":
      return `file exists: ${check.path}`;
    case "file_contains":
      return `${check.path} contains "${truncate(check.text, 40)}"`;
    case "file_equals":
      return `${check.path} equals "${truncate(check.text, 40)}"`;
    case "command_succeeds":
      return `command exits 0: ${check.command}`;
  }
}

/** Run all checks against the workspace. Deterministic; never trusts the model. */
export async function runChecks(checks: Check[], workspace: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) results.push(await runOne(check, workspace));
  return results;
}

async function runOne(check: Check, workspace: string): Promise<CheckResult> {
  try {
    if (check.type === "file_exists") {
      const ok = existsSync(resolveInWorkspace(workspace, check.path));
      return { check, passed: ok, detail: ok ? "present" : "missing" };
    }
    if (check.type === "file_contains" || check.type === "file_equals") {
      const target = resolveInWorkspace(workspace, check.path);
      if (!existsSync(target)) return { check, passed: false, detail: "file missing" };
      const actual = readFileSync(target, "utf8");
      const ok = check.type === "file_contains" ? actual.includes(check.text) : actual === check.text;
      return { check, passed: ok, detail: ok ? (check.type === "file_contains" ? "found" : "exact match") : (check.type === "file_contains" ? "substring not found" : "content differs") };
    }
    // command_succeeds
    const { code, tail } = await execIn(check.command, workspace);
    return { check, passed: code === 0, detail: `exit ${code}${code === 0 ? "" : ` — ${truncate(tail, 200)}`}` };
  } catch (error) {
    return { check, passed: false, detail: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function execIn(command: string, cwd: string): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd });
    let out = "";
    const append = (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > 8000) out = out.slice(-8000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    timer.unref();
    child.on("error", (e) => resolve({ code: null, tail: e.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, tail: out });
    });
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

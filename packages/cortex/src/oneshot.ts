import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type { TaskKind } from "@archic/apollo-router";
import { describeCheck, runChecks, type Check, type CheckResult } from "./checks";

export interface OneShotContext {
  text: string;
  files: string[];
  treeFiles: number;
  chars: number;
  baseline: CheckResult[];
  truncated: boolean;
}

/** Infer one conventional, deterministic verifier from project metadata. */
export function inferOneShotChecks(workspace: string, goal: string): Check[] {
  const root = resolve(workspace);
  const packagePath = join(root, "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if (/\b(typecheck|types?|typescript)\b/iu.test(goal) && scripts.typecheck) {
        return [{ type: "command_succeeds", command: "npm run typecheck" }];
      }
      if (/\b(build|compil|bundle)\b/iu.test(goal) && scripts.build) {
        return [{ type: "command_succeeds", command: "npm run build" }];
      }
      if (scripts.test && !/no test specified/i.test(scripts.test)) {
        return [{ type: "command_succeeds", command: "npm test" }];
      }
      if (scripts.typecheck) return [{ type: "command_succeeds", command: "npm run typecheck" }];
    } catch {
      // Invalid package metadata is useful model context, but not a safe basis
      // for inventing a shell command.
    }
  }
  if (existsSync(join(root, "Cargo.toml"))) return [{ type: "command_succeeds", command: "cargo test" }];
  if (existsSync(join(root, "go.mod"))) return [{ type: "command_succeeds", command: "go test ./..." }];
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) {
    return [{ type: "command_succeeds", command: "pytest -q" }];
  }
  return [];
}

const SKIP_DIRS = new Set([".git", ".apollo", "node_modules", "target", "dist", "build", "coverage", ".next", ".venv", "venv"]);
const MANIFESTS = new Set([
  "AGENTS.md", "CLAUDE.md", "package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml",
  "go.mod", "requirements.txt", "Makefile", "README.md", "vite.config.ts", "vitest.config.ts",
]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".html", ".java", ".js", ".json", ".jsx",
  ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".svelte", ".toml", ".ts", ".tsx",
  ".txt", ".vue", ".yaml", ".yml",
]);

/** Whether a workspace task is narrow enough to earn a one-shot attempt. */
export function shouldTryOneShot(kind: TaskKind, workspace: string | undefined, goal: string): boolean {
  if (!workspace) return false;
  if (/\b(delete|deletion|borrar|eliminar|drop|deploy|desplieg|release|publish|publica|migrat|security|seguridad)\b/iu.test(goal)) return false;
  if (["debugging", "refactoring", "code-generation"].includes(kind)) return true;
  return kind === "writing" && /\b(readme|docs?|archivo|files?|\.md\b|\.txt\b)\b/iu.test(goal);
}

/**
 * Deterministic pre-inference context engineering. It runs declared checks,
 * ranks likely-relevant files, and spends a bounded context budget. No model
 * call is wasted discovering a tiny workspace one file at a time.
 */
export async function prepareOneShotContext(
  workspace: string,
  goal: string,
  checks: Check[],
  options: { maxChars?: number; maxFiles?: number; perFileChars?: number } = {},
): Promise<OneShotContext> {
  const root = resolve(workspace);
  const maxChars = options.maxChars ?? 60_000;
  const maxFiles = options.maxFiles ?? 28;
  const perFileChars = options.perFileChars ?? 14_000;
  const baseline = checks.length ? await runChecks(checks, root) : [];
  const paths = listTextFiles(root, 500);
  const signal = `${goal}\n${baseline.map((item) => `${describeCheck(item.check)} ${item.detail}`).join("\n")}`;
  const words = new Set((signal.toLowerCase().match(/[a-z0-9_.\/-]{3,}/g) ?? []).flatMap((word) => [word, basename(word)]));
  const checkPaths = new Set(checks.flatMap((check) => "path" in check ? [check.path] : []));

  const ranked = paths
    .map((path) => ({ path, score: scorePath(path, words, checkPaths) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const selected: string[] = [];
  const sections: string[] = [];
  let used = 0;
  let truncated = false;
  for (const item of ranked) {
    if (selected.length >= maxFiles) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = readFileSync(join(root, item.path), "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    const clipped = content.length > perFileChars ? `${content.slice(0, perFileChars)}\n…[file truncated]…\n` : content;
    const section = `\n--- FILE ${item.path} ---\n${clipped}`;
    if (used + section.length > maxChars) {
      truncated = true;
      continue;
    }
    sections.push(section);
    selected.push(item.path);
    used += section.length;
  }

  const tree = paths.slice(0, 300).join("\n");
  const baselineText = baseline.length
    ? baseline.map((item) => `- ${item.passed ? "PASS" : "FAIL"}: ${describeCheck(item.check)} — ${item.detail}`).join("\n")
    : "- No explicit checks were supplied; changed files must still be inspected.";
  const text = `WORKSPACE TREE (${paths.length} text files; capped listing)\n${tree}\n\nBASELINE CHECKS\n${baselineText}\n\nSELECTED FILE CONTENTS${sections.join("")}`;
  return { text, files: selected, treeFiles: paths.length, chars: text.length, baseline, truncated };
}

function listTextFiles(root: string, limit: number): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) break;
      if (entry.name.startsWith(".") && ![".env.example", ".github", ".eslintrc", ".prettierrc"].includes(entry.name)) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isTextCandidate(path)) out.push(relative(root, path));
    }
  };
  walk(root);
  return out;
}

function isTextCandidate(path: string): boolean {
  try {
    if (statSync(path).size > 250_000) return false;
  } catch {
    return false;
  }
  return MANIFESTS.has(basename(path)) || TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function scorePath(path: string, words: Set<string>, checkPaths: Set<string>): number {
  const lower = path.toLowerCase();
  const name = basename(lower);
  let score = 0;
  if (checkPaths.has(path)) score += 200;
  if (MANIFESTS.has(basename(path))) score += 45;
  if (/\b(test|spec)\b|\.(test|spec)\./i.test(path)) score += 24;
  if (/\.(ts|tsx|js|jsx|py|rs|go|java)$/.test(lower)) score += 8;
  for (const word of words) {
    if (lower === word || name === word) score += 160;
    else if (lower.includes(word) || word.includes(name)) score += 18;
  }
  return score;
}

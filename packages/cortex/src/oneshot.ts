import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { TaskKind } from "@archic/apollo-router";
import { describeCheck, runChecks, type Check, type CheckResult } from "./checks";

export interface OneShotContext {
  text: string;
  files: string[];
  treeFiles: number;
  chars: number;
  baseline: CheckResult[];
  truncated: boolean;
  reusedFiles: number;
  refreshedFiles: number;
  largestFileChars: number;
  fingerprint: string;
}

export interface OneShotAssessment {
  eligible: boolean;
  score: number;
  mode: "full" | "patch";
  reason: string;
}

interface SnapshotCacheFile {
  mtimeNs: string;
  size: number;
  hash: string;
  content: string;
  usedAt: number;
}

interface SnapshotCache {
  version: 2;
  workspace: string;
  files: Record<string, SnapshotCacheFile>;
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
  options: { maxChars?: number; maxFiles?: number; perFileChars?: number; cacheDir?: string } = {},
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
  const cachePath = options.cacheDir ? snapshotCachePath(options.cacheDir, root) : undefined;
  const cache = cachePath ? readSnapshotCache(cachePath, root) : undefined;

  const ranked = paths
    .map((path) => ({ path, score: scorePath(path, words, checkPaths) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const selected: string[] = [];
  const sections: string[] = [];
  let used = 0;
  let truncated = false;
  let reusedFiles = 0;
  let refreshedFiles = 0;
  let largestFileChars = 0;
  const currentPaths = new Set(paths);
  const nextCache: SnapshotCache = {
    version: 2,
    workspace: root,
    files: Object.fromEntries(Object.entries(cache?.files ?? {}).filter(([path]) => currentPaths.has(path))),
  };
  for (const item of ranked) {
    if (selected.length >= maxFiles) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      const absolute = join(root, item.path);
      const stat = statSync(absolute, { bigint: true });
      const cached = cache?.files[item.path];
      if (cached && cached.mtimeNs === stat.mtimeNs.toString() && cached.size === Number(stat.size)) {
        content = cached.content;
        reusedFiles += 1;
      } else {
        content = readFileSync(absolute, "utf8");
        refreshedFiles += 1;
      }
      const hash = cached && cached.mtimeNs === stat.mtimeNs.toString() && cached.size === Number(stat.size)
        ? cached.hash
        : createHash("sha256").update(content).digest("hex").slice(0, 16);
      nextCache.files[item.path] = { mtimeNs: stat.mtimeNs.toString(), size: Number(stat.size), hash, content, usedAt: Date.now() };
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    largestFileChars = Math.max(largestFileChars, content.length);
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
  const fingerprint = createHash("sha256")
    .update(selected.map((path) => {
      const item = nextCache.files[path];
      return `${path}:${item?.hash ?? "missing"}`;
    }).join("\n"))
    .digest("hex")
    .slice(0, 16);
  if (cachePath) writeSnapshotCache(cachePath, nextCache);
  return {
    text,
    files: selected,
    treeFiles: paths.length,
    chars: text.length,
    baseline,
    truncated,
    reusedFiles,
    refreshedFiles,
    largestFileChars,
    fingerprint,
  };
}

/** Score observable context signals before spending the one-shot completion. */
export function assessOneShot(context: OneShotContext, goal: string): OneShotAssessment {
  let score = 0.72;
  const reasons: string[] = [];
  const explicitPath = /(?:^|\s)[\w./-]+\.[a-z0-9]{1,8}(?:\s|$|[,;:])/iu.test(goal);
  if (explicitPath) { score += 0.14; reasons.push("explicit file target"); }
  if (context.baseline.some((item) => !item.passed)) { score += 0.05; reasons.push("failing baseline captured"); }
  if (context.files.length === 0) {
    score -= explicitPath ? 0.05 : 0.5;
    reasons.push(explicitPath ? "explicit new-file target" : "no source context");
  }
  if (context.treeFiles > 300) { score -= 0.12; reasons.push("large workspace"); }
  if (context.files.length > 20) { score -= 0.08; reasons.push("broad selected context"); }
  if (context.truncated) { score -= explicitPath ? 0.08 : 0.24; reasons.push("context truncated"); }
  if (goal.length > 1_200) { score -= 0.2; reasons.push("long-horizon request"); }
  score = Math.max(0, Math.min(1, score));
  const mode = context.largestFileChars > 12_000 || context.chars > 36_000 ? "patch" : "full";
  reasons.push(mode === "patch" ? "large edit surface favors exact patches" : "bounded edit surface favors complete files");
  return { eligible: score >= 0.5, score: Math.round(score * 100) / 100, mode, reason: reasons.join("; ") };
}

function snapshotCachePath(cacheDir: string, workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  return join(resolve(cacheDir), `${key}.json`);
}

function readSnapshotCache(path: string, workspace: string): SnapshotCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SnapshotCache;
    return parsed.version === 2 && parsed.workspace === workspace ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeSnapshotCache(path: string, cache: SnapshotCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entries = Object.entries(cache.files)
      .sort((a, b) => b[1].usedAt - a[1].usedAt)
      .slice(0, 120);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ ...cache, files: Object.fromEntries(entries) })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Context caching is an optimization. Read-only state must never block a
    // mission or weaken its verification contract.
  }
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

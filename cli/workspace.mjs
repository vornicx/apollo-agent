import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  APOLLO_CONFIG,
  APOLLO_DIR,
  APOLLO_IGNORE,
  APOLLO_PROJECT_DOC,
  DEFAULT_CONFIG,
  DEFAULT_IGNORE,
} from "./constants.mjs";

export function getWorkspace(cwd = process.cwd()) {
  return resolve(cwd);
}

export function ensureApolloProject(workspace) {
  mkdirSync(join(workspace, APOLLO_DIR, "events"), { recursive: true });
  mkdirSync(join(workspace, APOLLO_DIR, "checkpoints"), { recursive: true });
  mkdirSync(join(workspace, APOLLO_DIR, "runs"), { recursive: true });

  const configPath = join(workspace, APOLLO_DIR, APOLLO_CONFIG);
  if (!existsSync(configPath)) {
    writeJson(configPath, DEFAULT_CONFIG);
  }

  const ignorePath = join(workspace, APOLLO_IGNORE);
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, `${DEFAULT_IGNORE.join("\n")}\n`, "utf8");
  }

  const projectDocPath = join(workspace, APOLLO_PROJECT_DOC);
  if (!existsSync(projectDocPath)) {
    writeFileSync(
      projectDocPath,
      [
        "# Apollo Project Memory",
        "",
        "This file guides Apollo local missions for this workspace.",
        "",
        "## Mission Preferences",
        "",
        "- Prefer precise, auditable changes.",
        "- Create checkpoints before modifying files.",
        "- Do not overwrite manual edits.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

export function readConfig(workspace) {
  const configPath = join(workspace, APOLLO_DIR, APOLLO_CONFIG);
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath, "utf8")) };
}

export function writeConfig(workspace, config) {
  writeJson(join(workspace, APOLLO_DIR, APOLLO_CONFIG), config);
}

export function readProjectDoc(workspace) {
  const file = join(workspace, APOLLO_PROJECT_DOC);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function readIgnorePatterns(workspace) {
  const ignorePath = join(workspace, APOLLO_IGNORE);
  const local = existsSync(ignorePath)
    ? readFileSync(ignorePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [];
  return [...DEFAULT_IGNORE, ...local];
}

export function assertInsideWorkspace(workspace, filePath) {
  const absolute = resolve(workspace, filePath);
  const rel = relative(workspace, absolute);
  if (rel.startsWith("..") || rel === "" || rel.includes(`..${sep}`)) {
    throw new Error(`Refusing to access outside workspace: ${filePath}`);
  }
  return { absolute, rel: toPosix(rel) };
}

export function isDeniedPath(workspace, filePath) {
  const { rel } = assertInsideWorkspace(workspace, filePath);
  const normalized = toPosix(rel).toLowerCase();
  const patterns = readIgnorePatterns(workspace);
  return patterns.some((pattern) => matchesPattern(normalized, pattern.toLowerCase()));
}

export function hashContent(content) {
  return createHash("sha256")
    .update(content ?? "")
    .digest("hex");
}

export function hashFile(file) {
  if (!existsSync(file)) return null;
  return hashContent(readFileSync(file));
}

export function readTextIfExists(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function writeText(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

export function listWorkspaceFiles(workspace, limit = 80) {
  const out = [];
  walk(workspace, "");
  return out.slice(0, limit);

  function walk(root, relDir) {
    if (out.length >= limit) return;
    const dir = join(root, relDir);
    for (const entry of readdirSync(dir)) {
      if (out.length >= limit) return;
      const rel = toPosix(join(relDir, entry));
      if (isDeniedPath(workspace, rel)) continue;
      const absolute = join(workspace, rel);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(workspace, rel);
      } else if (stats.isFile()) {
        out.push(rel);
      }
    }
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

function matchesPattern(file, pattern) {
  const clean = pattern.replace(/\\/g, "/");
  if (clean.endsWith("/")) return file === clean.slice(0, -1) || file.startsWith(clean);
  if (clean.includes("*")) {
    const escaped = clean
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(file) || new RegExp(escaped).test(basename(file));
  }
  return file === clean || file.startsWith(`${clean}/`) || basename(file) === clean;
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

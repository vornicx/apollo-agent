import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ToolRegistry } from "./registry";

export interface WorkspaceOptions {
  /** Enable run_command. Default true. */
  shell?: boolean;
  /** run_command timeout, ms. Default 120_000. */
  shellTimeoutMs?: number;
  /** Max chars returned from any tool. Default 20_000. */
  maxChars?: number;
}

/** Resolve a path and refuse anything that escapes the workspace root. */
export function resolveInWorkspace(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || (rel.startsWith(sep) && !target.startsWith(root))) {
    throw new Error(`path escapes the workspace: ${path}`);
  }
  if (resolve(root, rel) !== target) throw new Error(`path escapes the workspace: ${path}`);
  return target;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.8);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[truncated ${text.length - max} chars]…\n${text.slice(-tail)}`;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { shell: true, cwd });
    let out = "";
    const append = (b: Buffer) => {
      out += b.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref();
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise(`TOOL_ERROR: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(`exit ${code}\n${out}`);
    });
  });
}

/**
 * File and shell tools jailed to a workspace root — what lets the agentic loop
 * and the cognitive cycle do real work (write code, run its tests) rather than
 * only read. Write and shell tools are marked destructive so the confirm policy
 * gates them. Read tools compose with the read-only built-ins.
 */
export function workspaceTools(root: string, options: WorkspaceOptions = {}): ToolRegistry {
  const rootAbs = resolve(root);
  mkdirSync(rootAbs, { recursive: true });
  const shell = options.shell !== false;
  const shellTimeout = options.shellTimeoutMs ?? 120_000;
  const max = options.maxChars ?? 20_000;
  const reg = new ToolRegistry();

  reg.define(
    "read_file",
    "Read a UTF-8 text file within the workspace, with line numbers.",
    { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    (a) => {
      const text = readFileSync(resolveInWorkspace(rootAbs, String(a.path)), "utf8");
      const numbered = text.split("\n").map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");
      return truncate(numbered, max);
    },
  );

  reg.define(
    "list_dir",
    "List entries of a directory within the workspace.",
    { type: "object", properties: { path: { type: "string" } } },
    (a) => {
      const dir = resolveInWorkspace(rootAbs, String(a.path ?? "."));
      return (
        readdirSync(dir, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n") || "(empty)"
      );
    },
  );

  reg.define(
    "find_files",
    "Recursively list files under a directory (skips node_modules/.git).",
    { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } },
    (a) => {
      const start = resolveInWorkspace(rootAbs, String(a.path ?? "."));
      const limit = Number(a.limit ?? 200);
      const found: string[] = [];
      const walk = (d: string) => {
        if (found.length >= limit) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else found.push(relative(rootAbs, p));
          if (found.length >= limit) return;
        }
      };
      walk(start);
      return found.join("\n") || "(no files)";
    },
  );

  reg.define(
    "grep",
    "Search files under a directory for a substring; returns path:line matches.",
    { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "number" } }, required: ["pattern"] },
    (a) => {
      const pattern = String(a.pattern);
      const start = resolveInWorkspace(rootAbs, String(a.path ?? "."));
      const limit = Number(a.limit ?? 100);
      const hits: string[] = [];
      const walk = (d: string) => {
        if (hits.length >= limit) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          const p = join(d, e.name);
          if (e.isDirectory()) {
            walk(p);
            continue;
          }
          let text: string;
          try {
            text = readFileSync(p, "utf8");
          } catch {
            continue;
          }
          text.split("\n").forEach((line, i) => {
            if (hits.length < limit && line.includes(pattern)) hits.push(`${relative(rootAbs, p)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
      };
      walk(start);
      return hits.join("\n") || "(no matches)";
    },
  );

  reg.register({
    definition: {
      name: "write_file",
      description: "Create or overwrite a text file within the workspace (creates parent directories).",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
    destructive: true,
    risk: "write",
    handler: (a) => {
      const target = resolveInWorkspace(rootAbs, String(a.path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, String(a.content ?? ""));
      return `wrote ${relative(rootAbs, target)} (${String(a.content ?? "").length} bytes)`;
    },
  });

  reg.register({
    definition: {
      name: "edit_file",
      description: "Replace an exact unique string in a workspace file. `old` must occur exactly once.",
      parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] },
    },
    destructive: true,
    risk: "write",
    handler: (a) => {
      const target = resolveInWorkspace(rootAbs, String(a.path));
      const text = readFileSync(target, "utf8");
      const old = String(a.old);
      const count = text.split(old).length - 1;
      if (count === 0) return `TOOL_ERROR: 'old' string not found in ${relative(rootAbs, target)}`;
      if (count > 1) return `TOOL_ERROR: 'old' string is not unique (${count} occurrences); include more context`;
      writeFileSync(target, text.replace(old, String(a.new ?? "")));
      return `edited ${relative(rootAbs, target)}`;
    },
  });

  if (shell) {
    reg.register({
      definition: {
        name: "run_command",
        description: "Run a non-interactive shell command in the workspace and return its exit code and output.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      destructive: true,
      risk: "shell",
      handler: async (a) => truncate(await runCommand(String(a.command), rootAbs, shellTimeout), max),
    });
  }

  return reg;
}

/** True when the path exists inside the workspace (used by verifiers). */
export function existsInWorkspace(root: string, path: string): boolean {
  try {
    return existsSync(resolveInWorkspace(resolve(root), path)) && statSync(resolveInWorkspace(resolve(root), path)) != null;
  } catch {
    return false;
  }
}

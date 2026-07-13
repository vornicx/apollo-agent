import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { ToolRegistry } from "./registry";

/** Evaluate a plain arithmetic expression (+ - * / % ** and parens) safely. */
export function calculate(expression: string): number {
  if (!/^[\d\s.+\-*/%()]*$/.test(expression)) throw new Error("only numbers and + - * / % ( ) are allowed");
  if (!expression.trim()) throw new Error("empty expression");
  // eslint-disable-next-line no-new-func -- input is restricted to the charset above
  const value = Function(`"use strict"; return (${expression});`)() as unknown;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expression did not evaluate to a finite number");
  return value;
}

function jail(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.startsWith(sep) || (rel === "" && path !== ".")) {
    throw new Error(`path escapes the workspace: ${path}`);
  }
  return target;
}

/**
 * A small set of read-only, side-effect-free tools an agent can use out of the
 * box. File tools are path-jailed to `root` — the agent cannot read outside it.
 */
export function builtinTools(root: string = process.cwd()): ToolRegistry {
  return new ToolRegistry()
    .define(
      "calculator",
      "Evaluate an arithmetic expression and return the numeric result.",
      { type: "object", properties: { expression: { type: "string", description: "e.g. (2 + 3) * 4" } }, required: ["expression"] },
      (args) => String(calculate(String(args.expression ?? ""))),
    )
    .define(
      "current_time",
      "Return the current date and time in ISO 8601.",
      { type: "object", properties: {} },
      () => new Date().toISOString(),
    )
    .define(
      "list_dir",
      "List the entries of a directory within the workspace.",
      { type: "object", properties: { path: { type: "string", description: "relative path; defaults to ." } } },
      (args) => {
        const dir = jail(root, String(args.path ?? "."));
        return readdirSync(dir, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n") || "(empty)";
      },
    )
    .define(
      "read_file",
      "Read a UTF-8 text file within the workspace (first 8000 chars).",
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      (args) => {
        const file = jail(root, String(args.path ?? ""));
        return readFileSync(file, "utf8").slice(0, 8000);
      },
    );
}

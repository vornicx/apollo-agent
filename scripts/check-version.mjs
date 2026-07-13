import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const mismatches = [];
for (const name of readdirSync(join(root, "packages"))) {
  const path = join(root, "packages", name, "package.json");
  try {
    const version = JSON.parse(readFileSync(path, "utf8")).version;
    if (version !== expected) mismatches.push(`${path}: ${version}`);
  } catch { /* package has no manifest */ }
}
const cargo = readFileSync(join(root, "packages/desktop/src-tauri/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1];
const tauri = JSON.parse(readFileSync(join(root, "packages/desktop/src-tauri/tauri.conf.json"), "utf8")).version;
if (cargo !== expected) mismatches.push(`Cargo.toml: ${cargo}`);
if (tauri !== expected) mismatches.push(`tauri.conf.json: ${tauri}`);
if (mismatches.length) throw new Error(`Apollo versions must match ${expected}:\n${mismatches.join("\n")}`);
console.log(`Apollo versions aligned at ${expected}`);

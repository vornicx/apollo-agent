import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../../..");
const runtimeDir = join(root, "packages/desktop/runtime");
const outfile = join(runtimeDir, "apollo-runtime.cjs");
mkdirSync(runtimeDir, { recursive: true });

await build({
  entryPoints: [join(root, "packages/cli/src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  tsconfig: join(root, "tsconfig.json"),
});

const nodeTarget = join(runtimeDir, process.platform === "win32" ? "node.exe" : "node");
copyFileSync(process.execPath, nodeTarget);
if (process.platform !== "win32") chmodSync(nodeTarget, 0o755);
writeFileSync(join(runtimeDir, "runtime.json"), `${JSON.stringify({
  schemaVersion: 1,
  version: "0.2.0-alpha.1",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
}, null, 2)}\n`);

console.log(`staged autonomous runtime at ${runtimeDir}`);

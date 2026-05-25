#!/usr/bin/env node

// Suppress Node.js ExperimentalWarning (node:sqlite, etc.) before any module loads
const _emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === "warning" && data?.name === "ExperimentalWarning") return false;
  return Reflect.apply(_emit, this, [name, data, ...rest]);
};

const { main } = await import("../cli/main.mjs");

main(process.argv.slice(2)).catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\x1b[31m✗ Apollo failed:\x1b[0m ${msg}\n`);
  process.exitCode = 1;
});

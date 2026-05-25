#!/usr/bin/env node

import { main } from "../cli/main.mjs";

main(process.argv.slice(2)).catch((error) => {
  console.error(`Apollo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

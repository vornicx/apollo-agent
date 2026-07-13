#!/usr/bin/env node
// Global `apollo` entry (npm link / npm i -g): registers tsx so the TypeScript
// sources run on the fly from anywhere, with the user's cwd left untouched —
// workspace jails and config discovery see the directory you ran it from.
import { register } from "tsx/esm/api";

register();
await import("../packages/cli/src/index.ts");

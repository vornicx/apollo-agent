import { join } from "node:path";
import { APOLLO_DIR } from "./constants.mjs";
import { appendJsonl } from "./workspace.mjs";
import { insertEvent } from "./db.mjs";

export function recordEvent(db, workspace, missionId, event) {
  const row = insertEvent(db, missionId, event);
  if (missionId) {
    appendJsonl(join(workspace, APOLLO_DIR, "events", `${missionId}.jsonl`), row);
  }
  return row;
}

export function printProgress(progress, message) {
  const pct = String(Math.max(0, Math.min(100, progress))).padStart(3, " ");
  console.log(`[${pct}%] ${message}`);
}

export function recordProgress(db, workspace, missionId, progress, message, metadata = {}) {
  recordEvent(db, workspace, missionId, {
    type: "progress",
    message,
    progress,
    metadata,
  });
  printProgress(progress, message);
}

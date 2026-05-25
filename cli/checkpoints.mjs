import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newId, nowIso, updateMission } from "./db.mjs";
import {
  assertInsideWorkspace,
  hashContent,
  hashFile,
  isDeniedPath,
  readTextIfExists,
  writeText,
} from "./workspace.mjs";

export function createCheckpoint(db, workspace, missionId, patches, label = "before apply") {
  const checkpointId = newId("chk");
  db.prepare("INSERT INTO checkpoints (id, mission_id, label, created_at) VALUES (?, ?, ?, ?)").run(
    checkpointId,
    missionId,
    label,
    nowIso(),
  );

  for (const patch of patches) {
    const { absolute, rel } = assertInsideWorkspace(workspace, patch.path);
    const beforeContent = readTextIfExists(absolute);
    db.prepare(
      `
      INSERT INTO file_snapshots (
        id, checkpoint_id, mission_id, path, before_hash, after_hash,
        before_content, after_content, existed_before
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      newId("snap"),
      checkpointId,
      missionId,
      rel,
      beforeContent === null ? null : hashContent(beforeContent),
      hashContent(patch.content),
      beforeContent,
      patch.content,
      beforeContent === null ? 0 : 1,
    );
  }
  return checkpointId;
}

export function applyPatches(db, workspace, missionId, mode) {
  const patches = db
    .prepare("SELECT id, path, content FROM patches WHERE mission_id = ? AND applied = 0")
    .all(missionId);
  if (patches.length === 0) return { applied: 0, blocked: [] };

  const blocked = [];
  const safePatches = [];
  for (const patch of patches) {
    if (isDeniedPath(workspace, patch.path)) {
      blocked.push({ ...patch, reason: "path denied by .apolloignore/default denylist" });
    } else {
      safePatches.push(patch);
    }
  }

  for (const item of blocked) {
    db.prepare("UPDATE patches SET blocked_reason = ? WHERE id = ?").run(item.reason, item.id);
  }

  if (mode === "review" || mode === "plan") {
    return { applied: 0, blocked };
  }

  if (safePatches.length === 0) return { applied: 0, blocked };

  createCheckpoint(db, workspace, missionId, safePatches);

  for (const patch of safePatches) {
    const { absolute } = assertInsideWorkspace(workspace, patch.path);
    writeText(absolute, patch.content);
    db.prepare("UPDATE patches SET applied = 1 WHERE id = ?").run(patch.id);
  }

  return { applied: safePatches.length, blocked };
}

export function rollbackMission(db, workspace, missionId) {
  const snapshots = db
    .prepare(
      `
      SELECT fs.*
      FROM file_snapshots fs
      JOIN checkpoints c ON c.id = fs.checkpoint_id
      WHERE fs.mission_id = ?
      ORDER BY c.created_at DESC
    `,
    )
    .all(missionId);

  if (snapshots.length === 0) {
    throw new Error(`No checkpoint found for mission ${missionId}`);
  }

  const latestByPath = new Map();
  for (const snapshot of snapshots) {
    if (!latestByPath.has(snapshot.path)) latestByPath.set(snapshot.path, snapshot);
  }

  const conflicts = [];
  for (const snapshot of latestByPath.values()) {
    const { absolute } = assertInsideWorkspace(workspace, snapshot.path);
    const currentHash = hashFile(absolute);
    if (currentHash !== snapshot.after_hash) {
      conflicts.push(snapshot.path);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Rollback blocked because files changed after Apollo touched them: ${conflicts.join(", ")}`,
    );
  }

  for (const snapshot of latestByPath.values()) {
    const { absolute } = assertInsideWorkspace(workspace, snapshot.path);
    if (snapshot.existed_before) {
      writeText(absolute, snapshot.before_content ?? "");
    } else if (existsSync(absolute)) {
      rmSync(absolute);
    }
  }

  updateMission(db, missionId, { status: "rolled_back" });
  return { restored: latestByPath.size };
}

export function getMissionDiff(db, workspace, missionId) {
  const patches = db
    .prepare("SELECT path, content, applied, blocked_reason FROM patches WHERE mission_id = ?")
    .all(missionId);
  return patches.map((patch) => {
    const { absolute, rel } = assertInsideWorkspace(workspace, patch.path);
    return {
      path: rel,
      before: readTextIfExists(absolute) ?? "",
      after: patch.content,
      applied: Boolean(patch.applied),
      blockedReason: patch.blocked_reason,
    };
  });
}

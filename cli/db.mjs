import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APOLLO_DB, APOLLO_DIR } from "./constants.mjs";

export function openApolloDb(workspace) {
  const dbPath = join(workspace, APOLLO_DIR, APOLLO_DB);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      complexity TEXT NOT NULL DEFAULT 'standard',
      route TEXT NOT NULL DEFAULT 'manual',
      risk TEXT NOT NULL DEFAULT 'medium',
      confidence REAL NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mission_steps (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      step_type TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      input TEXT,
      output TEXT,
      confidence REAL,
      review_score REAL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
      level TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_snapshots (
      id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      before_hash TEXT,
      after_hash TEXT,
      before_content TEXT,
      after_content TEXT,
      existed_before INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS patches (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS costs (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_estimated INTEGER NOT NULL DEFAULT 0,
      tokens_actual INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      actual_cost REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      kind TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_runs (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      step_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      confidence REAL,
      review_score REAL,
      output TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function insertEvent(db, missionId, event) {
  const row = {
    id: newId("evt"),
    mission_id: missionId ?? null,
    level: event.level ?? "info",
    type: event.type,
    message: event.message,
    progress: event.progress ?? 0,
    metadata: JSON.stringify(event.metadata ?? {}),
    created_at: nowIso(),
  };
  db.prepare(
    `
    INSERT INTO events (id, mission_id, level, type, message, progress, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    row.id,
    row.mission_id,
    row.level,
    row.type,
    row.message,
    row.progress,
    row.metadata,
    row.created_at,
  );
  return row;
}

export function updateMission(db, missionId, patch) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  const values = keys.map((key) => patch[key]);
  db.prepare(`UPDATE missions SET ${assignments}, updated_at = ? WHERE id = ?`).run(
    ...values,
    nowIso(),
    missionId,
  );
}

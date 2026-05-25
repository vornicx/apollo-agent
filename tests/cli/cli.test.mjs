import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openApolloDb, newId, nowIso } from "../../cli/db.mjs";
import { createCheckpoint, rollbackMission } from "../../cli/checkpoints.mjs";
import { classifyCommand } from "../../cli/commands.mjs";

const bin = join(import.meta.dirname, "..", "..", "bin", "apollo.mjs");

test("apollo init creates local project files", () => {
  const cwd = tempWorkspace();
  const result = run(cwd, ["init"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialized/);
  assert.equal(
    readFileSync(join(cwd, "APOLLO.md"), "utf8").includes("Apollo Project Memory"),
    true,
  );
  assert.equal(readFileSync(join(cwd, ".apolloignore"), "utf8").includes(".env"), true);
});

test("apollo run --mode plan records a mission without modifying workspace files", () => {
  const cwd = tempWorkspace();
  writeFileSync(join(cwd, "README.md"), "hello\n", "utf8");
  assert.equal(run(cwd, ["init"]).status, 0);
  const result = run(cwd, ["run", "summarize repo", "--mode", "plan"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No files were modified/);
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "hello\n");
  const status = run(cwd, ["status"]);
  assert.match(status.stdout, /completed/);
});

test("apollo without args opens the interactive shell", () => {
  const cwd = tempWorkspace();
  const result = spawnSync(process.execPath, [bin], {
    cwd,
    input: "exit\n",
    encoding: "utf8",
    env: { ...process.env, OPENROUTER_API_KEY: "", GROQ_API_KEY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /APOLLO CLI/);
  assert.match(result.stdout, /apollo>/);
});

test("checkpoint rollback restores touched files", () => {
  const cwd = tempWorkspace();
  writeFileSync(join(cwd, "file.txt"), "before\n", "utf8");
  const db = openApolloDb(cwd);
  const missionId = newId("mis");
  db.prepare(
    "INSERT INTO missions (id, goal, status, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(missionId, "change file", "running", "auto", nowIso(), nowIso());
  createCheckpoint(db, cwd, missionId, [{ path: "file.txt", content: "after\n" }]);
  writeFileSync(join(cwd, "file.txt"), "after\n", "utf8");
  const result = rollbackMission(db, cwd, missionId);
  assert.equal(result.restored, 1);
  assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "before\n");
});

test("rollback blocks when user changed file after Apollo", () => {
  const cwd = tempWorkspace();
  writeFileSync(join(cwd, "file.txt"), "before\n", "utf8");
  const db = openApolloDb(cwd);
  const missionId = newId("mis");
  db.prepare(
    "INSERT INTO missions (id, goal, status, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(missionId, "change file", "running", "auto", nowIso(), nowIso());
  createCheckpoint(db, cwd, missionId, [{ path: "file.txt", content: "after\n" }]);
  writeFileSync(join(cwd, "file.txt"), "manual edit\n", "utf8");
  assert.throws(() => rollbackMission(db, cwd, missionId), /Rollback blocked/);
});

test("command classifier blocks dangerous commands", () => {
  assert.equal(classifyCommand("git status --short"), "safe");
  assert.equal(classifyCommand("npm install left-pad"), "network");
  assert.equal(classifyCommand("rm -rf src"), "destructive");
});

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "apollo-cli-"));
}

function run(cwd, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENROUTER_API_KEY: "", GROQ_API_KEY: "" },
  });
}

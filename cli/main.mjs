import { existsSync } from "node:fs";
import { join } from "node:path";
import { APOLLO_DIR, DEFAULT_CONFIG, VALID_MODES } from "./constants.mjs";
import { openApolloDb, newId, nowIso, updateMission } from "./db.mjs";
import {
  ensureApolloProject,
  getWorkspace,
  listWorkspaceFiles,
  readConfig,
  readProjectDoc,
  writeConfig,
} from "./workspace.mjs";
import { estimateCost, estimateMissionSemantic } from "./routing.mjs";
import { recordEvent, recordProgress } from "./events.mjs";
import { checkKeys } from "./providers.mjs";
import { applyPatches, getMissionDiff, rollbackMission } from "./checkpoints.mjs";
import { unifiedDiff } from "./diff.mjs";
import {
  implementerAgent,
  makeStaticPlan,
  plannerAgent,
  reflection,
  reviewerAgent,
} from "./agents.mjs";
import { runAllowedCommand } from "./commands.mjs";

export async function main(argv) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "init") return initCommand();
  if (command === "doctor") return doctorCommand();
  if (command === "keys" && argv[1] === "check") return keysCheckCommand();
  if (command === "status") return statusCommand();
  if (command === "run") return runCommand(argv.slice(1));
  if (command === "diff") return diffCommand(argv[1]);
  if (command === "rollback") return rollbackCommand(argv[1]);
  if (command === "resume") return resumeCommand(argv[1]);
  if (command === "config") return configCommand(argv.slice(1));
  throw new Error(`Unknown command: ${command}. Run "apollo help".`);
}

function initCommand() {
  const workspace = getWorkspace();
  ensureApolloProject(workspace);
  openApolloDb(workspace).close();
  console.log("Apollo local project initialized.");
  console.log(`- ${APOLLO_DIR}/apollo.db`);
  console.log("- APOLLO.md");
  console.log("- .apolloignore");
}

function doctorCommand() {
  const workspace = getWorkspace();
  const hasProject = existsSync(join(workspace, APOLLO_DIR, "apollo.db"));
  const sqliteOk = checkSqlite();
  console.log("Apollo doctor");
  console.log(`- Node: ${process.version}`);
  console.log(`- SQLite: ${sqliteOk ? "ok" : "missing"}`);
  console.log(`- Project initialized: ${hasProject ? "yes" : "no"}`);
  console.log(`- APOLLO.md: ${existsSync(join(workspace, "APOLLO.md")) ? "yes" : "no"}`);
  console.log(`- .apolloignore: ${existsSync(join(workspace, ".apolloignore")) ? "yes" : "no"}`);
  for (const key of checkKeys()) {
    console.log(`- ${key.env}: ${key.present ? "present" : "missing"}`);
  }
  if (!sqliteOk) process.exitCode = 1;
}

function keysCheckCommand() {
  for (const key of checkKeys()) {
    console.log(`${key.present ? "OK " : "MISS"} ${key.env} (${key.provider})`);
  }
}

function statusCommand() {
  const { db } = openExisting();
  const rows = db
    .prepare(
      "SELECT id, status, mode, complexity, route, goal, created_at FROM missions ORDER BY created_at DESC LIMIT 20",
    )
    .all();
  if (rows.length === 0) {
    console.log("No Apollo missions yet.");
    return;
  }
  for (const row of rows) {
    console.log(`${row.id}  ${row.status.padEnd(11)} ${row.mode.padEnd(9)} ${row.goal}`);
  }
}

async function runCommand(args) {
  const parsed = parseRunArgs(args);
  const workspace = getWorkspace();
  ensureApolloProject(workspace);
  const db = openApolloDb(workspace);
  const config = readConfig(workspace);
  const mode = parsed.mode ?? config.defaultMode ?? DEFAULT_CONFIG.defaultMode;
  if (!VALID_MODES.has(mode)) throw new Error(`Invalid mode: ${mode}`);

  const missionId = newId("mis");
  const createdAt = nowIso();
  db.prepare(
    `
    INSERT INTO missions (
      id, goal, status, mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(missionId, parsed.goal, "created", mode, createdAt, createdAt);

  try {
    await executeMission({ db, workspace, config, missionId, goal: parsed.goal, mode });
  } catch (error) {
    updateMission(db, missionId, { status: "failed" });
    recordEvent(db, workspace, missionId, {
      level: "error",
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
      progress: 100,
    });
    throw error;
  } finally {
    db.close();
  }
}

async function executeMission({ db, workspace, config, missionId, goal, mode }) {
  recordProgress(db, workspace, missionId, 5, "Classifying mission...");
  const estimate = await estimateMissionSemantic(goal, process.env.GROQ_API_KEY);
  const cost = estimateCost(goal, estimate, config.model);
  updateMission(db, missionId, {
    status: "planning",
    complexity: estimate.complexity,
    route: estimate.route,
    risk: estimate.risk,
    confidence: estimate.confidence,
    estimated_cost: cost.estimatedCost,
  });
  db.prepare(
    `
    INSERT INTO costs (
      id, mission_id, provider, model, tokens_estimated, estimated_cost, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    newId("cost"),
    missionId,
    config.provider,
    config.model,
    cost.tokens,
    cost.estimatedCost,
    nowIso(),
  );

  console.log(`Mission: ${missionId}`);
  console.log(`Mode: ${mode}`);
  console.log(`Route: ${estimate.route}`);
  console.log(`Estimated cost: $${cost.estimatedCost}`);

  const files = listWorkspaceFiles(workspace);
  const projectDoc = readProjectDoc(workspace);

  recordProgress(db, workspace, missionId, 25, "Planning mission...");
  let plan;
  if (mode === "plan" || !process.env.OPENROUTER_API_KEY) {
    plan = makeStaticPlan({ goal, estimate, files });
    if (mode !== "plan") {
      recordEvent(db, workspace, missionId, {
        level: "warn",
        type: "provider_missing",
        message: "OPENROUTER_API_KEY missing. Apollo produced a local plan only.",
        progress: 25,
      });
    }
  } else {
    const planner = await plannerAgent({
      goal,
      estimate,
      files,
      projectDoc,
      provider: config.provider,
      model: config.model,
    });
    plan = planner.content;
    saveModelRun(db, missionId, "planner", config, planner);
  }
  saveStep(db, missionId, "planner", "completed", config.model, goal, plan, estimate.confidence);

  if (mode === "plan" || !process.env.OPENROUTER_API_KEY) {
    updateMission(db, missionId, { status: "completed", completed_at: nowIso() });
    recordProgress(db, workspace, missionId, 100, "Plan complete. No files were modified.");
    console.log(`\n${plan}`);
    return;
  }

  recordProgress(db, workspace, missionId, 70, "Executing mission proposal...");
  updateMission(db, missionId, { status: "executing" });
  const implementer = await implementerAgent({
    goal,
    plan,
    files,
    provider: config.provider,
    model: config.model,
  });
  saveModelRun(db, missionId, "implementer", config, implementer);
  saveStep(
    db,
    missionId,
    "implementer",
    "completed",
    config.model,
    plan,
    JSON.stringify(implementer.parsed, null, 2),
    implementer.parsed.confidence,
  );

  for (const file of implementer.parsed.files) {
    if (!file?.path || typeof file.content !== "string") continue;
    db.prepare(
      "INSERT INTO patches (id, mission_id, path, content, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(newId("patch"), missionId, file.path, file.content, nowIso());
  }

  recordProgress(db, workspace, missionId, 90, "Reviewing output...");
  updateMission(db, missionId, { status: "reviewing" });
  const reviewer = await reviewerAgent({
    goal,
    plan,
    proposal: implementer.parsed,
    provider: config.provider,
    model: config.model,
  });
  saveModelRun(db, missionId, "reviewer", config, reviewer);
  saveStep(
    db,
    missionId,
    "reviewer",
    "completed",
    config.model,
    JSON.stringify(implementer.parsed, null, 2),
    JSON.stringify(reviewer.parsed, null, 2),
    reviewer.parsed.confidence,
    reviewer.parsed.score,
  );

  if (!reviewer.parsed.approved || reviewer.parsed.score < 7) {
    updateMission(db, missionId, { status: "paused" });
    recordProgress(db, workspace, missionId, 92, "Reviewer vetoed output. Mission paused.");
    console.log("Reviewer vetoed this proposal. Run apollo diff to inspect it.");
    return;
  }

  const applyResult = applyPatches(db, workspace, missionId, mode);
  if (mode === "full-auto") {
    await runCommands(db, workspace, missionId, implementer.parsed.commands);
  }

  const learned = reflection(goal, estimate, implementer.parsed, reviewer.parsed);
  db.prepare(
    "INSERT INTO memories (id, key, value, kind, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId("mem"), `mission:${missionId}`, JSON.stringify(learned), "reflection", 2, nowIso());

  updateMission(db, missionId, { status: "completed", completed_at: nowIso() });
  recordProgress(
    db,
    workspace,
    missionId,
    100,
    mode === "review"
      ? "Review complete. Patches are ready but not applied."
      : `Mission complete. Applied ${applyResult.applied} file change(s).`,
  );
  printMissionSummary(missionId, estimate, cost, applyResult, learned);
}

function diffCommand(missionId) {
  const { db, workspace } = openExisting();
  const id = missionId ?? latestMissionId(db);
  if (!id) throw new Error("No mission found.");
  const diffs = getMissionDiff(db, workspace, id);
  if (diffs.length === 0) {
    console.log(`No proposed file changes for ${id}.`);
    return;
  }
  for (const diff of diffs) {
    if (diff.blockedReason) console.log(`# Blocked: ${diff.blockedReason}`);
    console.log(unifiedDiff(diff.path, diff.before, diff.after));
  }
}

function rollbackCommand(missionId) {
  const { db, workspace } = openExisting();
  const id = missionId ?? latestMissionId(db);
  if (!id) throw new Error("No mission found.");
  const result = rollbackMission(db, workspace, id);
  console.log(`Rolled back ${result.restored} file(s) for ${id}.`);
}

function resumeCommand(missionId) {
  const { db } = openExisting();
  const id = missionId ?? latestMissionId(db);
  if (!id) throw new Error("No mission found.");
  const row = db.prepare("SELECT * FROM missions WHERE id = ?").get(id);
  if (!row) throw new Error(`Mission not found: ${id}`);
  console.log(`${row.id}: ${row.status}`);
  console.log(row.goal);
  console.log("Apollo v1 resume is audit-first: inspect with `apollo diff`, then rerun if needed.");
}

function configCommand(args) {
  const workspace = getWorkspace();
  ensureApolloProject(workspace);
  const config = readConfig(workspace);
  if (args.length === 0) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (args[0] !== "set" || args.length < 3) {
    throw new Error("Usage: apollo config set <key> <value>");
  }
  const key = args[1];
  const raw = args.slice(2).join(" ");
  const value =
    raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
  writeConfig(workspace, { ...config, [key]: value });
  console.log(`Set ${key} = ${JSON.stringify(value)}`);
}

function saveStep(
  db,
  missionId,
  type,
  status,
  model,
  input,
  output,
  confidence,
  reviewScore = null,
) {
  db.prepare(
    `
    INSERT INTO mission_steps (
      id, mission_id, step_type, status, model, input, output, confidence, review_score,
      started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    newId("step"),
    missionId,
    type,
    status,
    model,
    input,
    output,
    confidence,
    reviewScore,
    nowIso(),
    nowIso(),
  );
}

function saveModelRun(db, missionId, stepType, config, result) {
  db.prepare(
    `
    INSERT INTO model_runs (
      id, mission_id, step_type, provider, model, latency_ms, output, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    newId("run"),
    missionId,
    stepType,
    config.provider,
    config.model,
    result.latencyMs ?? 0,
    result.content ?? "",
    nowIso(),
  );
}

async function runCommands(db, workspace, missionId, commands) {
  for (const command of commands ?? []) {
    const result = await runAllowedCommand(String(command), { cwd: workspace });
    recordEvent(db, workspace, missionId, {
      type: result.skipped ? "command_skipped" : "command_ran",
      message: result.skipped ? result.output : `${command} exited ${result.exitCode}`,
      progress: 98,
      metadata: result,
    });
  }
}

function latestMissionId(db) {
  return db.prepare("SELECT id FROM missions ORDER BY created_at DESC LIMIT 1").get()?.id;
}

function openExisting() {
  const workspace = getWorkspace();
  const dbPath = join(workspace, APOLLO_DIR, "apollo.db");
  if (!existsSync(dbPath)) throw new Error("Apollo project not initialized. Run `apollo init`.");
  return { workspace, db: openApolloDb(workspace) };
}

function parseRunArgs(args) {
  const flags = {};
  const goalParts = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mode") {
      flags.mode = args[i + 1];
      i += 1;
    } else {
      goalParts.push(arg);
    }
  }
  const goal = goalParts.join(" ").trim();
  if (!goal) throw new Error('Usage: apollo run "goal" --mode review');
  return { goal, ...flags };
}

function printMissionSummary(missionId, estimate, cost, applyResult, learned) {
  console.log("");
  console.log(`Apollo Mission ${missionId}`);
  console.log(`- Complexity: ${estimate.complexity}`);
  console.log(`- Confidence: ${Math.round(estimate.confidence * 100)}%`);
  console.log(`- Estimated cost: $${cost.estimatedCost}`);
  console.log(`- Files applied: ${applyResult.applied}`);
  console.log(`- Apollo learned: ${learned.future_strategy}`);
}

function checkSqlite() {
  try {
    return Boolean(process.versions.node);
  } catch {
    return false;
  }
}

function help() {
  console.log(`Apollo CLI

Commands:
  apollo init
  apollo run "goal" --mode plan|review|auto|full-auto
  apollo status
  apollo diff [mission-id]
  apollo rollback [mission-id]
  apollo resume [mission-id]
  apollo doctor
  apollo keys check
  apollo config
  apollo config set <key> <value>
`);
}

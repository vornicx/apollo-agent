import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
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
import {
  Spinner,
  clr,
  printAgentHeader,
  printBanner,
  printError,
  printInfo,
  printMissionSummary,
  printSuccess,
  printWarn,
  statusIcon,
} from "./ui.mjs";

export async function main(argv) {
  if (argv.length === 0) return shellCommand();
  return dispatch(argv);
}

async function dispatch(argv) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "shell") return shellCommand();
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

async function shellCommand() {
  printBanner();
  const rl = createInterface({ input, output, prompt: "apollo> " });
  rl.prompt();
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    if (["exit", "quit", ":q"].includes(line.toLowerCase())) {
      break;
    }
    if (line.toLowerCase() === "clear") {
      console.clear();
      printBanner();
      rl.prompt();
      continue;
    }
    try {
      await dispatch(parseShellLine(line));
    } catch (error) {
      console.error(`Apollo: ${error instanceof Error ? error.message : String(error)}`);
    }
    rl.prompt();
  }
  rl.close();
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
  const ok = (v) => v ? clr.green("✓") : clr.red("✗");
  console.log(`\n${clr.bold("▲ APOLLO doctor")}\n`);
  console.log(`  ${ok(true)}  Node ${process.version}`);
  console.log(`  ${ok(sqliteOk)}  SQLite ${sqliteOk ? "built-in" : "missing"}`);
  console.log(`  ${ok(hasProject)}  Project initialized`);
  console.log(`  ${ok(existsSync(join(workspace, "APOLLO.md")))}  APOLLO.md`);
  console.log(`  ${ok(existsSync(join(workspace, ".apolloignore")))}  .apolloignore`);
  console.log("");
  for (const key of checkKeys()) {
    console.log(`  ${ok(key.present)}  ${key.env}`);
  }
  console.log("");
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
    printInfo("No Apollo missions yet. Run: apollo run \"your goal\"");
    return;
  }
  console.log("");
  for (const row of rows) {
    const icon = statusIcon(row.status);
    const id = clr.dim(row.id.slice(0, 18));
    const mode = clr.dim(row.mode.padEnd(9));
    const goal = row.goal.length > 60 ? row.goal.slice(0, 57) + "..." : row.goal;
    console.log(`  ${icon}  ${id}  ${mode}  ${goal}`);
  }
  console.log("");
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

const DEFAULT_MAX_ITERATIONS = 3;

async function executeMission({ db, workspace, config, missionId, goal, mode }) {
  const classifySpinner = new Spinner("Classifying mission...").start();
  const estimate = await estimateMissionSemantic(goal, process.env.GROQ_API_KEY);
  classifySpinner.stop(
    `${clr.bold(estimate.route)} · ${estimate.complexity} · risk: ${estimate.risk}${estimate.intent ? `  ${clr.dim(estimate.intent)}` : ""}`,
  );
  recordEvent(db, workspace, missionId, { type: "progress", message: "Mission classified.", progress: 5 });
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

  printSuccess(`${clr.bold(estimate.route)} · ${estimate.complexity} · $${cost.estimatedCost}`);
  printInfo(`Mission ${clr.dim(missionId)}  mode: ${clr.bold(mode)}`);

  const files = listWorkspaceFiles(workspace);
  const projectDoc = readProjectDoc(workspace);

  // ── Initial plan (iteration 1) ──────────────────────────────────────────────
  printAgentHeader("planner", "iteration 1");
  let plan;
  if (mode === "plan" || !process.env.OPENROUTER_API_KEY) {
    plan = makeStaticPlan({ goal, estimate, files });
    if (mode !== "plan") {
      printWarn("OPENROUTER_API_KEY missing — local plan only.");
      recordEvent(db, workspace, missionId, {
        level: "warn",
        type: "provider_missing",
        message: "OPENROUTER_API_KEY missing. Apollo produced a local plan only.",
        progress: 25,
      });
    } else {
      console.log(plan);
    }
  } else {
    const plannerSpinner = new Spinner("Planning...").start();
    let plannerStreaming = false;
    const planner = await plannerAgent({
      goal,
      estimate,
      files,
      projectDoc,
      provider: config.provider,
      model: config.model,
      onToken: (t) => {
        if (!plannerStreaming) { plannerSpinner.stop(); plannerStreaming = true; }
        process.stdout.write(t);
      },
    });
    if (!plannerStreaming) plannerSpinner.stop("Plan generated.");
    else process.stdout.write("\n");
    plan = planner.content;
    saveModelRun(db, missionId, "planner", config, planner);
  }
  saveStep(db, missionId, "planner", "completed", config.model, goal, plan, estimate.confidence);

  if (mode === "plan" || !process.env.OPENROUTER_API_KEY) {
    updateMission(db, missionId, { status: "completed", completed_at: nowIso() });
    printSuccess("Plan complete. No files were modified.");
    return;
  }

  // ── Iteration loop ────────────────────────────────────────────────────────
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let feedback = null;
  let lastImplementer = null;
  let lastReviewer = null;
  let approved = false;
  let completedIterations = 1;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    completedIterations = iteration;

    // Re-plan with feedback if not the first iteration
    if (iteration > 1) {
      printAgentHeader("planner", `iteration ${iteration}/${maxIterations} · replanning`);
      updateMission(db, missionId, { status: "planning" });
      const replanSpinner = new Spinner("Re-planning with feedback...").start();
      let replanStreaming = false;
      const replanner = await plannerAgent({
        goal,
        estimate,
        files,
        projectDoc,
        provider: config.provider,
        model: config.model,
        feedback,
        onToken: (t) => {
          if (!replanStreaming) { replanSpinner.stop(); replanStreaming = true; }
          process.stdout.write(t);
        },
      });
      if (!replanStreaming) replanSpinner.stop("Revised plan generated.");
      else process.stdout.write("\n");
      plan = replanner.content;
      saveModelRun(db, missionId, "planner", config, replanner);
      saveStep(
        db,
        missionId,
        "planner",
        "completed",
        config.model,
        `${goal}\n\nFeedback from iteration ${iteration - 1}:\n${JSON.stringify(feedback)}`,
        plan,
        estimate.confidence,
        null,
        iteration,
      );
    }

    // Implement
    printAgentHeader("implementer", `iteration ${iteration}/${maxIterations}`);
    updateMission(db, missionId, { status: "executing" });
    const implSpinner = new Spinner("Implementing...").start();
    let implStreaming = false;
    const implementer = await implementerAgent({
      goal,
      plan,
      files,
      provider: config.provider,
      model: config.model,
      onToken: (t) => {
        if (!implStreaming) { implSpinner.stop(); implStreaming = true; }
        process.stdout.write(clr.dim(t));
      },
    });
    if (!implStreaming) implSpinner.stop("Implementation generated.");
    else process.stdout.write("\n");

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
      null,
      iteration,
    );
    lastImplementer = implementer;

    const fileCount = implementer.parsed.files.length;
    if (fileCount > 0) {
      printInfo(
        `${fileCount} file(s) proposed: ${implementer.parsed.files.map((f) => f.path).join(", ")}`,
      );
    }

    db.prepare("DELETE FROM patches WHERE mission_id = ? AND applied = 0").run(missionId);
    for (const file of implementer.parsed.files) {
      if (!file?.path || typeof file.content !== "string") continue;
      db.prepare(
        "INSERT INTO patches (id, mission_id, path, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(newId("patch"), missionId, file.path, file.content, nowIso());
    }

    // Review
    printAgentHeader("reviewer", `iteration ${iteration}/${maxIterations}`);
    updateMission(db, missionId, { status: "reviewing" });
    const reviewSpinner = new Spinner("Reviewing...").start();
    let reviewStreaming = false;
    const reviewer = await reviewerAgent({
      goal,
      plan,
      proposal: implementer.parsed,
      provider: config.provider,
      model: config.model,
      onToken: (t) => {
        if (!reviewStreaming) { reviewSpinner.stop(); reviewStreaming = true; }
        process.stdout.write(t);
      },
    });
    if (!reviewStreaming) reviewSpinner.stop("Review complete.");
    else process.stdout.write("\n");

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
      iteration,
    );
    lastReviewer = reviewer;

    if (reviewer.parsed.approved && reviewer.parsed.score >= 7) {
      approved = true;
      printSuccess(
        `Approved — score ${reviewer.parsed.score}/10 · confidence ${Math.round(reviewer.parsed.confidence * 100)}%`,
      );
      break;
    }

    feedback = { issues: reviewer.parsed.issues, fixes: reviewer.parsed.fixes };
    printWarn(
      `Iteration ${iteration} rejected — score ${reviewer.parsed.score}/10.${iteration < maxIterations ? " Retrying with feedback." : ""}`,
    );
    if (feedback.issues.length) {
      for (const issue of feedback.issues.slice(0, 3)) {
        console.log(`  ${clr.dim("·")} ${clr.dim(issue)}`);
      }
    }
  }

  // ── Post-loop ─────────────────────────────────────────────────────────────
  if (!approved) {
    updateMission(db, missionId, { status: "max_iterations_reached" });
    printWarn(
      `Max iterations (${maxIterations}) reached. Last score: ${lastReviewer?.parsed.score ?? 0}/10.`,
    );
    printInfo("Run apollo diff to inspect the last proposal.");
    const emptyApply = { applied: 0, blocked: 0 };
    const learned = reflection(goal, estimate, lastImplementer?.parsed, lastReviewer?.parsed);
    printMissionSummary(missionId, estimate, cost, emptyApply, learned, completedIterations);
    return;
  }

  const applyResult = applyPatches(db, workspace, missionId, mode);
  if (mode === "full-auto") {
    await runCommands(db, workspace, missionId, lastImplementer.parsed.commands);
  }

  const learned = reflection(goal, estimate, lastImplementer.parsed, lastReviewer.parsed);
  db.prepare(
    "INSERT INTO memories (id, key, value, kind, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId("mem"), `mission:${missionId}`, JSON.stringify(learned), "reflection", 2, nowIso());

  updateMission(db, missionId, { status: "completed", completed_at: nowIso() });

  if (mode === "review") {
    printSuccess("Review complete. Patches ready — run apollo diff, then apollo rollback/apply.");
  } else {
    printSuccess(`Mission complete. ${applyResult.applied} file(s) applied.`);
  }
  printMissionSummary(missionId, estimate, cost, applyResult, learned, completedIterations);
}

function diffCommand(missionId) {
  const { db, workspace } = openExisting();
  const id = missionId ?? latestMissionId(db);
  if (!id) throw new Error("No mission found.");
  const diffs = getMissionDiff(db, workspace, id);
  if (diffs.length === 0) {
    printInfo(`No proposed file changes for ${id}.`);
    return;
  }
  for (const diff of diffs) {
    if (diff.blockedReason) printWarn(`Blocked: ${diff.blockedReason}`);
    console.log(unifiedDiff(diff.path, diff.before, diff.after));
  }
}

function rollbackCommand(missionId) {
  const { db, workspace } = openExisting();
  const id = missionId ?? latestMissionId(db);
  if (!id) throw new Error("No mission found.");
  const result = rollbackMission(db, workspace, id);
  printSuccess(`Rolled back ${result.restored} file(s) for ${clr.dim(id)}.`);
}

function resumeCommand(missionId) {
  const { db } = openExisting();
  const id = missionId ?? latestMissionId(db);
  if (!id) throw new Error("No mission found.");
  const row = db.prepare("SELECT * FROM missions WHERE id = ?").get(id);
  if (!row) throw new Error(`Mission not found: ${id}`);
  console.log(`${statusIcon(row.status)} ${clr.bold(row.status)}  ${clr.dim(row.id)}`);
  console.log(`  ${row.goal}`);
  printInfo('Inspect with "apollo diff", then rerun if needed.');
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
  iteration = 1,
) {
  db.prepare(
    `
    INSERT INTO mission_steps (
      id, mission_id, step_type, status, model, input, output, confidence, review_score,
      iteration, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    iteration,
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

function parseShellLine(line) {
  const args = tokenize(line);
  if (args.length === 0) return ["help"];
  const command = args[0];
  const knownCommands = new Set([
    "help",
    "--help",
    "-h",
    "init",
    "doctor",
    "keys",
    "status",
    "run",
    "diff",
    "rollback",
    "resume",
    "config",
    "shell",
  ]);
  if (knownCommands.has(command)) return args;
  return ["run", line];
}

function tokenize(line) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function checkSqlite() {
  try {
    return Boolean(process.versions.node);
  } catch {
    return false;
  }
}

function help() {
  const cmd = (c) => clr.bold(c);
  const dim = clr.dim;
  console.log(`
${clr.bold(clr.cyan("▲ APOLLO"))} ${dim("— local-first mission control")}

${clr.bold("Usage")}
  apollo                          ${dim("open interactive shell")}
  apollo run ${dim('"goal"')} ${dim("--mode")} <mode>     ${dim("execute a mission")}
  apollo status                   ${dim("show recent missions")}
  apollo diff ${dim("[mission-id]")}         ${dim("inspect proposed changes")}
  apollo rollback ${dim("[mission-id]")}     ${dim("undo file mutations")}
  apollo resume ${dim("[mission-id]")}       ${dim("check mission state")}
  apollo init                     ${dim("initialize project")}
  apollo doctor                   ${dim("diagnose setup")}
  apollo keys check               ${dim("verify API keys")}
  apollo config                   ${dim("show config")}
  apollo config set <key> <val>   ${dim("update config")}

${clr.bold("Modes")}
  ${cmd("plan")}       ${dim("plan only, no file changes")}
  ${cmd("review")}     ${dim("plan + implement, manual apply")}
  ${cmd("auto")}       ${dim("full loop with CRITIC→PLANNER feedback")}
  ${cmd("full-auto")}  ${dim("auto + run validation commands")}

${clr.bold("Examples")}
  apollo run ${dim('"add /health endpoint"')} --mode auto
  apollo run ${dim('"refactor auth module"')} --mode review
  apollo config set maxIterations 5
`);
}

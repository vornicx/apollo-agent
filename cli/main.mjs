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
import { estimateCost, estimateMissionSemantic, isQuestion, routeModel, suggestMode } from "./routing.mjs";
import { recordEvent, recordProgress } from "./events.mjs";
import { checkKeys } from "./providers.mjs";
import { applyPatches, getMissionDiff, rollbackMission } from "./checkpoints.mjs";
import { unifiedDiff } from "./diff.mjs";
import {
  chatAgent,
  implementerAgent,
  makeStaticPlan,
  plannerAgent,
  reflection,
  reviewerAgent,
} from "./agents.mjs";
import { pickMode } from "./picker.mjs";
import { runAllowedCommand } from "./commands.mjs";
import {
  Spinner,
  clr,
  printError,
  printInfo,
  printMissionSummary,
  printSuccess,
  printWarn,
  statusIcon,
} from "./ui.mjs";
import {
  StreamingBox,
  askApproval,
  printPipeline,
  printRejectionBox,
  shellPrompt,
  startupAnimation,
} from "./tui.mjs";

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
  if (command === "chat") return chatCommand(argv.slice(1).join(" "));
  throw new Error(`Unknown command: ${command}. Run "apollo help".`);
}

async function shellCommand() {
  const workspace = getWorkspace();
  const config = readConfig(workspace);
  await startupAnimation(workspace, config);

  const prompt = shellPrompt();
  const rl = createInterface({ input, output, prompt, terminal: true });
  rl.prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    if (["exit", "quit", ":q"].includes(line.toLowerCase())) {
      console.log(clr.dim("\n  Goodbye.\n"));
      break;
    }
    if (line.toLowerCase() === "clear") {
      const c = readConfig(workspace);
      await startupAnimation(workspace, c);
      rl.setPrompt(prompt);
      rl.prompt();
      continue;
    }
    try {
      await dispatch(parseShellLine(line));
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
    }
    rl.prompt();
  }
  rl.close();
}

function initCommand() {
  const workspace = getWorkspace();
  ensureApolloProject(workspace);
  openApolloDb(workspace).close();
  printSuccess("Apollo project initialized.");
  console.log(`  ${clr.dim("·")} ${APOLLO_DIR}/apollo.db`);
  console.log(`  ${clr.dim("·")} APOLLO.md`);
  console.log(`  ${clr.dim("·")} .apolloignore`);
  printInfo('Run "apollo doctor" to verify your setup.');
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
  const config = readConfig(workspace);

  // Fast classification — informs both mode suggestion and model selection
  const classifySpinner = new Spinner("Classifying...").start();
  const estimate = await estimateMissionSemantic(parsed.goal, process.env.GROQ_API_KEY);
  classifySpinner.stop(
    `${clr.bold(estimate.complexity)} · risk: ${estimate.risk} · conf ${Math.round((estimate.confidence ?? 0.8) * 100)}%${estimate.intent ? `  ${clr.dim(estimate.intent)}` : ""}`,
  );

  // Mode selection
  let mode = parsed.mode ?? config.defaultMode;
  if (!mode) {
    const suggested = suggestMode(parsed.goal, estimate);
    if (suggested === "chat") {
      printInfo(`Detected question — routing to ${clr.bold("chat")}`);
      mode = "chat";
    } else {
      mode = await pickMode(suggested);
    }
  }
  if (!mode) { printInfo("Cancelled."); return; }
  if (mode === "chat") return chatCommand(parsed.goal);
  if (!VALID_MODES.has(mode)) throw new Error(`Invalid mode: ${mode}`);

  // Model selection — auto-routes by complexity when model = "auto"
  const explicitModel = parsed.model ?? (config.model !== "auto" ? config.model : null);
  let resolvedModel = explicitModel;
  if (!resolvedModel) {
    const routed = routeModel(estimate);
    resolvedModel = routed.model;
    printInfo(`Model: ${clr.bold(routed.label)}  ${clr.dim(`(auto · ${routed.tier} tier)`)}`);
  }
  const resolvedConfig = { ...config, model: resolvedModel };

  const db = openApolloDb(workspace);

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
    await executeMission({ db, workspace, config: resolvedConfig, missionId, goal: parsed.goal, mode, estimate });
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

async function executeMission({ db, workspace, config, missionId, goal, mode, estimate: preEstimate }) {
  let estimate = preEstimate;
  if (!estimate) {
    const classifySpinner = new Spinner("Classifying mission...").start();
    estimate = await estimateMissionSemantic(goal, process.env.GROQ_API_KEY);
    classifySpinner.stop(
      `${clr.bold(estimate.complexity)} · risk: ${estimate.risk}${estimate.intent ? `  ${clr.dim(estimate.intent)}` : ""}`,
    );
  }
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

  printSuccess(`${estimate.complexity} · risk: ${estimate.risk} · $${cost.estimatedCost}  ${clr.dim(config.model)}`);
  printInfo(`Mission ${clr.dim(missionId)}  mode: ${clr.bold(mode)}`);

  const files = listWorkspaceFiles(workspace);
  const projectDoc = readProjectDoc(workspace);

  // ── Initial plan (iteration 1) ──────────────────────────────────────────────
  printPipeline("plan");
  let plan;
  const planBox = new StreamingBox("◆ PLANNER  ·  iteration 1", { colorFn: clr.cyan });

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
    }
    planBox.open();
    planBox.write(plan);
    planBox.close();
  } else {
    const planSpinner = new Spinner("Waiting for planner...").start();
    let planStarted = false;
    const planner = await plannerAgent({
      goal, estimate, files, projectDoc,
      provider: config.provider, model: config.model,
      onToken: (t) => {
        if (!planStarted) { planSpinner.stop(); planBox.open(); planStarted = true; }
        planBox.write(t);
      },
    });
    if (!planStarted) { planSpinner.stop(); planBox.open(); }
    planBox.close(`${planner.latencyMs}ms`);
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

    // Re-plan with feedback (iteration > 1)
    if (iteration > 1) {
      printPipeline("plan");
      updateMission(db, missionId, { status: "planning" });
      const replanBox = new StreamingBox(
        `◆ PLANNER  ·  iteration ${iteration}/${maxIterations}  ·  replanning`,
        { colorFn: clr.cyan },
      );
      const replanSpinner = new Spinner("Re-planning with feedback...").start();
      let replanStarted = false;
      const replanner = await plannerAgent({
        goal, estimate, files, projectDoc,
        provider: config.provider, model: config.model, feedback,
        onToken: (t) => {
          if (!replanStarted) { replanSpinner.stop(); replanBox.open(); replanStarted = true; }
          replanBox.write(t);
        },
      });
      if (!replanStarted) { replanSpinner.stop(); replanBox.open(); }
      replanBox.close(`${replanner.latencyMs}ms`);
      plan = replanner.content;
      saveModelRun(db, missionId, "planner", config, replanner);
      saveStep(
        db, missionId, "planner", "completed", config.model,
        `${goal}\n\nFeedback from iteration ${iteration - 1}:\n${JSON.stringify(feedback)}`,
        plan, estimate.confidence, null, iteration,
      );
    }

    // Implement
    printPipeline("implement");
    updateMission(db, missionId, { status: "executing" });
    const implBox = new StreamingBox(
      `◆ IMPLEMENTER  ·  iteration ${iteration}/${maxIterations}`,
      { colorFn: clr.green },
    );
    const implSpinner = new Spinner("Waiting for implementer...").start();
    let implStarted = false;
    const implementer = await implementerAgent({
      goal, plan, files,
      provider: config.provider, model: config.model,
      onToken: (t) => {
        if (!implStarted) { implSpinner.stop(); implBox.open(); implStarted = true; }
        implBox.write(clr.dim(t));
      },
    });
    if (!implStarted) { implSpinner.stop(); implBox.open(); }
    const fCount = implementer.parsed.files.length;
    implBox.close(
      `${fCount} file(s) · conf ${Math.round(implementer.parsed.confidence * 100)}% · ${implementer.latencyMs}ms`,
    );

    saveModelRun(db, missionId, "implementer", config, implementer);
    saveStep(
      db, missionId, "implementer", "completed", config.model,
      plan, JSON.stringify(implementer.parsed, null, 2),
      implementer.parsed.confidence, null, iteration,
    );
    lastImplementer = implementer;

    if (fCount > 0) {
      for (const f of implementer.parsed.files) {
        printInfo(clr.dim(`  + ${f.path}`));
      }
    }

    db.prepare("DELETE FROM patches WHERE mission_id = ? AND applied = 0").run(missionId);
    for (const file of implementer.parsed.files) {
      if (!file?.path || typeof file.content !== "string") continue;
      db.prepare(
        "INSERT INTO patches (id, mission_id, path, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(newId("patch"), missionId, file.path, file.content, nowIso());
    }

    // Review
    printPipeline("review");
    updateMission(db, missionId, { status: "reviewing" });
    const reviewBox = new StreamingBox(
      `◆ REVIEWER  ·  iteration ${iteration}/${maxIterations}`,
      { colorFn: clr.yellow },
    );
    const reviewSpinner = new Spinner("Waiting for reviewer...").start();
    let reviewStarted = false;
    const reviewer = await reviewerAgent({
      goal, plan, proposal: implementer.parsed,
      provider: config.provider, model: config.model,
      onToken: (t) => {
        if (!reviewStarted) { reviewSpinner.stop(); reviewBox.open(); reviewStarted = true; }
        reviewBox.write(t);
      },
    });
    if (!reviewStarted) { reviewSpinner.stop(); reviewBox.open(); }
    reviewBox.close(
      `score ${reviewer.parsed.score}/10 · ${reviewer.parsed.approved ? "APPROVED" : "REJECTED"} · ${reviewer.latencyMs}ms`,
    );

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
    printRejectionBox(iteration, maxIterations, reviewer.parsed.score, feedback.issues, feedback.fixes);
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

  printPipeline("apply");

  let applyResult = { applied: 0, blocked: 0 };

  if (mode === "review") {
    const patchPaths = lastImplementer.parsed.files.map((f) => f.path);
    const decision = await askApproval(patchPaths);
    if (decision === "diff") {
      const diffs = getMissionDiff(db, workspace, missionId);
      for (const d of diffs) {
        if (d.blockedReason) printWarn(`Blocked: ${d.blockedReason}`);
        console.log(unifiedDiff(d.path, d.before, d.after));
      }
      printInfo("Patches saved — run `apollo diff` to review or re-run to apply.");
    } else if (decision === "apply") {
      applyResult = applyPatches(db, workspace, missionId, mode);
      printSuccess(`Applied ${applyResult.applied} file(s).`);
    } else if (decision === "reject") {
      db.prepare("DELETE FROM patches WHERE mission_id = ? AND applied = 0").run(missionId);
      printWarn("Changes rejected and discarded.");
    } else {
      printWarn("Aborted. Patches saved — run `apollo diff` to review later.");
    }
  } else {
    applyResult = applyPatches(db, workspace, missionId, mode);
    if (mode === "full-auto") {
      await runCommands(db, workspace, missionId, lastImplementer.parsed.commands);
    }
    printSuccess(`Mission complete. ${applyResult.applied} file(s) applied.`);
  }

  const learned = reflection(goal, estimate, lastImplementer.parsed, lastReviewer.parsed);
  db.prepare(
    "INSERT INTO memories (id, key, value, kind, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId("mem"), `mission:${missionId}`, JSON.stringify(learned), "reflection", 2, nowIso());

  updateMission(db, missionId, { status: "completed", completed_at: nowIso() });
  printMissionSummary(missionId, estimate, cost, applyResult, learned, completedIterations);
}

async function chatCommand(question) {
  if (!question) throw new Error('Usage: apollo chat "your question"');
  const workspace = getWorkspace();
  ensureApolloProject(workspace);
  const config = readConfig(workspace);
  const files = listWorkspaceFiles(workspace);
  const projectDoc = readProjectDoc(workspace);

  if (!process.env.OPENROUTER_API_KEY) {
    printWarn("OPENROUTER_API_KEY missing — cannot chat.");
    return;
  }

  const chatBox = new StreamingBox("◆ APOLLO CHAT", { colorFn: clr.cyan });
  const spinner = new Spinner("Thinking...").start();
  let started = false;

  const result = await chatAgent({
    question, files, projectDoc,
    provider: config.provider, model: config.model,
    onToken: (t) => {
      if (!started) { spinner.stop(); chatBox.open(); started = true; }
      chatBox.write(t);
    },
  });
  if (!started) { spinner.stop(); chatBox.open(); }
  chatBox.close(`${result.latencyMs}ms`);
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
    } else if (arg === "--model") {
      flags.model = args[i + 1];
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
    "chat",
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
  apollo chat ${dim('"question"')}          ${dim("ask Apollo about the project")}

${clr.bold("Modes")}
  ${cmd("plan")}       ${dim("plan only, no file changes")}
  ${cmd("review")}     ${dim("plan + implement, manual apply")}
  ${cmd("auto")}       ${dim("full loop with CRITIC→PLANNER feedback")}
  ${cmd("full-auto")}  ${dim("auto + run validation commands")}

${clr.bold("Examples")}
  apollo run ${dim('"add /health endpoint"')}
  apollo run ${dim('"refactor auth module"')} --mode review
  apollo run ${dim('"add payment flow"')} --model ${dim("anthropic/claude-opus-4-5")}
  apollo chat ${dim('"how does the auth flow work?"')}
  apollo config set model ${dim("auto")}
  apollo config set maxIterations 5
`);
}

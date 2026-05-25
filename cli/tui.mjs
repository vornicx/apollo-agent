import { basename } from "node:path";
import { clr } from "./ui.mjs";

const IS_TTY = process.stdout.isTTY;
const cols = () => Math.min((process.stdout.columns || 80) - 2, 82);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Box drawing ───────────────────────────────────────────────────────────────

function boxTop(title, colorFn = clr.cyan) {
  const t = ` ${title} `;
  const w = cols();
  const bar = "─".repeat(Math.max(2, w - t.length - 2));
  return `${colorFn("┌─")}${t}${clr.dim(bar)}`;
}

function boxMid(colorFn = clr.cyan) {
  return colorFn("│") + " ";
}

function boxBot(meta = "", colorFn = clr.cyan) {
  const w = cols();
  if (meta) {
    const m = ` ${meta} `;
    const bar = "─".repeat(Math.max(2, w - m.length - 1));
    return `${colorFn("└")}${clr.dim(bar)}${clr.dim(m)}`;
  }
  return `${colorFn("└")}${clr.dim("─".repeat(w - 1))}`;
}

// ── StreamingBox ──────────────────────────────────────────────────────────────
// A bordered box whose content streams in real-time, token by token.

export class StreamingBox {
  constructor(title, { colorFn = clr.cyan } = {}) {
    this._title = title;
    this._colorFn = colorFn;
    this._active = false;
    this._lineOpen = false;
  }

  open() {
    this._active = true;
    this._lineOpen = false;
    if (IS_TTY) {
      console.log("");
      console.log(boxTop(this._title, this._colorFn));
      process.stdout.write(boxMid(this._colorFn));
      this._lineOpen = true;
    } else {
      console.log(`\n─── ${this._title} ───`);
    }
  }

  write(token) {
    if (!this._active) return;
    if (!IS_TTY) {
      process.stdout.write(token);
      return;
    }
    if (!this._lineOpen) {
      process.stdout.write(boxMid(this._colorFn));
      this._lineOpen = true;
    }
    const parts = token.split("\n");
    for (let i = 0; i < parts.length; i++) {
      process.stdout.write(parts[i]);
      if (i < parts.length - 1) {
        this._lineOpen = false;
        process.stdout.write("\n" + boxMid(this._colorFn));
        this._lineOpen = true;
      }
    }
  }

  close(meta = "") {
    if (!this._active) return;
    this._active = false;
    if (IS_TTY) {
      if (this._lineOpen) process.stdout.write("\n");
      console.log(boxBot(meta, this._colorFn));
    } else {
      if (meta) console.log(`\n[${meta}]`);
      else console.log("");
    }
  }
}

// ── Pipeline Rail ─────────────────────────────────────────────────────────────
// Shows the mission phase progress inline:  ✓ PLAN ──── ● IMPLEMENT ──── ○ REVIEW ──── ○ APPLY

const PHASE_ORDER = ["plan", "implement", "review", "apply"];
const PHASE_LABEL = { plan: "PLAN", implement: "IMPLEMENT", review: "REVIEW", apply: "APPLY" };

export function printPipeline(current) {
  const currentIdx = PHASE_ORDER.indexOf(current);
  const parts = [];
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const label = PHASE_LABEL[PHASE_ORDER[i]];
    if (i < currentIdx) parts.push(clr.green(`✓ ${label}`));
    else if (i === currentIdx) parts.push(clr.cyan(clr.bold(`● ${label}`)));
    else parts.push(clr.dim(`○ ${label}`));
    if (i < PHASE_ORDER.length - 1) {
      parts.push(i < currentIdx ? clr.green("  ───  ") : clr.dim("  ───  "));
    }
  }
  console.log(`\n  ${parts.join("")}`);
}

// ── Rejection Box ─────────────────────────────────────────────────────────────
// Displays reviewer feedback in a yellow box before restarting the loop.

export function printRejectionBox(iteration, maxIterations, score, issues, fixes) {
  const retry = iteration < maxIterations;
  const retryMsg = retry
    ? `Replanning... (iteration ${iteration + 1}/${maxIterations})`
    : "Max iterations reached.";

  if (!IS_TTY) {
    console.log(`\n✗ Iteration ${iteration}/${maxIterations} rejected — score ${score}/10`);
    issues.slice(0, 5).forEach((i) => console.log(`  · ${i}`));
    console.log(retryMsg);
    return;
  }

  const title = `✗ REJECTED  iteration ${iteration}/${maxIterations}  ·  score ${score}/10`;
  console.log("");
  console.log(boxTop(title, clr.yellow));

  if (issues.length > 0) {
    process.stdout.write(boxMid(clr.yellow) + "\n");
    process.stdout.write(boxMid(clr.yellow) + clr.bold("Issues found:") + "\n");
    for (const issue of issues.slice(0, 5)) {
      process.stdout.write(boxMid(clr.yellow) + clr.dim("  · ") + issue + "\n");
    }
  }

  if (fixes.length > 0) {
    process.stdout.write(boxMid(clr.yellow) + "\n");
    process.stdout.write(boxMid(clr.yellow) + clr.bold("Required fixes:") + "\n");
    for (const fix of fixes.slice(0, 5)) {
      process.stdout.write(boxMid(clr.yellow) + clr.cyan("  → ") + fix + "\n");
    }
  }

  process.stdout.write(boxMid(clr.yellow) + "\n");
  console.log(boxBot(retryMsg, clr.yellow));
}

// ── Approval Gate ─────────────────────────────────────────────────────────────
// Interactive keyboard prompt before applying patches in review mode.
// Returns: "apply" | "diff" | "reject" | "abort"

export async function askApproval(patchPaths) {
  if (!IS_TTY) {
    console.log(`\n${patchPaths.length} file(s) ready. Auto-approving (non-interactive).`);
    return "apply";
  }

  const display = patchPaths.slice(0, 6).map((p) => basename(p) !== p ? p : p);
  const overflow = patchPaths.length > 6 ? `  … and ${patchPaths.length - 6} more` : "";

  console.log("");
  console.log(boxTop("◆ PENDING APPROVAL", clr.cyan));
  process.stdout.write(boxMid() + "\n");
  process.stdout.write(
    boxMid() + clr.bold(`${patchPaths.length} file(s) ready to apply:`) + "\n",
  );
  for (const f of display) {
    process.stdout.write(boxMid() + clr.green(`  + ${f}`) + "\n");
  }
  if (overflow) process.stdout.write(boxMid() + clr.dim(overflow) + "\n");
  process.stdout.write(boxMid() + "\n");
  process.stdout.write(
    boxMid() +
      `${clr.bold("[y]")} apply  ${clr.bold("[d]")} diff  ${clr.bold("[n]")} reject  ${clr.bold("[q]")} abort` +
      "\n",
  );
  console.log(boxBot("", clr.cyan));
  process.stdout.write("\n  Press a key › ");

  return new Promise((resolve) => {
    let settled = false;

    function settle(action) {
      if (settled) return;
      settled = true;
      process.stdout.write("\n");
      cleanup();
      resolve(action);
    }

    function cleanup() {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onKey);
      } catch { /* ignore */ }
    }

    function onKey(key) {
      const k = typeof key === "string" ? key : key.toString("utf8");
      if (k === "y" || k === "Y" || k === "\r" || k === "\n") settle("apply");
      else if (k === "d" || k === "D") settle("diff");
      else if (k === "n" || k === "N") settle("reject");
      else if (k === "q" || k === "Q" || k === "\x03") settle("abort");
      // any other key: ignore, wait for valid input
    }

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", onKey);
    } catch {
      resolve("apply"); // non-interactive fallback
    }
  });
}

// ── Startup animation ─────────────────────────────────────────────────────────

export async function startupAnimation(workspace, config) {
  if (!IS_TTY) {
    console.log("APOLLO — Mission Control");
    return;
  }

  console.clear();

  // Draw logo line by line
  const logo = [
    "",
    `  ${clr.bold(clr.cyan("▲  A P O L L O"))}`,
    `  ${clr.dim("Mission Control")}`,
    "",
  ];

  for (const line of logo) {
    await sleep(45);
    console.log(line);
  }

  // Animate the separator bar
  const barWidth = Math.min(cols() - 2, 44);
  process.stdout.write("  " + clr.cyan(""));
  for (let i = 0; i < barWidth; i++) {
    await sleep(6);
    process.stdout.write(clr.dim("─"));
  }
  process.stdout.write("\n\n");

  await sleep(60);
  const cwd = workspace.replace(process.env.HOME ?? "", "~");
  console.log(`  ${clr.dim("Workspace")}  ${cwd}`);
  console.log(`  ${clr.dim("Provider")}   ${config.provider} · ${clr.dim(config.model)}`);

  // Mode hints
  console.log("");
  const modeHints = [
    ["plan", "plan only"],
    ["review", "plan + implement + manual apply gate"],
    ["auto", "full loop (CRITIC→PLANNER feedback)"],
    ["chat", "ask Apollo about the project"],
  ];
  for (const [mode, desc] of modeHints) {
    await sleep(25);
    console.log(`  ${clr.cyan(clr.bold(mode.padEnd(10)))} ${clr.dim(desc)}`);
  }

  console.log("");
  await sleep(80);
  console.log(`  ${clr.dim("Type a goal (mode picker appears) or a command.")}`);
  console.log(`  ${clr.dim('Examples: "add /health endpoint"  status  diff  exit')}`);
  console.log("");
}

// ── Shell prompt string ───────────────────────────────────────────────────────
// readline needs \x01...\x02 around non-printing chars for correct cursor math.

export function shellPrompt() {
  if (!IS_TTY) return "apollo> ";
  return (
    "\x01\x1b[36m\x02◆\x01\x1b[0m\x02" +
    " \x01\x1b[1m\x02apollo\x01\x1b[0m\x02" +
    " \x01\x1b[2m\x02›\x01\x1b[0m\x02 "
  );
}

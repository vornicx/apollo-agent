const IS_TTY = process.stdout.isTTY;

// ── ANSI primitives ──────────────────────────────────────────────────────────

const ESC = "\x1b[";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[K";

function wrap(open, close) {
  return IS_TTY ? (t) => `\x1b[${open}m${t}\x1b[${close}m` : (t) => t;
}

export const clr = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  reset: IS_TTY ? (t) => `\x1b[0m${t}` : (t) => t,
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  gray: wrap("90", "39"),
  white: wrap("37", "39"),
  brightCyan: wrap("96", "39"),
  brightGreen: wrap("92", "39"),
};

// ── Spinner ──────────────────────────────────────────────────────────────────

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  constructor(text) {
    this._text = text;
    this._i = 0;
    this._timer = null;
    this._stopped = false;
  }

  start() {
    if (!IS_TTY) {
      process.stdout.write(clr.dim(`  ${this._text}\n`));
      return this;
    }
    process.stdout.write(HIDE_CURSOR);
    this._timer = setInterval(() => {
      const frame = SPIN_FRAMES[this._i++ % SPIN_FRAMES.length];
      process.stdout.write(
        `${CLEAR_LINE}${clr.dim(frame)} ${clr.dim(this._text)}`,
      );
    }, 80);
    return this;
  }

  update(text) {
    this._text = text;
    return this;
  }

  stop(msg, { success = true } = {}) {
    if (this._stopped) return;
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (IS_TTY) {
      process.stdout.write(CLEAR_LINE + SHOW_CURSOR);
    }
    if (msg) {
      const icon = success
        ? clr.green("✓")
        : clr.red("✗");
      console.log(`${icon} ${msg}`);
    }
  }

  fail(msg) {
    this.stop(msg, { success: false });
  }
}

// ── Agent headers ────────────────────────────────────────────────────────────

const AGENT_STYLE = {
  planner: { color: clr.cyan, icon: "◆" },
  implementer: { color: clr.green, icon: "◆" },
  reviewer: { color: clr.yellow, icon: "◆" },
  conductor: { color: clr.magenta, icon: "◆" },
  system: { color: clr.gray, icon: "·" },
};

export function printAgentHeader(agent, extra = "") {
  const style = AGENT_STYLE[agent.toLowerCase()] ?? AGENT_STYLE.system;
  const label = style.color(clr.bold(agent.toUpperCase()));
  const suffix = extra ? clr.dim(`  ${extra}`) : "";
  const bar = clr.dim("─".repeat(48));
  console.log(`\n${style.icon} ${label}${suffix}`);
  if (IS_TTY) console.log(clr.dim(bar));
}

// ── Status line ──────────────────────────────────────────────────────────────

export function printStatus(msg) {
  console.log(clr.dim(`  ${msg}`));
}

export function printSuccess(msg) {
  console.log(`${clr.green("✓")} ${msg}`);
}

export function printError(msg) {
  console.log(`${clr.red("✗")} ${clr.red(msg)}`);
}

export function printWarn(msg) {
  console.log(`${clr.yellow("!")} ${clr.yellow(msg)}`);
}

export function printInfo(msg) {
  console.log(`${clr.blue("›")} ${msg}`);
}

// ── Progress bar ─────────────────────────────────────────────────────────────

export function printProgress(pct, msg) {
  if (!IS_TTY) {
    console.log(`[${String(pct).padStart(3)}%] ${msg}`);
    return;
  }
  const filled = Math.round(pct / 5);
  const bar = clr.cyan("█".repeat(filled)) + clr.dim("░".repeat(20 - filled));
  console.log(`  ${bar} ${clr.dim(`${pct}%`)} ${msg}`);
}

// ── Mission summary ──────────────────────────────────────────────────────────

export function printMissionSummary(missionId, estimate, cost, applyResult, learned, iterations) {
  console.log("");
  if (IS_TTY) console.log(clr.dim("─".repeat(52)));
  console.log(`${clr.bold("Mission")}  ${clr.dim(missionId)}`);
  console.log(
    `${clr.bold("Route")}    ${estimate.route} · ${estimate.complexity}`,
  );
  console.log(
    `${clr.bold("Cost")}     $${cost.estimatedCost} estimated`,
  );
  if (iterations != null && iterations > 1) {
    console.log(`${clr.bold("Iters")}    ${iterations} (loop converged)`);
  }
  if (applyResult.applied > 0) {
    console.log(
      `${clr.bold("Applied")}  ${clr.green(`${applyResult.applied} file(s) changed`)}`,
    );
  }
  if (applyResult.blocked > 0) {
    console.log(
      `${clr.bold("Blocked")}  ${clr.yellow(`${applyResult.blocked} file(s) skipped (apolloignore)`)}`,
    );
  }
  if (learned?.future_strategy) {
    console.log(`${clr.bold("Learned")}  ${clr.dim(learned.future_strategy)}`);
  }
  if (IS_TTY) console.log(clr.dim("─".repeat(52)));
  console.log("");
}

// ── Status table ─────────────────────────────────────────────────────────────

const STATUS_ICON = {
  completed: clr.green("✓"),
  failed: clr.red("✗"),
  paused: clr.yellow("⏸"),
  max_iterations_reached: clr.yellow("⚠"),
  executing: clr.cyan("⟳"),
  reviewing: clr.yellow("⟳"),
  planning: clr.cyan("⟳"),
  running: clr.cyan("⟳"),
  created: clr.dim("·"),
  rolled_back: clr.dim("↩"),
};

export function statusIcon(status) {
  return STATUS_ICON[status] ?? clr.dim("?");
}

// ── Banner ───────────────────────────────────────────────────────────────────

export function printBanner() {
  if (!IS_TTY) {
    console.log("APOLLO — Mission Control");
    console.log('Type a goal or command. "help" for commands. "exit" to quit.\n');
    return;
  }
  console.log("");
  console.log(clr.bold(clr.cyan("  ▲ APOLLO")));
  console.log(clr.dim("  Local-first mission control"));
  console.log("");
  console.log(
    clr.dim("  Commands: ") +
      ["run", "status", "diff", "rollback", "init", "doctor", "help", "exit"]
        .map((c) => clr.dim(c))
        .join(clr.dim("  ")),
  );
  console.log("");
}

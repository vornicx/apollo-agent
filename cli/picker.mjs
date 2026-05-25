import { clr } from "./ui.mjs";

const IS_TTY = process.stdout.isTTY;

export const MODES = [
  { value: "review",    label: "review",    desc: "plan + implement · manual apply gate" },
  { value: "auto",      label: "auto",      desc: "CRITIC → PLANNER feedback loop" },
  { value: "full-auto", label: "full-auto", desc: "auto + run validation commands" },
  { value: "plan",      label: "plan",      desc: "plan only · no file changes" },
  { value: "chat",      label: "chat",      desc: "ask Apollo about the project" },
];

export async function pickMode(suggested = null) {
  const defaultIdx = Math.max(0, suggested ? MODES.findIndex((m) => m.value === suggested) : 0);
  return pick("Select mode", MODES, defaultIdx);
}

export async function pick(title, items, defaultIdx = 0) {
  if (!IS_TTY) return items[0].value;

  let idx = Math.min(defaultIdx, items.length - 1);
  let drawnLines = 0;

  function renderLines() {
    const out = [];
    out.push("");
    out.push(`  ${clr.bold(title)}`);
    out.push("");
    for (let i = 0; i < items.length; i++) {
      const { label, desc } = items[i];
      const arrow = i === idx ? clr.cyan("›") : " ";
      const rawLabel = label.padEnd(12);
      const lbl = i === idx ? clr.bold(rawLabel) : clr.dim(rawLabel);
      const d = i === idx ? desc : clr.dim(desc);
      out.push(`  ${arrow} ${lbl} ${d}`);
    }
    out.push("");
    out.push(clr.dim("  ↑↓ navigate  ↵ select  esc cancel"));
    return out;
  }

  const initial = renderLines();
  for (const l of initial) process.stdout.write(l + "\n");
  drawnLines = initial.length;

  return new Promise((resolve) => {
    let settled = false;

    function redraw() {
      process.stdout.write(`\x1b[${drawnLines}A`);
      const lines = renderLines();
      for (const l of lines) {
        process.stdout.write("\x1b[2K" + l + "\n");
      }
      drawnLines = lines.length;
    }

    function erase() {
      process.stdout.write(`\x1b[${drawnLines}A`);
      for (let i = 0; i < drawnLines; i++) {
        process.stdout.write("\x1b[2K\n");
      }
      process.stdout.write(`\x1b[${drawnLines}A`);
    }

    function settle(value) {
      if (settled) return;
      settled = true;
      cleanup();
      erase();
      resolve(value);
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
      if (k === "\x1b[A" || k === "k") {
        idx = (idx - 1 + items.length) % items.length;
        redraw();
      } else if (k === "\x1b[B" || k === "j") {
        idx = (idx + 1) % items.length;
        redraw();
      } else if (k === "\r" || k === "\n") {
        settle(items[idx].value);
      } else if (k === "\x1b" || k === "\x03") {
        settle(null);
      }
    }

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", onKey);
    } catch {
      resolve(items[0].value);
    }
  });
}

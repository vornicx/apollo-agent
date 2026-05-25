import { spawn } from "node:child_process";

export function classifyCommand(command) {
  const value = command.trim().toLowerCase();
  if (!value) return "empty";
  if (
    /\b(rm|rmdir|del|remove-item|format|mkfs|shutdown|reboot)\b/.test(value) ||
    /\bgit\s+(reset|clean|checkout)\b/.test(value)
  ) {
    return "destructive";
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/.test(value)) return "network";
  if (/\b(curl|wget|ssh|scp|ftp)\b/.test(value)) return "network";
  if (/[>]{1,2}/.test(value) || /\b(touch|mkdir|mv|move|copy|cp)\b/.test(value)) return "write";
  if (
    /^git\s+(status|diff|show|log|branch|rev-parse)\b/.test(value) ||
    /^npm\s+(test|run\s+test|run\s+build)\b/.test(value) ||
    /^npm\.cmd\s+(test|run\s+build)\b/.test(value) ||
    /^node\s+--test\b/.test(value)
  ) {
    return "safe";
  }
  return "unknown";
}

export async function runAllowedCommand(command, options = {}) {
  const kind = classifyCommand(command);
  const { allowNetworkCommands = true, allowDestructiveCommands = true } = options;

  const blocked =
    (kind === "destructive" && !allowDestructiveCommands) ||
    (kind === "network" && !allowNetworkCommands) ||
    kind === "empty";

  if (blocked) {
    return {
      command,
      kind,
      skipped: true,
      output: `Skipped ${kind} command: ${command}`,
      exitCode: null,
    };
  }
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ command, kind, skipped: false, output: output.slice(-8000), exitCode });
    });
  });
}

import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  /** Combined stdout+stderr, trimmed to the last `tailChars` characters. */
  outputTail: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  tailChars?: number;
}

/**
 * Run one verification command through the shell and capture its verdict.
 * Exit code 0 = passed. Output is tail-trimmed so verifier feedback stays
 * prompt-sized.
 */
export function runCommand(command: string, options: RunCommandOptions): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const tailChars = options.tailChars ?? 4_000;
  return new Promise((resolvePromise) => {
    const child = spawn(command, { shell: true, cwd: options.cwd });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > tailChars * 4) output = output.slice(-tailChars * 2);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ command, ok: false, code: null, outputTail: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = output.length > tailChars ? `…${output.slice(-tailChars)}` : output;
      resolvePromise({
        command,
        ok: !timedOut && code === 0,
        code,
        outputTail: timedOut ? `${tail}\n[timed out after ${timeoutMs}ms]` : tail,
        timedOut,
      });
    });
  });
}

/** Run verification commands in order; stop at the first failure (fail fast, cheap feedback). */
export async function runVerifiers(
  commands: string[],
  options: RunCommandOptions,
): Promise<{ passed: boolean; results: CommandResult[] }> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    const result = await runCommand(command, options);
    results.push(result);
    if (!result.ok) return { passed: false, results };
  }
  return { passed: true, results };
}

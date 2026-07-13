import type { CortexLimits } from "./types";

/**
 * The meta-controller: the guardrails that keep a weak or wandering agent
 * honest — loop detection, budget, and turn limits. Pure and deterministic;
 * the orchestrator asks it what to do. Ported from cortex-harness.
 */
export class MetaController {
  private readonly signatures: string[] = [];
  loopStrikes = 0;
  turns = 0;
  costUsd = 0;
  private warned = false;

  constructor(private readonly limits: CortexLimits) {}

  recordTurn(costUsd: number): void {
    this.turns += 1;
    this.costUsd += costUsd;
  }

  /** A stable signature of an action = tool name + a hash of its arguments. */
  recordAction(tool: string, args: Record<string, unknown>): void {
    this.signatures.push(`${tool}(${stableHash(args)})`);
  }

  /**
   * A loop is three identical actions in a row, or an A-B-A-B oscillation —
   * the classic "no progress" failure modes.
   */
  loopDetected(): boolean {
    const n = this.signatures.length;
    if (n >= 3 && this.signatures[n - 1] === this.signatures[n - 2] && this.signatures[n - 2] === this.signatures[n - 3]) {
      return true;
    }
    if (
      n >= 4 &&
      this.signatures[n - 1] === this.signatures[n - 3] &&
      this.signatures[n - 2] === this.signatures[n - 4] &&
      this.signatures[n - 1] !== this.signatures[n - 2]
    ) {
      return true;
    }
    return false;
  }

  /** First loop → force a replan; a second → an honest stop. */
  onLoop(): "replan" | "stop" {
    this.loopStrikes += 1;
    this.signatures.length = 0; // reset the window after acting on it
    return this.loopStrikes >= 2 ? "stop" : "replan";
  }

  budgetExceeded(): boolean {
    return this.costUsd >= this.limits.budgetUsd;
  }

  turnsExceeded(): boolean {
    return this.turns >= this.limits.maxTurns;
  }

  budgetRatio(): number {
    return this.limits.budgetUsd > 0 ? this.costUsd / this.limits.budgetUsd : 0;
  }

  /** Warn the model once when spend crosses 80% of the budget. */
  shouldWarnBudget(): boolean {
    if (!this.warned && this.budgetRatio() >= 0.8 && !this.budgetExceeded()) {
      this.warned = true;
      return true;
    }
    return false;
  }
}

function stableHash(value: unknown): string {
  const json = stableStringify(value);
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

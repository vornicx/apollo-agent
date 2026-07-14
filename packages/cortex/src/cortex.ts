import { EventBus } from "@archic/apollo-core";
import { builtinTools, workspaceTools, type ToolRegistry } from "@archic/apollo-agent";
import type { ChatMessage, ProviderHub, ToolCall } from "@archic/apollo-providers";
import { ModelRegistry } from "@archic/apollo-router";
import { describeCheck, runChecks, type Check } from "./checks";
import { CortexContext } from "./context";
import { critique } from "./critic";
import { executeStep } from "./executor";
import { MetaController } from "./meta";
import { makePlan } from "./planner";
import { verifyCriteria } from "./verifier";
import { DEFAULT_LIMITS, type CortexLimits, type CortexResult, type Plan, type PlanStep } from "./types";

export interface RunCortexOptions {
  hub: ProviderHub;
  /** Models the cognitive phases may route among (already filtered to available providers). */
  registry: ModelRegistry;
  goal: string;
  taskId?: string;
  /** Tools the executor may use. Defaults to workspaceTools(workspace) or the read-only built-ins. */
  tools?: ToolRegistry;
  /** Read-only tools the verifier uses to independently check criteria. */
  verifyTools?: ToolRegistry;
  /** When set, the executor gets jailed file+shell tools rooted here. */
  workspace?: string;
  /**
   * Deterministic checks enforced by the harness in addition to whatever the
   * planner emits — the guard no longer depends on the model planning them.
   */
  extraChecks?: Check[];
  /** Gate destructive tools (write/shell). Returning false denies + tells the model. */
  confirm?: (call: ToolCall) => boolean | Promise<boolean>;
  limits?: Partial<CortexLimits>;
  bus?: EventBus;
  /** User language hint for the final answer. */
  language?: string;
  /** Source-attributed context supplied to planning; it never grants tool authority. */
  context?: string;
  contextEvidence?: Array<{ id: string; summary: string }>;
}

const SYNTHESIS_SYSTEM = `You are the SYNTHESIS phase. Write the final answer for the user, clearly and completely, in the user's language. Do not mention the cognitive cycle machinery. Base the answer only on what was actually accomplished and verified.`;
const HONEST_STOP_SYSTEM = `You are the HONEST STOP phase. The task was halted before completion. Write a short, honest report: what was attempted, what actually got done (with evidence), what remains, and why it stopped. Never claim success that wasn't verified. Use the user's language.`;

/**
 * Apollo's cognitive cycle: PLAN → (ACT → CRITIC)+ → VERIFY → FINALIZE, each
 * phase routed through the autorouter, run over the provider hub, emitted on the
 * Apollo event stream, and guarded by the meta-controller (loops, budget, turns)
 * with honest stops. Adapted from cortex-harness onto Apollo's primitives.
 */
export async function runCortex(options: RunCortexOptions): Promise<CortexResult> {
  const bus = options.bus ?? new EventBus();
  const taskId = options.taskId ?? `cortex-${Date.now()}`;
  const limits: CortexLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const meta = new MetaController(limits);
  const ctx = new CortexContext({ hub: options.hub, registry: options.registry, bus, meta, taskId });
  const tools = options.tools ?? (options.workspace ? workspaceTools(options.workspace) : builtinTools(process.cwd()));
  // The verifier gets read-only tools rooted in the same workspace (never write/shell).
  const verifyTools = options.verifyTools ?? (options.workspace ? builtinTools(options.workspace) : undefined);
  const beliefs: Record<string, string> = {};
  const langNote = options.language ? ` Answer in ${options.language}.` : "";

  bus.emit({ type: "task.started", taskId, title: options.goal.slice(0, 80) });
  for (const item of options.contextEvidence ?? []) {
    beliefs[`memory:${item.id}`] = item.summary;
    bus.emit({ type: "belief.recorded", taskId, key: `memory:${item.id}`, value: item.summary.slice(0, 160) });
  }

  const finish = (status: CortexResult["status"], answer: string, plan: Plan | null): CortexResult => {
    if (status === "ok") bus.emit({ type: "task.completed", taskId, attempts: meta.turns });
    else {
      bus.emit({ type: "meta.stop", taskId, reason: answer.slice(0, 120), status });
      bus.emit({ type: "task.failed", taskId, attempts: meta.turns, reason: status });
    }
    return { status, answer, plan, beliefs, costUsd: round(meta.costUsd), turns: meta.turns, replans };
  };

  const honestStop = async (reason: string, status: CortexResult["status"], plan: Plan | null): Promise<CortexResult> => {
    const answer = await ctx.complete("writing", "standard", [
      { role: "system", content: HONEST_STOP_SYSTEM },
      { role: "user", content: `Goal: ${options.goal}\nReason for stopping: ${reason}\nBeliefs: ${JSON.stringify(beliefs)}.${langNote}` },
    ]);
    return finish(status, answer, plan);
  };

  const synthesize = async (plan: Plan): Promise<string> =>
    ctx.complete("writing", "standard", [
      { role: "system", content: SYNTHESIS_SYSTEM },
      {
        role: "user",
        content: `Goal: ${options.goal}\n\nWhat was done:\n${plan.steps.map((s) => `- [${s.id}] ${s.status}: ${s.note}`).join("\n")}\n\nBeliefs: ${JSON.stringify(beliefs)}.${langNote}`,
      },
    ]);

  // ---- PLAN ----
  let plan = await makePlan(ctx, options.goal, undefined, options.context);
  let replans = 0;
  let feedback = "";
  if (plan.needsInput) return honestStop(`human input required: ${plan.needsInput}`, "needs_input", plan);

  // Trivial fast path: a direct answer, checked by one critic.
  if (plan.trivial && (options.extraChecks ?? []).length === 0) {
    const answer = await ctx.complete("conversation", "standard", [
      { role: "user", content: `${options.goal}${langNote}` },
    ]);
    const pseudo: PlanStep = {
      id: "s0",
      description: "direct answer",
      expectedOutcome: "goal answered",
      dependsOn: [],
      status: "done",
      note: answer.slice(0, 200),
    };
    const verdict = await critique(ctx, pseudo, answer.slice(0, 2000));
    if (verdict.verdict === "pass") {
      plan.steps = [pseudo];
      bus.emit({ type: "verification.passed", taskId, attempt: ctx.lastActAttempt || meta.turns });
      return finish("ok", answer, plan);
    }
    feedback = verdict.feedback || "direct answer rejected";
    plan = await makePlan(ctx, options.goal, feedback, options.context);
    replans += 1;
  }

  // ---- outer loop ----
  let lastTranscript = "";
  let stepsSinceCritic = 0;
  for (;;) {
    if (meta.budgetExceeded()) return honestStop(`budget limit reached ($${meta.costUsd.toFixed(4)} of $${limits.budgetUsd})`, "budget_stop", plan);
    if (meta.turnsExceeded()) return honestStop(`turn limit reached (${meta.turns} of ${limits.maxTurns})`, "turns_stop", plan);

    if (feedback) {
      if (replans >= limits.maxReplans) return honestStop(`replan limit reached (${limits.maxReplans})`, "turns_stop", plan);
      plan = await makePlan(ctx, options.goal, feedback, options.context);
      replans += 1;
      feedback = "";
      if (plan.needsInput) return honestStop(`human input required: ${plan.needsInput}`, "needs_input", plan);
      continue;
    }

    const step = nextActionable(plan);
    if (!step) {
      const failed = plan.steps.filter((s) => s.status === "failed");
      if (failed.length > 0) {
        feedback = `These steps failed and block completion: ${failed.map((s) => `[${s.id}] ${s.note}`).join("; ")}`;
        continue;
      }
      // ---- VERIFY ----
      // Deterministic checks first: the harness confirms ground truth itself, so
      // a model can never hallucinate past a failing file/command check. Planner
      // checks and user-supplied ones are both enforced.
      const allChecks = [...plan.checks, ...(options.extraChecks ?? [])];
      if (allChecks.length > 0 && options.workspace) {
        const checkResults = await runChecks(allChecks, options.workspace);
        const failedChecks = checkResults.filter((r) => !r.passed);
        for (const r of checkResults) {
          bus.emit({ type: "belief.recorded", taskId, key: `check:${r.passed ? "ok" : "FAIL"}`, value: `${describeCheck(r.check)} — ${r.detail}` });
        }
        if (failedChecks.length > 0) {
          bus.emit({ type: "verification.failed", taskId, attempt: ctx.lastActAttempt || meta.turns, issues: failedChecks.map((r) => `${describeCheck(r.check)} — ${r.detail}`) });
          feedback = `DETERMINISTIC CHECK FAILED (the harness verified this against the workspace, not the model):\n${failedChecks.map((r) => `- ${describeCheck(r.check)}: ${r.detail}`).join("\n")}\nThe work is not actually done. Fix it.`;
          continue;
        }
        // User-enforced ground truth is sufficient proof. Do not let a model
        // verifier veto real command/filesystem evidence it cannot improve on.
        if ((options.extraChecks ?? []).length > 0) {
          const actAttempt = ctx.lastActAttempt || meta.turns;
          bus.emit({ type: "verification.passed", taskId, attempt: actAttempt });
          return finish("ok", await synthesize(plan), plan);
        }
      }

      // Verdicts reference the last ACT attempt so telemetry attributes them
      // to the acting model, not to the verifier's own execution.
      const actAttempt = ctx.lastActAttempt || meta.turns;
      const verdict = await verifyCriteria(ctx, plan.doneCriteria, beliefs, lastTranscript, verifyTools);
      if (!verdict.passed) {
        bus.emit({ type: "verification.failed", taskId, attempt: actAttempt, issues: verdict.missing.length ? verdict.missing : [verdict.feedback] });
        feedback = `VERIFICATION FAILED: ${verdict.feedback}${verdict.missing.length ? `\nMissing: ${verdict.missing.join("; ")}` : ""}`;
        continue;
      }
      bus.emit({ type: "verification.passed", taskId, attempt: actAttempt });
      // ---- FINALIZE ----
      return finish("ok", await synthesize(plan), plan);
    }

    // ---- ACT ----
    // Replans are also escalation opportunities. Previously this was always 1,
    // so candidateForAttempt could never advance beyond the first-ranked model.
    const stepResult = await executeStep(ctx, step, tools, beliefs, replans + 1, options.confirm);
    lastTranscript = stepResult.transcript.slice(-6000);
    stepsSinceCritic += 1;

    // A plan is a means, not the outcome. If user-enforced ground truth is
    // already satisfied, finish immediately instead of spending turns on
    // stale/ancillary plan steps or protocol ceremony.
    if ((options.extraChecks ?? []).length > 0 && options.workspace) {
      const checkResults = await runChecks(options.extraChecks ?? [], options.workspace);
      for (const result of checkResults) {
        bus.emit({ type: "belief.recorded", taskId, key: `check:${result.passed ? "ok" : "FAIL"}`, value: `${describeCheck(result.check)} — ${result.detail}` });
      }
      if (checkResults.every((result) => result.passed)) {
        bus.emit({ type: "verification.passed", taskId, attempt: ctx.lastActAttempt || meta.turns });
        return finish("ok", await synthesize(plan), plan);
      }
    }

    if (stepResult.questions.length > 0) {
      return honestStop(`human input required: ${stepResult.questions.join("; ")}`, "needs_input", plan);
    }

    if (stepResult.loop) {
      const decision = meta.onLoop();
      if (decision === "stop") return honestStop("loop persisted after a forced replan", "loop_stop", plan);
      feedback = `LOOP DETECTED on step [${step.id}]. The executor repeated an action without progress. Produce a DIFFERENT approach.`;
      continue;
    }

    // ---- CRITIC (every N steps, always on failure) ----
    const hasGroundTruth = plan.checks.length > 0 || (options.extraChecks ?? []).length > 0;
    if (step.status === "failed" || (!hasGroundTruth && stepsSinceCritic >= limits.criticEvery)) {
      stepsSinceCritic = 0;
      const verdict = await critique(ctx, step, lastTranscript);
      if (verdict.verdict === "fail" || verdict.forceReplan || step.status === "failed") {
        feedback = `${verdict.feedback}${verdict.issues.length ? `\nIssues: ${verdict.issues.join("; ")}` : ""}` || step.note;
      }
    }
  }
}

function nextActionable(plan: Plan): PlanStep | undefined {
  return plan.steps.find(
    (s) => s.status === "pending" && s.dependsOn.every((dep) => plan.steps.find((d) => d.id === dep)?.status === "done"),
  );
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

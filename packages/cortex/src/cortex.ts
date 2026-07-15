import { EventBus } from "@archic/apollo-core";
import { builtinTools, runAgent, workspaceTools, type AgentResult, type ToolRegistry } from "@archic/apollo-agent";
import type { ChatMessage, ProviderHub, ToolCall } from "@archic/apollo-providers";
import { ModelRegistry } from "@archic/apollo-router";
import {
  applyFileBlocks,
  FILE_BLOCK_INSTRUCTIONS,
  materializePatchBlocks,
  parseFileBlocks,
  parsePatchBlocks,
  PATCH_BLOCK_INSTRUCTIONS,
} from "@archic/apollo-verify";
import { describeCheck, runChecks, type Check } from "./checks";
import { CortexContext } from "./context";
import { critique } from "./critic";
import { localInstantReply, selectDepth, type CortexDepth } from "./depth";
import { executeStep } from "./executor";
import { MetaController } from "./meta";
import { assessOneShot, inferOneShotChecks, prepareOneShotContext, shouldTryOneShot } from "./oneshot";
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
  /**
   * Gate only the bounded one-shot transaction and its deterministic checks.
   * This lets a controller authorize the exact requested mutation without
   * granting the fallback agent blanket shell/write access.
   */
  confirmOneShot?: (call: ToolCall) => boolean | Promise<boolean>;
  limits?: Partial<CortexLimits>;
  bus?: EventBus;
  /** User language hint for the final answer. */
  language?: string;
  /** Source-attributed context supplied to planning; it never grants tool authority. */
  context?: string;
  contextEvidence?: Array<{ id: string; summary: string }>;
  /** Adaptive by default; callers can force a lane for benchmarks or high-risk work. */
  depth?: CortexDepth;
  /** Persist output deltas for live surfaces such as Desktop. */
  streamOutput?: boolean;
  /** Try deterministic context + one completion before the tool loop. Default true. */
  oneShot?: boolean;
  /** Persistent local cache for reusable context snapshots. */
  snapshotCacheDir?: string;
}

const SYNTHESIS_SYSTEM = `You are the SYNTHESIS phase. Write the final answer for the user, clearly and completely, in the user's language. Do not mention the cognitive cycle machinery. Base the answer only on what was actually accomplished and verified.`;
const HONEST_STOP_SYSTEM = `You are the HONEST STOP phase. The task was halted before completion. Write a short, honest report: what was attempted, what actually got done (with evidence), what remains, and why it stopped. Never claim success that wasn't verified. Use the user's language.`;
const AGENT_SYSTEM = `You are Apollo's execution agent. Take the shortest safe path to the user's outcome.
Use tools when the task touches files, commands, current state, or anything that must be inspected. Do not merely describe work: perform it.
After a mutation, inspect the changed artifact and run the smallest relevant check when available. Never claim success after a failed tool.
Respect permission denials and ask for the missing approval instead of retrying a denied action. Finish with a concise user-facing answer in the user's language.`;
const oneShotSystem = (mode: "full" | "patch") => `You are Apollo's one-shot editing engine. The harness has already inspected the workspace and run the declared checks.
Produce the complete minimal change in this single response. ${mode === "patch" ? "Return exact SEARCH/REPLACE patches for existing files using the convention below; if a new file is required, return NEEDS_AGENT." : "Return every changed or new file as a complete file block using the convention below."}
Never use placeholders, approximate search text, ordinary diffs, or tool calls. Preserve unrelated behavior and do not edit generated/dependency files unless explicitly requested.
If the supplied context is insufficient for a safe complete change, return exactly NEEDS_AGENT: <reason> and no file blocks.
If the request is ambiguous, contradictory, destructive, or lacks external authority, return exactly NEEDS_INPUT: <question> and no file blocks.
Do not claim checks passed; the harness runs them after applying the files.

${mode === "patch" ? PATCH_BLOCK_INSTRUCTIONS : FILE_BLOCK_INSTRUCTIONS}`;

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
  const depthDecision = selectDepth(options.goal, options.depth ?? "auto");
  const depth = depthDecision.depth;
  let replans = 0;
  const outputStream = options.streamOutput ? createOutputStream(bus, taskId) : undefined;
  const outputDelta = outputStream?.push;

  bus.emit({ type: "task.started", taskId, title: options.goal.slice(0, 80) });
  bus.emit({ type: "depth.selected", taskId, depth, reason: depthDecision.reason });
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
    return { status, answer, plan, beliefs, costUsd: round(meta.costUsd), turns: meta.turns, replans, depth };
  };

  const honestStop = async (reason: string, status: CortexResult["status"], plan: Plan | null): Promise<CortexResult> => {
    const answer = await ctx.complete("writing", "standard", [
      { role: "system", content: HONEST_STOP_SYSTEM },
      { role: "user", content: `Goal: ${options.goal}\nReason for stopping: ${reason}\nBeliefs: ${JSON.stringify(beliefs)}.${langNote}` },
    ], 800, outputDelta);
    outputStream?.flush();
    return finish(status, answer, plan);
  };

  const synthesize = async (plan: Plan): Promise<string> => {
    const answer = await ctx.complete("writing", "standard", [
      { role: "system", content: SYNTHESIS_SYSTEM },
      {
        role: "user",
        content: `Goal: ${options.goal}\n\nWhat was done:\n${plan.steps.map((s) => `- [${s.id}] ${s.status}: ${s.note}`).join("\n")}\n\nBeliefs: ${JSON.stringify(beliefs)}.${langNote}`,
      },
    ], 1_000, outputDelta);
    outputStream?.flush();
    return answer;
  };

  if (depth === "instant") {
    const localAnswer = localInstantReply(options.goal);
    let answer: string;
    if (localAnswer !== undefined) {
      const attempt = ctx.beginExecution();
      answer = localAnswer;
      outputDelta?.(answer);
      ctx.endExecution(attempt, "apollo/local-instant", 0, {
        inputTokens: Math.max(1, Math.ceil(options.goal.length / 4)),
        outputTokens: Math.max(1, Math.ceil(answer.length / 4)),
      }, { durationMs: 0, ttftMs: 0, modelCalls: 0 });
      ctx.meta.recordTurn(0);
      ctx.lastActAttempt = attempt;
    } else {
      answer = await ctx.complete("conversation", "trivial", [
        { role: "system", content: "Reply naturally and concisely in the user's language." },
        { role: "user", content: `${options.goal}${langNote}` },
      ], 256, outputDelta);
    }
    outputStream?.flush();
    const step: PlanStep = {
      id: "instant",
      description: "direct response",
      expectedOutcome: "a useful response is produced",
      dependsOn: [],
      kind: "conversation",
      status: "done",
      note: answer.slice(0, 200),
    };
    bus.emit({ type: "verification.passed", taskId, attempt: ctx.lastActAttempt || meta.turns });
    return finish("ok", answer, { analysis: depthDecision.reason, steps: [step], doneCriteria: [], checks: [], confidence: 1, trivial: true });
  }

  if (depth === "agent") {
    const step: PlanStep = {
      id: "agent",
      description: "complete the user outcome with the minimum necessary tool loop",
      expectedOutcome: "the requested outcome is completed and inspected",
      dependsOn: [],
      kind: depthDecision.kind,
      status: "active",
      note: "",
    };
    const plan: Plan = {
      analysis: depthDecision.reason,
      steps: [step],
      doneCriteria: [],
      checks: [...(options.extraChecks ?? [])],
      confidence: 0.75,
      trivial: false,
    };
    bus.emit({ type: "plan.produced", taskId, steps: 1, confidence: plan.confidence, replan: false });
    bus.emit({ type: "step.started", taskId, stepId: step.id, description: step.description });
    let oneShotEligible = options.oneShot !== false && shouldTryOneShot(depthDecision.kind, options.workspace, options.goal);
    const explicitChecks = [...(options.extraChecks ?? [])];
    let oneShotChecks = [...explicitChecks];
    if (oneShotEligible && options.workspace && oneShotChecks.length === 0) {
      oneShotChecks = inferOneShotChecks(options.workspace, options.goal);
      for (let index = 0; index < oneShotChecks.length; index++) {
        const check = oneShotChecks[index];
        const confirmOneShot = options.confirmOneShot ?? options.confirm;
        if (check.type !== "command_succeeds" || !confirmOneShot) continue;
        const allowed = await confirmOneShot({
          id: `one-shot-check-${index + 1}`,
          name: "run_command",
          arguments: { command: check.command },
        });
        if (!allowed) {
          oneShotEligible = false;
          break;
        }
      }
    }
    plan.checks = oneShotChecks;
    const preparedContext = oneShotEligible && options.workspace
      ? await prepareOneShotContext(options.workspace, options.goal, oneShotChecks, { cacheDir: options.snapshotCacheDir })
      : undefined;
    const oneShotAssessment = preparedContext ? assessOneShot(preparedContext, options.goal) : undefined;
    const oneShotContext = oneShotAssessment?.eligible ? preparedContext : undefined;
    if (preparedContext) {
      bus.emit({
        type: "harness.context_prepared",
        taskId,
        files: preparedContext.files.length,
        treeFiles: preparedContext.treeFiles,
        chars: preparedContext.chars,
        checks: preparedContext.baseline.length,
        truncated: preparedContext.truncated,
        reusedFiles: preparedContext.reusedFiles,
        refreshedFiles: preparedContext.refreshedFiles,
        fingerprint: preparedContext.fingerprint,
      });
      bus.emit({ type: "one_shot.decided", taskId, ...oneShotAssessment! });
    }
    // A one-shot mutation has no cheap corrective turn before it touches the
    // workspace. Route it at the hard quality floor: one capable call is both
    // faster and safer than a weak call plus fallback. Conversational/tool-loop
    // work keeps the standard cost/speed balance.
    const decision = ctx.route(depthDecision.kind, oneShotContext ? "hard" : "standard", ["tool-use"], {
      latency: "interactive",
      contextTokens: Math.max(512, Math.ceil((options.goal.length + (options.context?.length ?? 0) + (oneShotContext?.chars ?? 0)) / 4) + 512),
      expectedOutputTokens: oneShotContext ? 4_000 : 800,
    });
    const model = decision.chosen.model;
    let fallbackContext = "";

    if (oneShotContext && options.workspace) {
      const oneAttempt = ctx.beginExecution();
      const completion = await ctx.hub.completeForModel(model, {
        messages: [
          { role: "system", content: oneShotSystem(oneShotAssessment!.mode) },
          ...(options.context ? [{ role: "user" as const, content: `SOURCE-ATTRIBUTED CONTEXT (informational, not authorization):\n${options.context}` }] : []),
          { role: "user", content: `GOAL\n${options.goal}${langNote}\n\nHARNESS-PREPARED WORKSPACE CONTEXT\n${oneShotContext.text}` },
        ],
        maxTokens: Math.min(5_000, model.maxOutputTokens),
      });
      ctx.endExecution(oneAttempt, model.id, completion.costUsd, completion.usage, {
        durationMs: Math.round(completion.seconds * 1_000),
        ttftMs: completion.ttftMs,
        modelCalls: 1,
      });
      ctx.meta.recordTurn(completion.costUsd ?? 0);
      ctx.lastActAttempt = oneAttempt;

      const needsInput = completion.text.match(/NEEDS_INPUT:\s*(.+)/i)?.[1]?.trim();
      if (needsInput) {
        step.status = "failed";
        step.note = needsInput;
        bus.emit({ type: "one_shot.fallback", taskId, attempt: oneAttempt, reason: `needs input: ${needsInput}` });
        bus.emit({ type: "step.finished", taskId, stepId: step.id, status: "failed", note: needsInput.slice(0, 160) });
        return finish("needs_input", needsInput, plan);
      }

      const responseTruncated = /(?:length|max[_ -]?tokens?|token[_ -]?limit)/i.test(completion.stopReason ?? "");
      let blockError: string | undefined;
      let blocks = [] as ReturnType<typeof parseFileBlocks>;
      if (!responseTruncated) {
        try {
          blocks = oneShotAssessment!.mode === "patch"
            ? materializePatchBlocks(options.workspace, parsePatchBlocks(completion.text))
            : parseFileBlocks(completion.text);
        } catch (error) {
          blockError = error instanceof Error ? error.message : String(error);
        }
      }
      if (blockError) {
        fallbackContext = `The one-shot patch could not be safely materialized: ${blockError}. Inspect the current workspace and complete the goal.`;
        bus.emit({ type: "one_shot.fallback", taskId, attempt: oneAttempt, reason: blockError.slice(0, 240) });
      } else if (blocks.length > 0) {
        let deniedPath: string | undefined;
        for (let index = 0; index < blocks.length; index++) {
          const call: ToolCall = {
            id: `one-shot-write-${index + 1}`,
            name: "write_file",
            arguments: { path: blocks[index].path, content: blocks[index].content },
          };
          const confirmOneShot = options.confirmOneShot ?? options.confirm;
          if (confirmOneShot && !(await confirmOneShot(call))) {
            deniedPath = blocks[index].path;
            break;
          }
        }
        if (deniedPath) {
          step.status = "failed";
          step.note = `write permission required for ${deniedPath}`;
          bus.emit({ type: "one_shot.fallback", taskId, attempt: oneAttempt, reason: step.note });
          bus.emit({ type: "step.finished", taskId, stepId: step.id, status: "failed", note: step.note });
          return finish("needs_input", `Necesito aprobación para escribir ${deniedPath}.`, plan);
        }

        try {
          const applied = applyFileBlocks(options.workspace, blocks);
          const issues = await verifyOneShotFiles(applied.written, tools, bus, taskId, options.workspace, oneShotChecks);
          if (issues.length === 0) {
            const answer = oneShotAnswer(completion.text, applied.written, options.goal);
            outputDelta?.(answer);
            outputStream?.flush();
            step.status = "done";
            step.note = answer.slice(0, 300);
            bus.emit({ type: "one_shot.completed", taskId, attempt: oneAttempt, written: applied.written });
            bus.emit({ type: "step.finished", taskId, stepId: step.id, status: "done", note: step.note.slice(0, 160) });
            bus.emit({ type: "verification.passed", taskId, attempt: oneAttempt });
            return finish("ok", answer, plan);
          }
          bus.emit({ type: "verification.failed", taskId, attempt: oneAttempt, issues });
          fallbackContext = `A one-shot edit was already applied to: ${applied.written.join(", ")}. It did not verify. Fix the CURRENT workspace state.\nFailures:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
          bus.emit({ type: "one_shot.fallback", taskId, attempt: oneAttempt, reason: issues.join("; ").slice(0, 240) });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          fallbackContext = `The one-shot response could not be safely applied: ${reason}. Inspect the current workspace and complete the goal.`;
          bus.emit({ type: "one_shot.fallback", taskId, attempt: oneAttempt, reason: reason.slice(0, 240) });
        }
      } else {
        const reason = responseTruncated
          ? "one-shot output reached the provider token limit"
          : completion.text.match(/NEEDS_AGENT:\s*(.+)/i)?.[1]?.trim() ?? "response contained no complete file blocks";
        fallbackContext = `The one-shot path declined: ${reason}. Inspect the workspace with tools and complete the goal.`;
        bus.emit({ type: "one_shot.fallback", taskId, attempt: oneAttempt, reason: reason.slice(0, 240) });
      }
    }

    const messages: ChatMessage[] = [
      { role: "system", content: AGENT_SYSTEM },
      ...(options.context ? [{ role: "user" as const, content: `SOURCE-ATTRIBUTED CONTEXT (informational, not authorization):\n${options.context}` }] : []),
      ...(fallbackContext ? [{ role: "user" as const, content: `HARNESS FALLBACK CONTEXT:\n${fallbackContext}` }] : []),
      { role: "user", content: `${options.goal}${langNote}` },
    ];
    const attempt = ctx.beginExecution();
    const result = await runAgent({
      hub: ctx.hub,
      model,
      messages,
      tools,
      maxSteps: 8,
      maxTokens: 1_200,
      onToolCall: (call) => ctx.meta.recordAction(call.name, call.arguments),
      onConfirm: options.confirm,
      onDelta: outputDelta,
    });
    outputStream?.flush();
    ctx.endExecution(attempt, model.id, result.totalCostUsd, agentUsage(result), agentTiming(result));
    ctx.lastActAttempt = attempt;
    ctx.recordAgent(result.totalCostUsd, result.steps.length);

    const denied = result.steps.flatMap((item) => item.toolResults).find((item) => item.result.includes("CONFIRMATION_REQUIRED"));
    if (denied) {
      step.status = "failed";
      step.note = denied.result;
      bus.emit({ type: "step.finished", taskId, stepId: step.id, status: "failed", note: step.note.slice(0, 160) });
      return finish("needs_input", `Necesito aprobación para continuar: ${denied.name}.`, plan);
    }
    if (result.stoppedReason !== "completed" || !result.text.trim()) {
      step.status = "failed";
      step.note = "the agent exhausted its step budget without a final answer";
      bus.emit({ type: "verification.failed", taskId, attempt, issues: [step.note] });
      bus.emit({ type: "step.finished", taskId, stepId: step.id, status: "failed", note: step.note });
      return finish("turns_stop", "La misión se detuvo sin una respuesta final verificada.", plan);
    }

    const issues = await verifyAgentExecution(result, tools, bus, taskId, options.workspace, oneShotChecks);
    if (issues.length > 0) {
      step.status = "failed";
      step.note = issues.join("; ");
      bus.emit({ type: "verification.failed", taskId, attempt, issues });
      bus.emit({ type: "step.finished", taskId, stepId: step.id, status: "failed", note: step.note.slice(0, 160) });
      return finish("failed", result.text, plan);
    }
    step.status = "done";
    step.note = result.text.slice(0, 300);
    bus.emit({ type: "step.finished", taskId, stepId: step.id, status: "done", note: step.note.slice(0, 160) });
    bus.emit({ type: "verification.passed", taskId, attempt });
    return finish("ok", result.text, plan);
  }

  // ---- DEEP: PLAN ----
  let plan = await makePlan(ctx, options.goal, undefined, options.context);
  let feedback = "";
  if (plan.needsInput) return honestStop(`human input required: ${plan.needsInput}`, "needs_input", plan);

  // Trivial fast path: producing the conversational answer is the outcome.
  // The normal critic requires tool evidence, which is appropriate for actions
  // but would reject a greeting or other direct response and force a useless
  // replan loop.
  if (plan.trivial && (options.extraChecks ?? []).length === 0) {
    const answer = await ctx.complete("conversation", "standard", [
      { role: "user", content: `${options.goal}${langNote}` },
    ], 600, outputDelta);
    outputStream?.flush();
    const pseudo: PlanStep = {
      id: "s0",
      description: "direct answer",
      expectedOutcome: "goal answered",
      dependsOn: [],
      status: "done",
      note: answer.slice(0, 200),
    };
    plan.steps = [pseudo];
    bus.emit({ type: "verification.passed", taskId, attempt: ctx.lastActAttempt || meta.turns });
    return finish("ok", answer, plan);
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

function agentUsage(result: AgentResult): { inputTokens?: number; outputTokens?: number } {
  const sum = (values: Array<number | undefined>): number | undefined => {
    const known = values.filter((value): value is number => value !== undefined);
    return known.length ? known.reduce((total, value) => total + value, 0) : undefined;
  };
  return {
    inputTokens: sum(result.steps.map((step) => step.inputTokens)),
    outputTokens: sum(result.steps.map((step) => step.outputTokens)),
  };
}

function agentTiming(result: AgentResult): { durationMs?: number; ttftMs?: number; modelCalls: number } {
  const durations = result.steps.map((step) => step.durationMs).filter((value): value is number => value !== undefined);
  return {
    durationMs: durations.length ? durations.reduce((total, value) => total + value, 0) : undefined,
    ttftMs: result.steps[0]?.ttftMs,
    modelCalls: result.steps.length,
  };
}

function createOutputStream(bus: EventBus, taskId: string): { push(text: string): void; flush(): void } {
  let buffer = "";
  let emittedFirst = false;
  let lastFlush = 0;
  const flush = () => {
    if (!buffer) return;
    bus.emit({ type: "output.delta", taskId, text: buffer });
    buffer = "";
    lastFlush = Date.now();
  };
  return {
    push(text: string) {
      if (!text) return;
      buffer += text;
      // Paint the first token immediately; batch the rest to avoid one
      // synchronous JSONL append per provider token.
      if (!emittedFirst) {
        emittedFirst = true;
        flush();
      } else if (buffer.length >= 160 || Date.now() - lastFlush >= 80 || text.includes("\n")) {
        flush();
      }
    },
    flush,
  };
}

async function verifyOneShotFiles(
  written: string[],
  tools: ToolRegistry,
  bus: EventBus,
  taskId: string,
  workspace: string,
  checks: Check[],
): Promise<string[]> {
  const issues: string[] = [];
  for (const path of written) {
    if (!tools.has("read_file")) {
      issues.push(`changed artifact could not be inspected: ${path}`);
      continue;
    }
    const inspected = await tools.execute({ id: `one-shot-read-${path}`, name: "read_file", arguments: { path } });
    if (/^(?:error:|TOOL_ERROR:)/i.test(inspected)) issues.push(`${path}: post-write inspection failed`);
    else bus.emit({ type: "belief.recorded", taskId, key: `artifact:${path}`, value: `one-shot inspection passed (${inspected.length} chars read)` });
  }
  if (checks.length > 0) {
    const results = await runChecks(checks, workspace);
    for (const item of results) {
      bus.emit({
        type: "belief.recorded",
        taskId,
        key: `check:${item.passed ? "ok" : "FAIL"}`,
        value: `${describeCheck(item.check)} — ${item.detail}`,
      });
      if (!item.passed) issues.push(`${describeCheck(item.check)} — ${item.detail}`);
    }
  }
  return issues;
}

function oneShotAnswer(text: string, written: string[], goal: string): string {
  const prose = text
    .replace(/```file:[^\n`]+\n[\s\S]*?```/g, "")
    .replace(/NEEDS_(?:AGENT|INPUT):[^\n]*/gi, "")
    .trim();
  if (prose && prose.length <= 800) return prose;
  const spanish = /[áéíóúñ¿¡]|\b(corrige|crea|implementa|haz|archivo|prueba)\b/iu.test(goal);
  return spanish
    ? `Completado en un one-shot verificado: ${written.join(", ")}.`
    : `Completed in one verified shot: ${written.join(", ")}.`;
}

async function verifyAgentExecution(
  result: AgentResult,
  tools: ToolRegistry,
  bus: EventBus,
  taskId: string,
  workspace: string | undefined,
  checks: Check[],
): Promise<string[]> {
  const issues: string[] = [];
  const writes = new Map<string, string>();
  let lastShellResult: string | undefined;

  for (const step of result.steps) {
    for (let index = 0; index < step.toolCalls.length; index++) {
      const call = step.toolCalls[index];
      const output = step.toolResults[index]?.result ?? "error: missing tool result";
      if (call.name === "write_file" || call.name === "edit_file") {
        writes.set(String(call.arguments.path ?? ""), output);
      }
      if (call.name === "run_command") lastShellResult = output;
    }
  }

  for (const [path, output] of writes) {
    if (/^(?:error:|TOOL_ERROR:)/i.test(output)) {
      issues.push(`${path || "file mutation"}: ${output.slice(0, 180)}`);
      continue;
    }
    if (!path || !tools.has("read_file")) {
      issues.push(`changed artifact could not be inspected: ${path || "unknown path"}`);
      continue;
    }
    const inspected = await tools.execute({ id: `verify-${path}`, name: "read_file", arguments: { path } });
    if (/^(?:error:|TOOL_ERROR:)/i.test(inspected)) issues.push(`${path}: post-write inspection failed`);
    else bus.emit({ type: "belief.recorded", taskId, key: `artifact:${path}`, value: `post-write inspection passed (${inspected.length} chars read)` });
  }

  if (lastShellResult && !/^exit 0(?:\n|$)/.test(lastShellResult)) {
    issues.push(`last command did not pass: ${lastShellResult.slice(0, 180)}`);
  }

  if (checks.length > 0) {
    if (!workspace) issues.push("deterministic checks require a workspace");
    else {
      const results = await runChecks(checks, workspace);
      for (const item of results) {
        bus.emit({
          type: "belief.recorded",
          taskId,
          key: `check:${item.passed ? "ok" : "FAIL"}`,
          value: `${describeCheck(item.check)} — ${item.detail}`,
        });
        if (!item.passed) issues.push(`${describeCheck(item.check)} — ${item.detail}`);
      }
    }
  }
  return issues;
}

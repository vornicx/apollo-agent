import { runAgent, type ToolRegistry } from "@archic/apollo-agent";
import type { ChatMessage, ToolCall } from "@archic/apollo-providers";
import type { CortexContext } from "./context";
import { parseProtocol, PROTOCOL_INSTRUCTIONS } from "./protocol";
import type { PlanStep } from "./types";

const EXECUTOR_SYSTEM = `You are the EXECUTOR in a cognitive cycle. Work ONE step at a time using the available tools.
Actually do the work with tools — do not describe or assume results. Verify with a tool before claiming a step done.
${PROTOCOL_INSTRUCTIONS}`;

export interface StepResult {
  status: "done" | "failed";
  note: string;
  beliefs: Array<{ key: string; value: string }>;
  transcript: string;
  loop: boolean;
  costUsd: number;
  questions: string[];
}

/**
 * ACT phase for one step — routes by the step's own task kind, runs the agentic
 * loop with the given tools, feeds every tool call to the meta-controller for
 * loop detection, and reads the step's outcome from the line protocol. Stuck
 * steps (attempt-based) escalate to the next-ranked model.
 */
function sumTokens(values: Array<number | undefined>): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : undefined;
}

export async function executeStep(
  ctx: CortexContext,
  step: PlanStep,
  tools: ToolRegistry,
  beliefs: Record<string, string>,
  attempt: number,
  onConfirm?: (call: ToolCall) => boolean | Promise<boolean>,
): Promise<StepResult> {
  ctx.bus.emit({ type: "step.started", taskId: ctx.taskId, stepId: step.id, description: step.description });

  const decision = ctx.route(step.kind ?? "code-generation", "hard", ["tool-use"]);
  const model = ctx.candidate(decision, attempt); // escalate on retries

  const beliefLines = Object.entries(beliefs).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: EXECUTOR_SYSTEM },
    {
      role: "user",
      content:
        (beliefLines ? `WORKING MEMORY (beliefs so far):\n${beliefLines}\n\n` : "") +
        `Current step [${step.id}]: ${step.description}\n` +
        `Expected outcome: ${step.expectedOutcome}\n\n` +
        `Do this step now. When (and only when) its expected outcome is truly met, emit STEP_DONE[${step.id}]: <summary>. ` +
        `If you cannot, emit STEP_FAILED[${step.id}]: <reason>.`,
    },
  ];

  // The ACT run is an execution on the stream; verification verdicts for the
  // cycle reference this attempt, so telemetry credits/blames the acting model.
  const execAttempt = ctx.beginExecution();
  const result = await runAgent({
    hub: ctx.hub,
    model,
    messages,
    tools,
    maxSteps: 6,
    onToolCall: (call) => ctx.meta.recordAction(call.name, call.arguments),
    onConfirm,
  });
  ctx.endExecution(execAttempt, model.id, result.totalCostUsd, {
    inputTokens: sumTokens(result.steps.map((s) => s.inputTokens)),
    outputTokens: sumTokens(result.steps.map((s) => s.outputTokens)),
  }, {
    durationMs: sumTokens(result.steps.map((s) => s.durationMs)),
    ttftMs: result.steps[0]?.ttftMs,
    modelCalls: result.steps.length,
  });
  ctx.lastActAttempt = execAttempt;
  ctx.recordAgent(result.totalCostUsd, result.steps.length);

  const transcript = result.steps
    .map((s) => s.text + s.toolResults.map((r) => `\n[tool ${r.name}] ${r.result.slice(0, 400)}`).join(""))
    .join("\n");
  const protocol = parseProtocol(result.steps.map((s) => s.text).join("\n") + "\n" + result.text);

  for (const b of protocol.beliefs) {
    beliefs[b.key] = b.value;
    ctx.bus.emit({ type: "belief.recorded", taskId: ctx.taskId, key: b.key, value: b.value.slice(0, 160) });
  }

  const loop = ctx.meta.loopDetected();
  let status: "done" | "failed";
  let note: string;
  const doneHere = protocol.done.find((d) => d.id === step.id);
  const failedHere = protocol.failed.find((f) => f.id === step.id);
  if (loop) {
    status = "failed";
    note = "loop detected: repeated action without progress";
  } else if (failedHere) {
    status = "failed";
    note = failedHere.note || "executor reported failure";
  } else if (doneHere) {
    status = "done";
    note = doneHere.note || "closed by executor";
  } else if (result.stoppedReason === "completed") {
    // Finishing a completion is not proof that work finished. The explicit
    // protocol is the state transition; without it Cortex must retry/replan.
    status = "failed";
    note = "executor stopped without an explicit STEP_DONE backed by tool evidence";
  } else {
    status = "failed";
    note = "step did not close within the step budget";
  }

  step.status = status;
  step.note = note;
  ctx.bus.emit({ type: "step.finished", taskId: ctx.taskId, stepId: step.id, status, note: note.slice(0, 160) });
  return { status, note, beliefs: protocol.beliefs, transcript, loop, costUsd: result.totalCostUsd, questions: protocol.questions };
}

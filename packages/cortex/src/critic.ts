import type { ChatMessage } from "@archic/apollo-providers";
import type { CortexContext } from "./context";
import type { CriticVerdict, PlanStep } from "./types";

const CRITIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    issues: { type: "array", items: { type: "string" } },
    hallucinationRisk: { type: "number", description: "0..1: risk the step's claimed success is fabricated." },
    forceReplan: { type: "boolean" },
    feedback: { type: "string", description: "Concrete, actionable feedback for the planner if this fails." },
  },
  required: ["verdict", "issues", "hallucinationRisk", "forceReplan", "feedback"],
};

const CRITIC_SYSTEM = `You are the CRITIC — adversarial reviewer of a single step in a cognitive cycle.
Assume the executor may be over-claiming. Your job is to catch unverified success, skipped work, and hallucinated results.
- verdict "fail" if the expected outcome is not actually evidenced by the transcript (tool outputs, not just the model's assertions).
- Set forceReplan=true when the whole approach is wrong, not just this step.
- hallucinationRisk is high when success is claimed without tool evidence.
- feedback must be specific enough for the planner to fix the approach. Be terse and hard to fool.`;

/**
 * CRITIC phase — routes a code-review task at hard complexity so the strongest
 * reasoning model audits the step. A failing verdict feeds a forced replan.
 */
export async function critique(ctx: CortexContext, step: PlanStep, transcriptTail: string): Promise<CriticVerdict> {
  const messages: ChatMessage[] = [
    { role: "system", content: CRITIC_SYSTEM },
    {
      role: "user",
      content:
        `STEP [${step.id}]: ${step.description}\n` +
        `EXPECTED OUTCOME: ${step.expectedOutcome}\n` +
        `EXECUTOR STATUS: ${step.status} (${step.note || "no note"})\n\n` +
        `TRANSCRIPT TAIL:\n${transcriptTail}`,
    },
  ];
  const { value } = await ctx.structured<CriticVerdict>("code-review", "hard", messages, CRITIC_SCHEMA, "verdict");
  const verdict: CriticVerdict = {
    verdict: value.verdict === "fail" ? "fail" : "pass",
    issues: value.issues ?? [],
    hallucinationRisk: value.hallucinationRisk ?? 0,
    forceReplan: Boolean(value.forceReplan),
    feedback: value.feedback ?? "",
  };
  const failed = verdict.verdict === "fail" || step.status === "failed";
  ctx.bus.emit({
    type: "critic.reviewed",
    taskId: ctx.taskId,
    stepId: step.id,
    verdict: failed ? "fail" : "pass",
    forceReplan: verdict.forceReplan,
    note: verdict.feedback.slice(0, 160),
  });
  return verdict;
}

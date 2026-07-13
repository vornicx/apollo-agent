import { runAgent, type ToolRegistry } from "@archic/apollo-agent";
import type { ChatMessage } from "@archic/apollo-providers";
import type { CortexContext } from "./context";
import type { VerifyVerdict } from "./types";

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    passed: { type: "boolean" },
    perCriterion: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterion: { type: "string" },
          met: { type: "boolean" },
          evidence: { type: "string", description: "The specific tool output / fact that proves it, or why it's missing." },
        },
        required: ["criterion", "met", "evidence"],
      },
    },
    missing: { type: "array", items: { type: "string" } },
    feedback: { type: "string" },
  },
  required: ["passed", "perCriterion", "missing", "feedback"],
};

const VERIFIER_SYSTEM = `You are the independent VERIFIER. Decide whether each done-criterion is actually met, using ONLY the evidence in the transcript (real tool outputs and recorded beliefs) — never the executor's unproven claims.
- passed=true ONLY if every criterion is met with concrete evidence.
- For each criterion cite the exact evidence, or state precisely what is missing.
- If evidence is absent, the criterion is NOT met, no matter what the executor asserted.`;

/**
 * VERIFY phase — routes a debugging task at hard complexity (independent from
 * the executor) and judges the done-criteria against the real evidence gathered
 * during execution. A failure feeds a replan.
 */
export async function verifyCriteria(
  ctx: CortexContext,
  criteria: string[],
  beliefs: Record<string, string>,
  transcriptTail: string,
  readOnlyTools?: ToolRegistry,
): Promise<VerifyVerdict> {
  if (criteria.length === 0) {
    return { passed: true, perCriterion: [], missing: [], feedback: "no criteria" };
  }
  const beliefLines = Object.entries(beliefs).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(none)";

  // Active check: if read-only tools are available, the verifier independently
  // inspects the workspace to gather fresh evidence before judging — it does not
  // trust the executor's transcript alone.
  let gathered = "";
  if (readOnlyTools && readOnlyTools.definitions().length > 0) {
    const decision = ctx.route("debugging", "hard", ["tool-use"]);
    const probe = await runAgent({
      hub: ctx.hub,
      model: decision.chosen.model,
      tools: readOnlyTools,
      maxSteps: 5,
      messages: [
        { role: "system", content: `${VERIFIER_SYSTEM}\nUse the read-only tools to independently check each criterion, then summarize what you found.` },
        { role: "user", content: `Check these criteria against the actual workspace:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}` },
      ],
    });
    ctx.recordAgent(probe.totalCostUsd, probe.steps.length);
    gathered = probe.steps
      .map((s) => s.toolResults.map((r) => `[${r.name}] ${r.result.slice(0, 400)}`).join("\n"))
      .join("\n")
      .slice(-4000);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: VERIFIER_SYSTEM },
    {
      role: "user",
      content:
        `DONE CRITERIA:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
        `RECORDED BELIEFS:\n${beliefLines}\n\n` +
        (gathered ? `INDEPENDENT READ-ONLY CHECK:\n${gathered}\n\n` : "") +
        `EXECUTION TRANSCRIPT TAIL:\n${transcriptTail}`,
    },
  ];
  const { value } = await ctx.structured<VerifyVerdict>("debugging", "hard", messages, VERIFY_SCHEMA, "verification");
  return {
    passed: Boolean(value.passed),
    perCriterion: value.perCriterion ?? [],
    missing: value.missing ?? [],
    feedback: value.feedback ?? "",
  };
}

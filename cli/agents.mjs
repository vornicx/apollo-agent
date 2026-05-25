import { callModel } from "./providers.mjs";
import { extractJson } from "./diff.mjs";

const CONSTITUTION = `
You are APOLLO.
You are mission control, not a chatbot.
Optimize outcomes, reliability, quality, speed and cost efficiency.
Use the minimum intelligence required.
Never overwrite manual work.
Every file mutation must be auditable and reversible.
Return precise, useful work.
`.trim();

export function makeStaticPlan({ goal, estimate, files }) {
  return [
    "MISSION ANALYSIS",
    "",
    `Objective: ${goal}`,
    `Complexity: ${estimate.complexity}`,
    `Route: ${estimate.route}`,
    `Confidence: ${Math.round(estimate.confidence * 100)}%`,
    "",
    "Execution strategy:",
    "- Inspect the relevant project files.",
    "- Produce the smallest safe change set.",
    "- Create a checkpoint before mutating files.",
    "- Review output before completion.",
    "",
    "Potentially relevant files:",
    ...files.slice(0, 20).map((file) => `- ${file}`),
    "",
    "Success criteria:",
    "- No denied files are touched.",
    "- Changes are reversible through Apollo rollback.",
    "- Output includes assumptions, confidence and next action.",
  ].join("\n");
}

export async function plannerAgent({ goal, estimate, files, projectDoc, provider, model, feedback, onToken }) {
  const feedbackBlock = feedback?.issues?.length
    ? [
        "",
        "## Iteration feedback — revision required",
        "The previous implementation was rejected by the reviewer.",
        "",
        "Issues found:",
        ...feedback.issues.map((i) => `- ${i}`),
        "",
        "Required fixes:",
        ...feedback.fixes.map((f) => `- ${f}`),
        "",
        "Revise your plan to address ALL issues above before proceeding.",
      ].join("\n")
    : "";

  const result = await callModel({
    provider,
    model,
    onToken,
    messages: [
      { role: "system", content: `${CONSTITUTION}\n\nYou are Apollo Planner. Do not edit files.` },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          "",
          `Estimate: ${JSON.stringify(estimate)}`,
          "",
          `Project memory:\n${projectDoc.slice(0, 6000)}`,
          "",
          `Workspace files:\n${files.slice(0, 80).join("\n")}`,
          "",
          "Write a concise mission plan. Include likely files, risks, tests and success criteria.",
          feedbackBlock,
        ].join("\n"),
      },
    ],
  });
  return result;
}

export async function implementerAgent({ goal, plan, files, provider, model, onToken }) {
  const result = await callModel({
    provider,
    model,
    onToken,
    messages: [
      {
        role: "system",
        content: `${CONSTITUTION}

You are Apollo Implementer.
Return ONLY valid JSON matching this shape:
{
  "summary": "short summary",
  "files": [{"path": "relative/path", "content": "complete new file content"}],
  "commands": ["optional safe validation commands"],
  "confidence": 0.0
}

Only include files that must change. Use complete file contents, not partial patches.
Never include .env, .git, node_modules, dist, build output, or secret files.`,
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          "",
          `Plan:\n${plan}`,
          "",
          `Workspace files:\n${files.slice(0, 80).join("\n")}`,
        ].join("\n"),
      },
    ],
  });
  const parsed = JSON.parse(extractJson(result.content));
  return {
    ...result,
    parsed: {
      summary: String(parsed.summary ?? "Apollo generated a change proposal."),
      files: Array.isArray(parsed.files) ? parsed.files : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      confidence: Number(parsed.confidence ?? 0.72),
    },
  };
}

export async function reviewerAgent({ goal, plan, proposal, provider, model, onToken }) {
  const result = await callModel({
    provider,
    model,
    onToken,
    messages: [
      {
        role: "system",
        content: `${CONSTITUTION}

You are Apollo Reviewer.
Return ONLY valid JSON:
{"score": 0-10, "approved": true, "issues": [], "fixes": [], "confidence": 0.0}`,
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          "",
          `Plan:\n${plan}`,
          "",
          `Proposal:\n${JSON.stringify(proposal).slice(0, 20000)}`,
        ].join("\n"),
      },
    ],
  });
  const parsed = JSON.parse(extractJson(result.content));
  return {
    ...result,
    parsed: {
      score: Number(parsed.score ?? 0),
      approved: Boolean(parsed.approved),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [],
      confidence: Number(parsed.confidence ?? 0.7),
    },
  };
}

export function reflection(goal, estimate, proposal, review) {
  return {
    success_score: review?.score ? Math.max(0, Math.min(1, review.score / 10)) : 0.7,
    task_type: estimate.intent || estimate.complexity,
    future_strategy:
      review?.approved === false
        ? "Tighten planning and require another review before applying similar changes."
        : "Route similar missions through the same local checkpoint workflow.",
    prompt_update_needed: false,
    learned: [
      `Goal type: ${goal.slice(0, 120)}`,
      `Route: ${estimate.route}`,
      `Files proposed: ${proposal?.files?.length ?? 0}`,
    ],
  };
}

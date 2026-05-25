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

export async function implementerAgent({ goal, plan, files, skillsContext = "", skillResults = null, provider, model, onToken }) {
  const skillResultsBlock = skillResults
    ? `\n## Skill execution results\n${JSON.stringify(skillResults, null, 2)}\nUse these results in your implementation.`
    : "";

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
  "confidence": 0.0,
  "skill_calls": [{"skill": "skill-name", "inputs": {}, "reason": "why"}]
}

Only include files that must change. Use complete file contents, not partial patches.
Never include .env, .git, node_modules, dist, build output, or secret files.
Include skill_calls only if you genuinely need external data before you can write the files.
${skillsContext}`,
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          "",
          `Plan:\n${plan}`,
          "",
          `Workspace files:\n${files.slice(0, 80).join("\n")}`,
          skillResultsBlock,
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
      skill_calls: Array.isArray(parsed.skill_calls) ? parsed.skill_calls : [],
    },
  };
}

// ── Skill agents ──────────────────────────────────────────────────────────────

export async function skillDiscoveryAgent({ goal, plan, existingSkills, provider, model }) {
  const existing = existingSkills.length
    ? `\nAlready installed skills:\n${existingSkills.map((s) => `- ${s.name}: ${s.meta?.description ?? ""}`).join("\n")}`
    : "\nNo skills installed yet.";

  const result = await callModel({
    provider,
    model,
    messages: [
      {
        role: "system",
        content: `${CONSTITUTION}

You are Apollo Skill Analyst.
Analyze the goal and plan to identify external capabilities that would help implement it.
Return ONLY valid JSON:
{
  "needed": [
    {
      "name": "kebab-case-name",
      "description": "what this skill does",
      "why": "why it's needed for this specific task",
      "githubQuery": "search term for GitHub",
      "npmQuery": "search term for npm"
    }
  ],
  "reasoning": "brief explanation"
}

Rules:
- Only identify skills genuinely needed and NOT already installed
- Prefer zero skills when file edits alone can accomplish the goal
- A skill is needed when: fetching external data, calling external APIs, running specialized transforms, or generating content that requires real-time external information
- Max 3 skills per mission`,
      },
      {
        role: "user",
        content: [`Goal: ${goal}`, `Plan:\n${plan.slice(0, 3000)}`, existing].join("\n"),
      },
    ],
  });

  let parsed = {};
  try {
    parsed = JSON.parse(extractJson(result.content));
  } catch { /* empty */ }

  return {
    ...result,
    parsed: {
      needed: Array.isArray(parsed.needed) ? parsed.needed.slice(0, 3) : [],
      reasoning: String(parsed.reasoning ?? ""),
    },
  };
}

export async function skillCreatorAgent({ name, description, why, searchResults, provider, model, onToken }) {
  const searchCtx = searchResults.length
    ? `\nReference implementations found (use for inspiration, do NOT copy verbatim):\n${searchResults
        .slice(0, 4)
        .map((r) => `- ${r.name} (${r.source}, ${r.stars ?? ""}★): ${r.description}`)
        .join("\n")}`
    : "\nNo reference implementations found. Build from scratch using Node.js built-ins and fetch.";

  const result = await callModel({
    provider,
    model,
    onToken,
    messages: [
      {
        role: "system",
        content: `${CONSTITUTION}

You are Apollo Skill Creator.
Write a complete Node.js ESM skill module. Return ONLY valid JSON:
{
  "code": "// complete ESM module\\n...",
  "meta": {
    "name": "skill-name",
    "description": "what it does",
    "inputs": { "paramName": "description" },
    "outputs": { "fieldName": "description" }
  }
}

The module MUST export:
  export const meta = { name, description, inputs, outputs };
  export async function run(inputs, context) { ... return { ...outputs }; }

Constraints:
- Use only Node.js built-ins (fs, path, crypto, child_process) and global fetch
- No npm package imports
- Handle errors gracefully, return { error: "..." } on failure
- Add timeouts to fetch calls using AbortSignal.timeout()`,
      },
      {
        role: "user",
        content: [
          `Skill name: ${name}`,
          `Description: ${description}`,
          `Why needed: ${why}`,
          searchCtx,
        ].join("\n"),
      },
    ],
  });

  let parsed = {};
  try {
    parsed = JSON.parse(extractJson(result.content));
  } catch { /* empty */ }

  return {
    ...result,
    parsed: {
      code: String(parsed.code ?? `export const meta = { name: "${name}", description: "${description}", inputs: {}, outputs: {} };\nexport async function run(inputs) { return {}; }`),
      meta: parsed.meta ?? { name, description, inputs: {}, outputs: {} },
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

const APOLLO_CAPABILITIES = `
## Apollo capabilities

Commands:
  apollo                          open interactive shell
  apollo run "goal"               execute a mission (shows mode picker)
  apollo run "goal" --mode plan   plan only, no file changes
  apollo run "goal" --mode review plan + implement + manual apply gate (y/d/n/q)
  apollo run "goal" --mode auto   full CRITIC→PLANNER feedback loop, up to 3 iterations
  apollo run "goal" --mode full-auto  auto + runs validation commands
  apollo run "goal" --model anthropic/claude-3.5-sonnet  override model
  apollo chat "question"          ask a question about the project
  apollo status                   show recent missions
  apollo diff [mission-id]        inspect proposed file changes
  apollo rollback [mission-id]    undo applied changes
  apollo resume [mission-id]      check mission state
  apollo init                     initialize project (creates APOLLO.md, .apollo/apollo.db)
  apollo doctor                   verify setup (Node, SQLite, API keys)
  apollo keys check               list which API keys are present
  apollo config                   show current config
  apollo config set key value     update config (e.g. maxIterations, defaultMode, model)

Model auto-routing:
  When model="auto" (default), Apollo picks the model by task complexity:
  - simple + low risk  → Llama 3.1 8B    (fast, cheap)
  - simple             → Gemini Flash 1.5  (fast, cheap)
  - standard           → GPT-4o mini      (balanced)
  - complex            → Claude 3.5 Sonnet (high quality)
  - critical           → Claude Opus 4.5  (most capable)

Intent detection:
  Apollo detects questions and routes them to chat automatically.
  It detects complexity/risk and pre-selects the safest mode in the picker.

Feedback loop (auto/full-auto modes):
  reviewer returns approved=false → planner gets issues+fixes injected → retry
  Up to maxIterations (default: 3). Status "max_iterations_reached" if exhausted.
`.trim();

export async function chatAgent({ question, files, projectDoc, provider, model, onToken }) {
  const result = await callModel({
    provider,
    model,
    onToken,
    messages: [
      {
        role: "system",
        content: `${CONSTITUTION}

You are Apollo Chat — a project-aware assistant.
Answer questions about the codebase, architecture, decisions, and Apollo itself concisely.
Do not write file patches. If the user wants to implement something, suggest: apollo run "<goal>"

${APOLLO_CAPABILITIES}`,
      },
      {
        role: "user",
        content: [
          `Question: ${question}`,
          "",
          `Project memory:\n${projectDoc.slice(0, 4000)}`,
          "",
          `Workspace files:\n${files.slice(0, 40).join("\n")}`,
        ].join("\n"),
      },
    ],
  });
  return result;
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

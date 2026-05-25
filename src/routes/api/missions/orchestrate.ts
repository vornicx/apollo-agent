import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import type { MissionEstimate } from "@/lib/mission-routing";
import { PERSONAS, type PersonaId } from "@/lib/personas";
import { recallForUser, formatMemoriesBlock } from "@/lib/memory.functions";
import { estimateMissionSemantic } from "@/lib/mission-routing";
import { callProviderText, getServerProviderKey } from "@/lib/ai-providers";

const DEFAULT_MAX_ITERATIONS = 3;

const bodySchema = z.object({
  missionId: z.string().uuid(),
  maxIterations: z.number().int().min(1).max(10).optional(),
});

export const Route = createFileRoute("/api/missions/orchestrate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const authHeader = request.headers.get("authorization");
          if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
          const token = authHeader.slice(7);

          const supabase = createClient<Database>(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_PUBLISHABLE_KEY!,
            {
              global: { headers: { Authorization: `Bearer ${token}` } },
              auth: { persistSession: false, autoRefreshToken: false },
            },
          );

          const { data: claims, error: authErr } = await supabase.auth.getClaims(token);
          if (authErr || !claims?.claims?.sub) return json({ error: "Unauthorized" }, 401);
          const userId = claims.claims.sub;

          const { missionId, maxIterations: maxIter } = bodySchema.parse(await request.json());
          const maxIterations = maxIter ?? DEFAULT_MAX_ITERATIONS;

          const { data: mission, error: mErr } = await supabase
            .from("missions")
            .select("id, title, goal")
            .eq("id", missionId)
            .single();
          if (mErr || !mission) return json({ error: "Mission not found" }, 404);

          const groqKey = process.env.GROQ_API_KEY ?? "";
          const estimate = await estimateMissionSemantic(mission.goal, groqKey);

          const recalledMems = await recallForUser(
            supabase,
            `${mission.title}\n${mission.goal}`,
            6,
          );
          const memBlock = formatMemoriesBlock(recalledMems);

          await supabase
            .from("missions")
            .update({ status: "running", current_phase: "planning" })
            .eq("id", missionId);

          const encoder = new TextEncoder();
          const emit = (
            controller: ReadableStreamDefaultController,
            data: Record<string, unknown>,
          ) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };

          const stream = new ReadableStream({
            async start(controller) {
              let feedback: { issues: string[]; fixes: string[] } | null = null;
              let approved = false;
              let lastScore = 0;
              let position = 0;

              try {
                for (let iteration = 1; iteration <= maxIterations; iteration++) {
                  emit(controller, { type: "iteration_start", iteration, max: maxIterations });

                  // ── PLANNER ────────────────────────────────────────────────
                  const plannerPersona = PERSONAS["planner"];
                  const plannerSys = memBlock
                    ? `${plannerPersona.systemPrompt}\n\n${memBlock}`
                    : plannerPersona.systemPrompt;
                  const plannerUser = buildPhasePrompt(
                    "planner",
                    mission.goal,
                    [],
                    estimate,
                    iteration > 1 ? feedback : null,
                  );

                  emit(controller, { type: "phase_start", phase: "planner", iteration });

                  const { id: plannerPhaseId } = await insertPhase(supabase, {
                    missionId,
                    userId,
                    persona: "planner",
                    phaseType: "planning",
                    provider: plannerPersona.defaultModel.provider,
                    model: plannerPersona.defaultModel.model,
                    input: plannerUser,
                    position: position++,
                    iteration,
                  });

                  const plannerKey = await resolveProviderKey(
                    supabase,
                    plannerPersona.defaultModel.provider,
                  );
                  const planOutput = await callProviderText(
                    plannerPersona.defaultModel.provider,
                    plannerPersona.defaultModel.model,
                    plannerKey,
                    [
                      { role: "system", content: plannerSys },
                      { role: "user", content: plannerUser },
                    ],
                  );

                  await completePhase(supabase, plannerPhaseId, planOutput);
                  emit(controller, {
                    type: "phase_complete",
                    phase: "planner",
                    iteration,
                    output: planOutput,
                  });

                  // ── IMPLEMENTER ────────────────────────────────────────────
                  const implPersona = PERSONAS["implementer"];
                  const implSys = memBlock
                    ? `${implPersona.systemPrompt}\n\n${memBlock}`
                    : implPersona.systemPrompt;
                  const implUser = buildPhasePrompt(
                    "implementer",
                    mission.goal,
                    [{ persona: "planner", output: planOutput }],
                    estimate,
                    null,
                  );

                  emit(controller, { type: "phase_start", phase: "implementer", iteration });

                  const { id: implPhaseId } = await insertPhase(supabase, {
                    missionId,
                    userId,
                    persona: "implementer",
                    phaseType: "implement",
                    provider: implPersona.defaultModel.provider,
                    model: implPersona.defaultModel.model,
                    input: implUser,
                    position: position++,
                    iteration,
                  });

                  await supabase
                    .from("missions")
                    .update({ current_phase: "implement" })
                    .eq("id", missionId);

                  const implKey = await resolveProviderKey(
                    supabase,
                    implPersona.defaultModel.provider,
                  );
                  const implOutput = await callProviderText(
                    implPersona.defaultModel.provider,
                    implPersona.defaultModel.model,
                    implKey,
                    [
                      { role: "system", content: implSys },
                      { role: "user", content: implUser },
                    ],
                  );

                  await completePhase(supabase, implPhaseId, implOutput);
                  emit(controller, {
                    type: "phase_complete",
                    phase: "implementer",
                    iteration,
                    output: implOutput,
                  });

                  // ── REVIEWER ───────────────────────────────────────────────
                  const reviewerPersona = PERSONAS["reviewer"];
                  const reviewerSys = memBlock
                    ? `${reviewerPersona.systemPrompt}\n\n${memBlock}`
                    : reviewerPersona.systemPrompt;
                  const reviewerUser = buildPhasePrompt(
                    "reviewer",
                    mission.goal,
                    [
                      { persona: "planner", output: planOutput },
                      { persona: "implementer", output: implOutput },
                    ],
                    estimate,
                    null,
                  );

                  emit(controller, { type: "phase_start", phase: "reviewer", iteration });

                  const { id: reviewerPhaseId } = await insertPhase(supabase, {
                    missionId,
                    userId,
                    persona: "reviewer",
                    phaseType: "review",
                    provider: reviewerPersona.defaultModel.provider,
                    model: reviewerPersona.defaultModel.model,
                    input: reviewerUser,
                    position: position++,
                    iteration,
                  });

                  await supabase
                    .from("missions")
                    .update({ current_phase: "review" })
                    .eq("id", missionId);

                  const reviewerKey = await resolveProviderKey(
                    supabase,
                    reviewerPersona.defaultModel.provider,
                  );
                  const reviewOutput = await callProviderText(
                    reviewerPersona.defaultModel.provider,
                    reviewerPersona.defaultModel.model,
                    reviewerKey,
                    [
                      { role: "system", content: reviewerSys },
                      { role: "user", content: reviewerUser },
                    ],
                  );

                  await completePhase(supabase, reviewerPhaseId, reviewOutput);
                  emit(controller, {
                    type: "phase_complete",
                    phase: "reviewer",
                    iteration,
                    output: reviewOutput,
                  });

                  const decision = parseReviewerDecision(reviewOutput);
                  lastScore = decision.score;

                  if (decision.approved) {
                    approved = true;
                    await supabase
                      .from("missions")
                      .update({ status: "completed", current_phase: "done" })
                      .eq("id", missionId);

                    await supabase.from("memories").insert({
                      user_id: userId,
                      content: `Orchestrated mission "${mission.title}" completed after ${iteration} iteration(s). Score: ${decision.score}/10`,
                      kind: "mission",
                      source: `mission:${missionId}`,
                      importance: 3,
                    });

                    emit(controller, { type: "approved", iteration, score: decision.score });
                    break;
                  }

                  feedback = { issues: decision.issues, fixes: decision.fixes };

                  if (iteration === maxIterations) {
                    await supabase
                      .from("missions")
                      .update({ status: "max_iterations_reached", current_phase: "done" })
                      .eq("id", missionId);
                    emit(controller, {
                      type: "max_iterations_reached",
                      iteration,
                      lastScore: decision.score,
                      issues: decision.issues,
                    });
                    break;
                  }

                  emit(controller, {
                    type: "rejected",
                    iteration,
                    score: decision.score,
                    issues: decision.issues,
                    fixes: decision.fixes,
                  });
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                emit(controller, { type: "error", message: msg });
                await supabase
                  .from("missions")
                  .update({ status: "failed" })
                  .eq("id", missionId);
              } finally {
                controller.close();
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Apollo-Max-Iterations": String(maxIterations),
              "X-Apollo-Complexity": estimate.complexity,
            },
          });
        } catch (err) {
          console.error("missions/orchestrate error", err);
          return json({ error: err instanceof Error ? err.message : "Unknown" }, 500);
        }
      },
    },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function resolveProviderKey(
  supabase: SupabaseClient<Database>,
  provider: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("api_keys")
    .select("api_key")
    .eq("provider", provider)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.api_key) return data.api_key;
  const serverKey = getServerProviderKey(provider);
  if (serverKey) return serverKey;
  throw new Error(
    `No API key configured for ${provider}. Add one in /keys or configure a server key.`,
  );
}

async function insertPhase(
  supabase: SupabaseClient<Database>,
  opts: {
    missionId: string;
    userId: string;
    persona: string;
    phaseType: string;
    provider: string;
    model: string;
    input: string;
    position: number;
    iteration: number;
  },
) {
  const { data, error } = await supabase
    .from("mission_phases")
    .insert({
      mission_id: opts.missionId,
      user_id: opts.userId,
      phase_type: opts.phaseType,
      persona: opts.persona,
      provider: opts.provider,
      model: opts.model,
      input: opts.input,
      status: "running",
      position: opts.position,
      iteration: opts.iteration,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "phase insert failed");
  return data;
}

async function completePhase(
  supabase: SupabaseClient<Database>,
  phaseId: string,
  output: string,
) {
  await supabase
    .from("mission_phases")
    .update({
      output,
      status: output.trim() ? "completed" : "failed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", phaseId);
}

function parseReviewerDecision(text: string): {
  approved: boolean;
  score: number;
  issues: string[];
  fixes: string[];
} {
  const approvedMatch = text.match(/APPROVED\s*:\s*(yes|no)/i);
  const scoreMatch = text.match(/QUALITY SCORE\s*:\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/i);

  const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
  const approvedByText = approvedMatch
    ? approvedMatch[1].toLowerCase() === "yes"
    : false;
  const approved = approvedByText || score >= 7;

  const issuesMatch = text.match(/ISSUES FOUND\s*:([\s\S]*?)(?=FIXES\s*:|APPROVED\s*:|$)/i);
  const fixesMatch = text.match(/FIXES\s*:([\s\S]*?)(?=APPROVED\s*:|$)/i);

  const parseLines = (block: string | undefined): string[] =>
    (block ?? "")
      .trim()
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length > 0 && !/^none$/i.test(l));

  return {
    approved,
    score,
    issues: parseLines(issuesMatch?.[1]),
    fixes: parseLines(fixesMatch?.[1]),
  };
}

function buildPhasePrompt(
  personaId: PersonaId,
  goal: string,
  prior: { persona: string; output: string }[],
  estimate: MissionEstimate,
  feedback: { issues: string[]; fixes: string[] } | null,
): string {
  const ctx = prior
    .map(
      (p) =>
        `### Previous ${PERSONAS[p.persona as PersonaId]?.name ?? p.persona} output\n${p.output}`,
    )
    .join("\n\n");

  const routerNote =
    estimate.via === "semantic" && estimate.intent
      ? `- Intent detected: ${estimate.intent}\n- Router: semantic (Groq)\n`
      : `- Router: keyword fallback\n`;

  const base = `# Mission goal
${goal}

# Runtime estimate
- Complexity: ${estimate.complexity}
- Route: ${estimate.route}
- Agents: ${estimate.agents.join(", ")}
- Expected budget: ${estimate.budget}
- Starting confidence: ${Math.round(estimate.confidence * 100)}%
- Risk: ${estimate.risk}
${routerNote}
${ctx ? ctx + "\n\n" : ""}`;

  const feedbackBlock =
    feedback && feedback.issues.length > 0
      ? [
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
          "",
        ].join("\n")
      : "";

  if (personaId === "planner") {
    return (
      base +
      feedbackBlock +
      "Produce a mission plan. Include objective, complexity, confidence, execution strategy, recommended agents, risk assessment and success criteria."
    );
  }
  if (personaId === "implementer") {
    return (
      base +
      "Execute the Planner output. Produce concrete deliverables and state assumptions, confidence and next actions."
    );
  }
  return (
    base +
    "Review the Implementer's output against the Planner's plan and original goal. Include quality score, confidence, issues, fixes and APPROVED yes/no."
  );
}

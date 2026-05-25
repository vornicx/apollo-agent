import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { PERSONAS, type PersonaId } from "@/lib/personas";
import { recallForUser, formatMemoriesBlock } from "@/lib/memory.functions";
import { estimateMission } from "@/lib/mission-routing";
import { callProviderText, getServerProviderKey, type ChatMessage } from "@/lib/ai-providers";
import { DEFAULT_MODEL, DEFAULT_PROVIDER_ID } from "@/lib/providers";

export const listMissions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("missions")
      .select("id, title, goal, status, current_phase, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createMission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        title: z.string().min(1).max(120).optional(),
        goal: z.string().min(5).max(8000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const title = (data.title?.trim() || data.goal.slice(0, 60)).slice(0, 120);
    const { data: mission, error } = await supabase
      .from("missions")
      .insert({ user_id: userId, title, goal: data.goal, status: "draft" })
      .select("id, title, goal, status, current_phase, updated_at, created_at")
      .single();
    if (error) throw new Error(error.message);
    // Remember the mission goal so Apollo can recall it later
    await supabase.from("memories").insert({
      user_id: userId,
      content: `Mission "${title}": ${data.goal}`,
      kind: "mission",
      source: `mission:${mission.id}`,
      importance: 3,
    });
    return mission;
  });

export const getMission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const [{ data: mission, error: e1 }, { data: phases, error: e2 }] = await Promise.all([
      supabase
        .from("missions")
        .select("id, title, goal, status, current_phase, updated_at, created_at")
        .eq("id", data.id)
        .single(),
      supabase
        .from("mission_phases")
        .select(
          "id, phase_type, persona, provider, model, input, output, status, position, created_at, completed_at",
        )
        .eq("mission_id", data.id)
        .order("position", { ascending: true }),
    ]);
    if (e1) throw new Error(e1.message);
    if (e2) throw new Error(e2.message);
    return { mission, phases: phases ?? [] };
  });

export const deleteMission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("missions").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Edit a completed phase's output (human-in-the-loop). */
export const updatePhaseOutput = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        phaseId: z.string().uuid(),
        output: z.string().max(200_000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("mission_phases")
      .update({ output: data.output, status: "completed" })
      .eq("id", data.phaseId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Promote a chat conversation into a mission. Uses an LLM to extract a clean goal. */
export const promoteConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: msgs, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", data.conversationId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    if (!msgs || msgs.length === 0) throw new Error("Conversation is empty");

    const transcript = msgs
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n")
      .slice(0, 12_000);

    const { title, goal } = await extractGoal(transcript);

    const { data: mission, error: mErr } = await supabase
      .from("missions")
      .insert({ user_id: userId, title, goal, status: "draft" })
      .select("id")
      .single();
    if (mErr || !mission) throw new Error(mErr?.message ?? "Could not create mission");
    return { id: mission.id };
  });

async function extractGoal(transcript: string): Promise<{ title: string; goal: string }> {
  const provider = process.env.APOLLO_EXTRACT_PROVIDER ?? DEFAULT_PROVIDER_ID;
  const model = process.env.APOLLO_EXTRACT_MODEL ?? DEFAULT_MODEL;
  const apiKey = getServerProviderKey(provider);
  if (!apiKey) throw new Error(`${provider.toUpperCase()} API key is not configured`);
  const output = await callProviderText(provider, model, apiKey, [
    {
      role: "system",
      content:
        "Extract a concise mission goal from a conversation. Return only JSON with keys title and goal. Goal must be actionable, self-contained and include relevant context. Title 6 words max.",
    },
    { role: "user", content: transcript },
  ]);
  const parsed = JSON.parse(extractJson(output)) as { title?: string; goal?: string };
  return {
    title: (parsed.title ?? "Promoted mission").slice(0, 120),
    goal: parsed.goal ?? transcript.slice(0, 2000),
  };
}

/** Run a single persona phase via direct provider APIs. */
export const runPhase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        missionId: z.string().uuid(),
        persona: z.enum(["planner", "implementer", "reviewer"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const personaId = data.persona as PersonaId;
    const persona = PERSONAS[personaId];

    const { data: mission, error: mErr } = await supabase
      .from("missions")
      .select("id, goal, title")
      .eq("id", data.missionId)
      .single();
    if (mErr || !mission) throw new Error(mErr?.message ?? "Mission not found");

    const { data: priorPhases } = await supabase
      .from("mission_phases")
      .select("phase_type, persona, output, position")
      .eq("mission_id", data.missionId)
      .order("position", { ascending: true });

    const position = priorPhases?.length ?? 0;
    const phaseType =
      personaId === "planner" ? "planning" : personaId === "implementer" ? "implement" : "review";

    // Recall relevant memories and prepend to the persona system prompt
    const mems = await recallForUser(supabase, `${mission.title}\n${mission.goal}`, 6);
    const memBlock = formatMemoriesBlock(mems);
    const systemPrompt = memBlock ? `${persona.systemPrompt}\n\n${memBlock}` : persona.systemPrompt;

    // Build the user prompt for this phase
    const userPrompt = buildPhasePrompt(personaId, mission.goal, priorPhases ?? []);

    const { data: phaseRow, error: insErr } = await supabase
      .from("mission_phases")
      .insert({
        mission_id: data.missionId,
        user_id: userId,
        phase_type: phaseType,
        persona: personaId,
        provider: persona.defaultModel.provider,
        model: persona.defaultModel.model,
        input: userPrompt,
        status: "running",
        position,
      })
      .select("id")
      .single();
    if (insErr || !phaseRow) throw new Error(insErr?.message ?? "Could not create phase");

    await supabase
      .from("missions")
      .update({ status: "running", current_phase: phaseType })
      .eq("id", data.missionId);

    try {
      const apiKey = await resolveProviderKey(supabase, persona.defaultModel.provider);
      const output = await callApolloAI(
        persona.defaultModel.provider,
        persona.defaultModel.model,
        apiKey,
        systemPrompt,
        userPrompt,
      );

      await supabase
        .from("mission_phases")
        .update({ output, status: "completed", completed_at: new Date().toISOString() })
        .eq("id", phaseRow.id);

      // Remember the phase output
      await supabase.from("memories").insert({
        user_id: userId,
        content: `${persona.name} for "${mission.title}": ${output.slice(0, 8000)}`,
        kind: "mission",
        source: `mission:${data.missionId}`,
        importance: 2,
      });

      // Update mission overall status
      const isLast = personaId === "reviewer";
      await supabase
        .from("missions")
        .update({
          status: isLast ? "completed" : "running",
          current_phase: isLast ? "done" : phaseType,
        })
        .eq("id", data.missionId);

      return { ok: true, phaseId: phaseRow.id, output };
    } catch (err) {
      await supabase
        .from("mission_phases")
        .update({
          output: err instanceof Error ? err.message : String(err),
          status: "failed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", phaseRow.id);
      await supabase.from("missions").update({ status: "failed" }).eq("id", data.missionId);
      throw err;
    }
  });

function buildPhasePrompt(
  personaId: PersonaId,
  goal: string,
  prior: { persona: string; output: string }[],
): string {
  const estimate = estimateMission(goal);
  const ctx = prior
    .map(
      (p) =>
        `### Previous ${PERSONAS[p.persona as PersonaId]?.name ?? p.persona} output\n${p.output}`,
    )
    .join("\n\n");

  const base = `# Mission goal
${goal}

# Runtime estimate
- Complexity: ${estimate.complexity}
- Route: ${estimate.route}
- Agents: ${estimate.agents.join(", ")}
- Expected budget: ${estimate.budget}
- Starting confidence: ${Math.round(estimate.confidence * 100)}%
- Risk: ${estimate.risk}

${ctx ? ctx + "\n\n" : ""}`;
  if (personaId === "planner") {
    return (
      base +
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

async function callApolloAI(
  provider: string,
  model: string,
  apiKey: string,
  system: string,
  user: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return callProviderText(provider, model, apiKey, messages);
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Goal extraction returned no JSON");
  return match[0];
}

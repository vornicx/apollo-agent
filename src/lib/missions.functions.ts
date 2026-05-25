import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { PERSONAS, type PersonaId } from "@/lib/personas";
import { recallForUser, formatMemoriesBlock } from "@/lib/memory.functions";

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
    z.object({
      title: z.string().min(1).max(120).optional(),
      goal: z.string().min(5).max(8000),
    }).parse(input),
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
        .select("id, phase_type, persona, provider, model, input, output, status, position, created_at, completed_at")
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
    z.object({
      phaseId: z.string().uuid(),
      output: z.string().max(200_000),
    }).parse(input),
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
  .inputValidator((input: unknown) =>
    z.object({ conversationId: z.string().uuid() }).parse(input),
  )
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
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content:
            "Extract a concise mission goal from a conversation. Goal must be actionable, self-contained, include relevant context. Title 6 words max.",
        },
        { role: "user", content: transcript },
      ],
      tools: [{
        type: "function",
        function: {
          name: "create_mission",
          description: "Create a mission from the conversation.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              goal: { type: "string" },
            },
            required: ["title", "goal"],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "create_mission" } },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Goal extraction failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
  };
  const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error("Goal extraction returned no result");
  const parsed = JSON.parse(args) as { title?: string; goal?: string };
  return {
    title: (parsed.title ?? "Promoted mission").slice(0, 120),
    goal: parsed.goal ?? transcript.slice(0, 2000),
  };
}

/** Run a single persona phase via the Lovable AI Gateway. */
export const runPhase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      missionId: z.string().uuid(),
      persona: z.enum(["planner", "implementer", "reviewer"]),
    }).parse(input),
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

    const position = (priorPhases?.length ?? 0);
    const phaseType =
      personaId === "planner" ? "planning" : personaId === "implementer" ? "implement" : "review";

    // Recall relevant memories and prepend to the persona system prompt
    const mems = await recallForUser(supabase, `${mission.title}\n${mission.goal}`, 6);
    const memBlock = formatMemoriesBlock(mems);
    const systemPrompt = memBlock
      ? `${persona.systemPrompt}\n\n${memBlock}`
      : persona.systemPrompt;

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
      const output = await callLovableAI(persona.defaultModel.model, systemPrompt, userPrompt);

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
  const ctx = prior
    .map((p) => `### Previous ${PERSONAS[p.persona as PersonaId]?.name ?? p.persona} output\n${p.output}`)
    .join("\n\n");

  const base = `# Mission goal\n${goal}\n\n${ctx ? ctx + "\n\n" : ""}`;
  if (personaId === "planner") {
    return base + "Produce a multi-phase plan to achieve the goal. Use the response structure your role prescribes.";
  }
  if (personaId === "implementer") {
    return base + "Implement the plan from the Planner. Show test-first code and the implementation that makes the tests pass.";
  }
  return base + "Review the Implementer's output against the Planner's plan and the original goal. Reply with the structured review your role prescribes.";
}

async function callLovableAI(model: string, system: string, user: string): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Lovable AI error (${res.status}): ${txt.slice(0, 500)}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}


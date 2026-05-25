import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import type { MissionEstimate } from "@/lib/mission-routing";
import { PERSONAS, type PersonaId } from "@/lib/personas";
import { recallForUser, formatMemoriesBlock } from "@/lib/memory.functions";
import { estimateMissionSemantic } from "@/lib/mission-routing";
import { callProviderStream, getServerProviderKey, makeSSEParser } from "@/lib/ai-providers";

const bodySchema = z.object({
  missionId: z.string().uuid(),
  persona: z.enum(["planner", "implementer", "reviewer"]),
});

export const Route = createFileRoute("/api/missions/stream")({
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

          const { missionId, persona: personaId } = bodySchema.parse(await request.json());
          const persona = PERSONAS[personaId as PersonaId];

          const { data: mission, error: mErr } = await supabase
            .from("missions")
            .select("id, title, goal")
            .eq("id", missionId)
            .single();
          if (mErr || !mission) return json({ error: "Mission not found" }, 404);

          const { data: priorPhases } = await supabase
            .from("mission_phases")
            .select("persona, output, position")
            .eq("mission_id", missionId)
            .order("position", { ascending: true });

          const position = priorPhases?.length ?? 0;
          const phaseType =
            personaId === "planner"
              ? "planning"
              : personaId === "implementer"
                ? "implement"
                : "review";

          // ── ROUTER SEMÁNTICO (reemplaza estimateMission síncrono) ──────────
          const groqKey = process.env.GROQ_API_KEY ?? "";
          const estimate = await estimateMissionSemantic(mission.goal, groqKey);
          // ──────────────────────────────────────────────────────────────────

          const userPrompt = buildPhasePrompt(personaId, mission.goal, priorPhases ?? [], estimate);

          const recalledMems = await recallForUser(
            supabase,
            `${mission.title}\n${mission.goal}`,
            6,
          );
          const memBlock = formatMemoriesBlock(recalledMems);
          const sysPrompt = memBlock
            ? `${persona.systemPrompt}\n\n${memBlock}`
            : persona.systemPrompt;

          const { data: phaseRow, error: insErr } = await supabase
            .from("mission_phases")
            .insert({
              mission_id: missionId,
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
          if (insErr || !phaseRow)
            return json({ error: insErr?.message ?? "phase insert failed" }, 500);

          await supabase
            .from("missions")
            .update({ status: "running", current_phase: phaseType })
            .eq("id", missionId);

          const apiKey = await resolveProviderKey(supabase, persona.defaultModel.provider);
          const upstream = await callProviderStream(
            persona.defaultModel.provider,
            persona.defaultModel.model,
            apiKey,
            [
              { role: "system", content: sysPrompt },
              { role: "user", content: userPrompt },
            ],
          );

          if (!upstream.ok || !upstream.body) {
            const txt = await upstream.text().catch(() => "");
            await supabase
              .from("mission_phases")
              .update({
                status: "failed",
                output: `Provider error (${upstream.status}): ${txt.slice(0, 500)}`,
                completed_at: new Date().toISOString(),
              })
              .eq("id", phaseRow.id);
            return json({ error: `Provider error (${upstream.status})` }, 502);
          }

          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let assistantText = "";

          const stream = new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              const parser = makeSSEParser(persona.defaultModel.provider);
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  let idx: number;
                  while ((idx = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, idx).replace(/\r$/, "");
                    buffer = buffer.slice(idx + 1);
                    const text = parser(line);
                    if (text) {
                      assistantText += text;
                      controller.enqueue(encoder.encode(text));
                    }
                  }
                }
                const tail = parser(buffer);
                if (tail) {
                  assistantText += tail;
                  controller.enqueue(encoder.encode(tail));
                }
                const isLast = personaId === "reviewer";
                await supabase
                  .from("mission_phases")
                  .update({
                    output: assistantText,
                    status: assistantText.trim() ? "completed" : "failed",
                    completed_at: new Date().toISOString(),
                  })
                  .eq("id", phaseRow.id);
                await supabase
                  .from("missions")
                  .update({
                    status: isLast ? "completed" : "running",
                    current_phase: isLast ? "done" : phaseType,
                  })
                  .eq("id", missionId);

                if (assistantText.trim()) {
                  await supabase.from("memories").insert({
                    user_id: userId,
                    content: `${persona.name} for "${mission.title}": ${assistantText.slice(0, 8000)}`,
                    kind: "mission",
                    source: `mission:${missionId}`,
                    importance: 2,
                  });
                }
              } catch (err) {
                controller.enqueue(
                  encoder.encode(
                    `\n\n[stream error: ${err instanceof Error ? err.message : String(err)}]`,
                  ),
                );
                await supabase
                  .from("mission_phases")
                  .update({
                    output: assistantText + `\n[stream error]`,
                    status: "failed",
                    completed_at: new Date().toISOString(),
                  })
                  .eq("id", phaseRow.id);
              } finally {
                controller.close();
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Phase-Id": phaseRow.id,
              // Header extra: tier detectado por el router semántico
              "X-Apollo-Complexity": estimate.complexity,
              "X-Apollo-Router": estimate.via ?? "keywords",
            },
          });
        } catch (err) {
          console.error("missions/stream error", err);
          return json({ error: err instanceof Error ? err.message : "Unknown" }, 500);
        }
      },
    },
  },
});

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

function buildPhasePrompt(
  personaId: PersonaId,
  goal: string,
  prior: { persona: string; output: string }[],
  estimate: MissionEstimate,
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

  if (personaId === "planner") {
    return (
      base +
      "Produce a mission plan. Include objective, complexity, confidence, execution strategy, recommended agents, risk assessment and success criteria."
    );
  }
  if (personaId === "implementer")
    return (
      base +
      "Execute the Planner output. Produce concrete deliverables and state assumptions, confidence and next actions."
    );
  return (
    base +
    "Review the Implementer's output against the Planner's plan and original goal. Include quality score, confidence, issues, fixes and APPROVED yes/no."
  );
}

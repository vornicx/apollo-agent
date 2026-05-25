import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { recallForUser, formatMemoriesBlock } from "@/lib/memory.functions";
import { APOLLO_BASE_PROMPT, DEFAULT_VOICE_ID, DEFAULT_FIRST_MESSAGE } from "@/lib/voice/persona";
import { CLIENT_TOOLS_SCHEMA } from "@/lib/voice/tools-schema";

export const Route = createFileRoute("/api/voice/token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = request.headers.get("authorization");
          if (!auth?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
          const token = auth.slice(7);

          const apiKey = process.env.ELEVENLABS_API_KEY;
          if (!apiKey) return json({ error: "ELEVENLABS_API_KEY not configured" }, 500);

          const SUPABASE_URL = process.env.SUPABASE_URL!;
          const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
          const supabase = createClient<Database>(SUPABASE_URL, PUB_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: claims, error: authErr } = await supabase.auth.getClaims(token);
          if (authErr || !claims?.claims?.sub) return json({ error: "Unauthorized" }, 401);
          const userId = claims.claims.sub;

          // Load (or create) the user's voice agent.
          const { data: profile } = await supabase
            .from("profiles")
            .select("voice_agent_id, display_name")
            .eq("id", userId)
            .single();

          let agentId = profile?.voice_agent_id ?? null;
          if (!agentId) {
            agentId = await createApolloAgent(apiKey, profile?.display_name ?? "User");
            await supabase.from("profiles").update({ voice_agent_id: agentId }).eq("id", userId);
          }

          // Build dynamic system prompt: base + persona-rules memories + recent context memories.
          const [personaRules, contextMems] = await Promise.all([
            supabase
              .from("memories")
              .select("content")
              .eq("kind", "preference")
              .order("importance", { ascending: false })
              .order("created_at", { ascending: false })
              .limit(20),
            recallForUser(supabase, "user identity recent conversation", 6),
          ]);

          const personaBlock = personaRules.data && personaRules.data.length > 0
            ? `\n\n# Standing user preferences\n${personaRules.data.map((r) => `- ${r.content}`).join("\n")}`
            : "";
          const memBlock = contextMems.length > 0
            ? `\n\n${formatMemoriesBlock(contextMems)}`
            : "";
          const displayName = profile?.display_name ? `\n\nThe user's name is ${profile.display_name}.` : "";

          const fullPrompt = `${APOLLO_BASE_PROMPT}${displayName}${personaBlock}${memBlock}`;

          // Mint conversation token + return overrides for the client to apply.
          const tokenRes = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
            { headers: { "xi-api-key": apiKey } },
          );
          if (!tokenRes.ok) {
            const txt = await tokenRes.text();
            return json({ error: `ElevenLabs token error: ${txt.slice(0, 400)}` }, 502);
          }
          const { token: convToken } = (await tokenRes.json()) as { token: string };

          return json({
            token: convToken,
            agentId,
            overrides: {
              agent: {
                prompt: { prompt: fullPrompt },
                firstMessage: DEFAULT_FIRST_MESSAGE,
                language: "en",
              },
            },
          });
        } catch (err) {
          console.error("voice/token error", err);
          return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
        }
      },
    },
  },
});

async function createApolloAgent(apiKey: string, displayName: string): Promise<string> {
  const body = {
    name: `APOLLO for ${displayName}`,
    conversation_config: {
      agent: {
        prompt: {
          prompt: APOLLO_BASE_PROMPT,
          llm: "gemini-2.5-flash",
          tools: CLIENT_TOOLS_SCHEMA.map((t) => ({
            type: "client",
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
        first_message: DEFAULT_FIRST_MESSAGE,
        language: "en",
      },
      tts: { voice_id: DEFAULT_VOICE_ID, model_id: "eleven_turbo_v2_5" },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: {
            prompt: { prompt: true },
            first_message: true,
            language: true,
          },
        },
      },
    },
  };
  const res = await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`agent create failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as { agent_id: string };
  return data.agent_id;
}

function json(d: unknown, status = 200) {
  return new Response(JSON.stringify(d), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

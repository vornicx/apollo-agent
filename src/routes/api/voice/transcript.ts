import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

const turnSchema = z.object({
  role: z.enum(["user", "agent"]),
  text: z.string().min(1).max(20_000),
  at: z.string().optional(),
});

const bodySchema = z.object({
  sessionId: z.string().uuid().optional(),
  turns: z.array(turnSchema).min(1).max(50),
  ended: z.boolean().optional(),
});

export const Route = createFileRoute("/api/voice/transcript")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = request.headers.get("authorization");
          if (!auth?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
          const token = auth.slice(7);

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

          const parsed = bodySchema.parse(await request.json());

          // Upsert / create session
          let sessionId = parsed.sessionId;
          if (!sessionId) {
            const { data: created, error: cErr } = await supabase
              .from("voice_sessions")
              .insert({
                user_id: userId,
                transcript: parsed.turns as never,
                turn_count: parsed.turns.length,
                ended_at: parsed.ended ? new Date().toISOString() : null,
              })
              .select("id")
              .single();
            if (cErr) return json({ error: cErr.message }, 500);
            sessionId = created.id;
          } else {
            const { data: existing } = await supabase
              .from("voice_sessions")
              .select("transcript, turn_count")
              .eq("id", sessionId)
              .single();
            const prev = (existing?.transcript ?? []) as unknown[];
            const merged = [...prev, ...parsed.turns];
            await supabase
              .from("voice_sessions")
              .update({
                transcript: merged as never,
                turn_count: merged.length,
                ended_at: parsed.ended ? new Date().toISOString() : null,
              })
              .eq("id", sessionId);
          }

          // Mirror turns into memory (kind=chat, source=voice:<sessionId>)
          await supabase.from("memories").insert(
            parsed.turns.map((t) => ({
              user_id: userId,
              content: t.role === "user" ? `User said (voice): ${t.text}` : `Apollo replied (voice): ${t.text.slice(0, 4000)}`,
              kind: "chat" as const,
              source: `voice:${sessionId}`,
            })),
          );

          return json({ sessionId });
        } catch (err) {
          console.error("voice/transcript error", err);
          return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
        }
      },
    },
  },
});

function json(d: unknown, status = 200) {
  return new Response(JSON.stringify(d), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { recallForUser } from "@/lib/memory.functions";

const bodySchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(20).optional(),
});

export const Route = createFileRoute("/api/voice/recall")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        if (!auth?.startsWith("Bearer ")) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
        }
        const token = auth.slice(7);
        const supabase = createClient<Database>(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          },
        );
        const { data: claims, error } = await supabase.auth.getClaims(token);
        if (error || !claims?.claims?.sub) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
        }
        const { query, limit } = bodySchema.parse(await request.json());
        const memories = await recallForUser(supabase, query, limit ?? 6);
        return new Response(JSON.stringify({ memories }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});

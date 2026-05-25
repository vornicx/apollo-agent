import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const upsertSchema = z.object({
  provider: z.string().min(1).max(64),
  label: z.string().max(80).default(""),
  api_key: z.string().min(1).max(2000),
});

export const listApiKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, provider, label, created_at, updated_at, api_key")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    // Return masked keys to client (never the raw value)
    return (data ?? []).map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      created_at: k.created_at,
      updated_at: k.updated_at,
      masked: maskKey(k.api_key),
    }));
  });

export const upsertApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => upsertSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Upsert: one row per (user, provider, label)
    const { error } = await supabase.from("api_keys").insert({
      user_id: userId,
      provider: data.provider,
      label: data.label,
      api_key: data.api_key,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase.from("api_keys").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

function maskKey(k: string): string {
  if (k.length <= 8) return "•".repeat(k.length);
  return k.slice(0, 4) + "•".repeat(Math.max(4, k.length - 8)) + k.slice(-4);
}

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listVoiceSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("voice_sessions")
      .select("id, started_at, ended_at, turn_count")
      .order("started_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getVoiceSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("voice_sessions")
      .select("id, started_at, ended_at, turn_count, transcript")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteVoiceSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("voice_sessions").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Reset the user's ElevenLabs agent (used when persona is reconfigured). */
export const resetVoiceAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("profiles")
      .update({ voice_agent_id: null })
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

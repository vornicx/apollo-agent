import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, provider, model, updated_at")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      provider: z.string().min(1).max(64),
      model: z.string().min(1).max(128),
      title: z.string().max(120).optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: conv, error } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        provider: data.provider,
        model: data.model,
        title: data.title ?? "New chat",
      })
      .select("id, title, provider, model, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return conv;
  });

export const getConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const [{ data: conv, error: e1 }, { data: msgs, error: e2 }] = await Promise.all([
      supabase
        .from("conversations")
        .select("id, title, provider, model, updated_at")
        .eq("id", data.id)
        .single(),
      supabase
        .from("messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", data.id)
        .order("created_at", { ascending: true }),
    ]);
    if (e1) throw new Error(e1.message);
    if (e2) throw new Error(e2.message);
    return { conversation: conv, messages: msgs ?? [] };
  });

export const updateConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      id: z.string().uuid(),
      title: z.string().max(120).optional(),
      provider: z.string().max(64).optional(),
      model: z.string().max(128).optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { id, ...patch } = data;
    const { error } = await supabase.from("conversations").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase.from("conversations").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

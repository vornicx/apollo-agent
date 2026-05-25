import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export type MemoryKind = "note" | "chat" | "mission" | "fact" | "preference";

/** Sanitise free-form text into a websearch_to_tsquery-safe query. */
function toFtsQuery(input: string): string {
  return input
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 12)
    .join(" ");
}

/** Internal: recall top memories for a user. Used by chat + missions. */
export async function recallForUser(
  supabase: SupabaseClient<Database>,
  query: string,
  limit = 6,
): Promise<{ id: string; content: string; kind: string; created_at: string }[]> {
  const q = toFtsQuery(query);
  if (q) {
    const { data } = await supabase
      .from("memories")
      .select("id, content, kind, created_at")
      .textSearch("content_tsv", q, { type: "websearch", config: "simple" })
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (data && data.length > 0) return data;
  }
  // Fallback: most recent memories
  const { data } = await supabase
    .from("memories")
    .select("id, content, kind, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

/** Render recalled memories as a system-prompt block. */
export function formatMemoriesBlock(
  mems: { content: string; kind: string; created_at: string }[],
): string {
  if (mems.length === 0) return "";
  const lines = mems.map((m) => {
    const date = new Date(m.created_at).toISOString().slice(0, 10);
    return `- [${m.kind} · ${date}] ${m.content.replace(/\s+/g, " ").trim().slice(0, 600)}`;
  });
  return [
    "# Apollo memory",
    "Relevant things you remember about this user. Use them silently to stay consistent. Do not list them back unless asked.",
    ...lines,
  ].join("\n");
}

/** Public list, optionally filtered by search query. */
export const listMemories = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        query: z.string().max(500).optional(),
        kind: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase
      .from("memories")
      .select("id, content, kind, source, importance, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 100);
    if (data.kind) q = q.eq("kind", data.kind);
    if (data.query && data.query.trim()) {
      const fts = toFtsQuery(data.query);
      if (fts) q = q.textSearch("content_tsv", fts, { type: "websearch", config: "simple" });
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const rememberMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        content: z.string().min(1).max(20_000),
        kind: z.enum(["note", "chat", "mission", "fact", "preference"]).optional(),
        source: z.string().max(200).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("memories")
      .insert({
        user_id: userId,
        content: data.content,
        kind: data.kind ?? "note",
        source: data.source ?? null,
        importance: data.importance ?? 1,
        metadata: (data.metadata ?? {}) as never,
      })
      .select("id, content, kind, source, importance, created_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        content: z.string().min(1).max(20_000).optional(),
        importance: z.number().int().min(1).max(5).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: { content?: string; importance?: number } = {};
    if (data.content !== undefined) patch.content = data.content;
    if (data.importance !== undefined) patch.importance = data.importance;
    const { error } = await context.supabase.from("memories").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const forgetMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("memories").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const forgetAllMemories = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("memories")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Recall via server fn (for clients). */
export const recallMemories = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        query: z.string().min(1).max(2_000),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    return recallForUser(context.supabase, data.query, data.limit ?? 6);
  });

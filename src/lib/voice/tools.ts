import { toast } from "sonner";
import type { NavigateFn } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

type ToolCtx = {
  navigate: NavigateFn;
};

type ToolResult = string;

async function authedFetch(path: string, body: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function buildClientTools(ctx: ToolCtx) {
  return {
    navigate_to: async ({ route }: { route: string }): Promise<ToolResult> => {
      try {
        await ctx.navigate({ to: route });
        return `Navigated to ${route}`;
      } catch (e) {
        return `Could not navigate: ${(e as Error).message}`;
      }
    },

    create_mission: async ({ title, goal }: { title: string; goal: string }): Promise<ToolResult> => {
      const { data: userResp } = await supabase.auth.getUser();
      const uid = userResp.user?.id;
      if (!uid) return "Not authenticated";
      const { data, error } = await supabase
        .from("missions")
        .insert({ user_id: uid, title, goal, status: "draft" })
        .select("id")
        .single();
      if (error) return `Failed to create mission: ${error.message}`;
      toast.success(`Mission created: ${title}`);
      return `Created mission ${data.id}`;
    },

    recall: async ({ query, limit }: { query: string; limit?: number }): Promise<ToolResult> => {
      const res = await authedFetch("/api/voice/recall", { query, limit: limit ?? 6 });
      if (!res.ok) return `Recall failed: ${res.status}`;
      const data = (await res.json()) as { memories: { content: string; kind: string }[] };
      if (data.memories.length === 0) return "No relevant memories.";
      return data.memories.map((m) => `[${m.kind}] ${m.content}`).join("\n");
    },

    remember: async ({ content, kind }: { content: string; kind?: string }): Promise<ToolResult> => {
      const { data: userResp } = await supabase.auth.getUser();
      const uid = userResp.user?.id;
      if (!uid) return "Not authenticated";
      const { error } = await supabase.from("memories").insert({
        user_id: uid,
        content,
        kind: (kind as "note" | "fact" | "preference" | undefined) ?? "note",
        source: "voice",
      });
      if (error) return `Failed: ${error.message}`;
      return "Remembered.";
    },

    update_self_personality: async ({ rule }: { rule: string }): Promise<ToolResult> => {
      const { data: userResp } = await supabase.auth.getUser();
      const uid = userResp.user?.id;
      if (!uid) return "Not authenticated";
      const { error } = await supabase.from("memories").insert({
        user_id: uid,
        content: rule,
        kind: "preference",
        source: "voice:persona",
        importance: 5,
      });
      if (error) return `Failed: ${error.message}`;
      toast.success("APOLLO updated its persona");
      return "Persona updated. It will persist across sessions.";
    },

    copy_to_clipboard: async ({ text }: { text: string }): Promise<ToolResult> => {
      try {
        await navigator.clipboard.writeText(text);
        return "Copied to clipboard.";
      } catch (e) {
        return `Clipboard blocked: ${(e as Error).message}`;
      }
    },

    notify: async ({ title, body }: { title: string; body?: string }): Promise<ToolResult> => {
      if (!("Notification" in window)) return "Notifications not supported.";
      if (Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") return "Permission denied.";
      }
      new Notification(title, { body });
      return "Notification sent.";
    },

    open_url: ({ url, new_tab }: { url: string; new_tab?: boolean }): ToolResult => {
      try {
        const u = new URL(url);
        if (new_tab === false) window.location.href = u.toString();
        else window.open(u.toString(), "_blank", "noopener,noreferrer");
        return `Opened ${u.host}`;
      } catch {
        return "Invalid URL.";
      }
    },

    show_toast: ({ message, kind }: { message: string; kind?: string }): ToolResult => {
      if (kind === "error") toast.error(message);
      else if (kind === "success") toast.success(message);
      else toast(message);
      return "Shown.";
    },

    get_current_context: (): ToolResult => {
      const now = new Date();
      const ctx = {
        route: window.location.pathname,
        title: document.title,
        local_time: now.toLocaleString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: navigator.language,
      };
      return JSON.stringify(ctx);
    },
  };
}

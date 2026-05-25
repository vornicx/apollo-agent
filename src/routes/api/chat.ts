import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { recallForUser, formatMemoriesBlock } from "@/lib/memory.functions";

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().min(1).max(50_000),
});

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const authHeader = request.headers.get("authorization");
          if (!authHeader?.startsWith("Bearer ")) {
            return json({ error: "Unauthorized" }, 401);
          }
          const token = authHeader.slice(7);

          const SUPABASE_URL = process.env.SUPABASE_URL!;
          const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
          const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          });

          const { data: claims, error: authErr } = await supabase.auth.getClaims(token);
          if (authErr || !claims?.claims?.sub) return json({ error: "Unauthorized" }, 401);
          const userId = claims.claims.sub;

          const raw = await request.json();
          const { conversationId, message } = bodySchema.parse(raw);

          // Load conversation + history
          const [{ data: conv, error: e1 }, { data: history, error: e2 }] = await Promise.all([
            supabase
              .from("conversations")
              .select("id, provider, model, title")
              .eq("id", conversationId)
              .single(),
            supabase
              .from("messages")
              .select("role, content")
              .eq("conversation_id", conversationId)
              .order("created_at", { ascending: true }),
          ]);
          if (e1 || !conv) return json({ error: "Conversation not found" }, 404);
          if (e2) return json({ error: e2.message }, 500);

          // Fetch user's API key for this provider (most recent)
          const { data: keyRow, error: keyErr } = await supabase
            .from("api_keys")
            .select("api_key")
            .eq("provider", conv.provider)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (keyErr) return json({ error: keyErr.message }, 500);
          if (!keyRow) {
            return json(
              { error: `No API key configured for ${conv.provider}. Add one in /keys.` },
              400,
            );
          }

          // Persist the user message
          const { error: insertErr } = await supabase.from("messages").insert({
            conversation_id: conversationId,
            user_id: userId,
            role: "user",
            content: message,
          });
          if (insertErr) return json({ error: insertErr.message }, 500);

          // Auto-title from first user msg if still default
          if (conv.title === "New chat") {
            await supabase
              .from("conversations")
              .update({ title: message.slice(0, 60) })
              .eq("id", conversationId);
          }

          const allMessages: ChatMsg[] = [...(history ?? []), { role: "user", content: message }];

          // Recall + inject Apollo memory as a system message
          const mems = await recallForUser(supabase, message, 6);
          const memBlock = formatMemoriesBlock(mems);
          const messagesWithMemory: ChatMsg[] = memBlock
            ? [{ role: "system", content: memBlock }, ...allMessages]
            : allMessages;

          const upstream = await callProvider(
            conv.provider,
            conv.model,
            keyRow.api_key,
            messagesWithMemory,
          );

          if (!upstream.ok || !upstream.body) {
            const txt = await upstream.text().catch(() => "");
            return json(
              { error: `Provider error (${upstream.status}): ${txt.slice(0, 500)}` },
              502,
            );
          }

          // Transform provider stream -> plain text token stream + persist final.
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let assistantText = "";

          const stream = new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              const parser = makeSSEParser(conv.provider);

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  let taken: { line: string; rest: string } | null;
                  while ((taken = takeLine(buffer)) !== null) {
                    buffer = taken.rest;
                    const text = parser(taken.line);
                    if (text) {
                      assistantText += text;
                      controller.enqueue(encoder.encode(text));
                    }
                  }
                }
                // Flush remainder
                const text = parser(buffer);
                if (text) {
                  assistantText += text;
                  controller.enqueue(encoder.encode(text));
                }
                // Persist assistant message
                if (assistantText.trim()) {
                  await supabase.from("messages").insert({
                    conversation_id: conversationId,
                    user_id: userId,
                    role: "assistant",
                    content: assistantText,
                  });
                  await supabase
                    .from("conversations")
                    .update({ updated_at: new Date().toISOString() })
                    .eq("id", conversationId);

                  // Auto-remember the turn (verbatim, MemPalace-style)
                  await supabase.from("memories").insert([
                    {
                      user_id: userId,
                      content: `User said: ${message}`,
                      kind: "chat",
                      source: `chat:${conversationId}`,
                    },
                    {
                      user_id: userId,
                      content: `Apollo replied: ${assistantText.slice(0, 8000)}`,
                      kind: "chat",
                      source: `chat:${conversationId}`,
                    },
                  ]);
                }
              } catch (err) {
                controller.enqueue(
                  encoder.encode(
                    `\n\n[stream error: ${err instanceof Error ? err.message : String(err)}]`,
                  ),
                );
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
            },
          });
        } catch (err) {
          console.error("chat route error", err);
          return json(
            { error: err instanceof Error ? err.message : "Unknown error" },
            500,
          );
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

function takeLine(buf: string): { line: string; rest: string } | null {
  const idx = buf.indexOf("\n");
  if (idx === -1) return null;
  const line = buf.slice(0, idx).replace(/\r$/, "");
  return { line, rest: buf.slice(idx + 1) };
}

type ChatMsg = { role: string; content: string };

async function callProvider(
  provider: string,
  model: string,
  apiKey: string,
  messages: ChatMsg[],
): Promise<Response> {
  switch (provider) {
    case "anthropic": {
      const system = messages.find((m) => m.role === "system")?.content;
      const msgs = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
      return fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          stream: true,
          ...(system ? { system } : {}),
          messages: msgs,
        }),
      });
    }
    case "openai":
    case "groq":
    case "openrouter":
    case "mistral": {
      const baseUrl =
        provider === "openai"
          ? "https://api.openai.com/v1"
          : provider === "groq"
            ? "https://api.groq.com/openai/v1"
            : provider === "openrouter"
              ? "https://openrouter.ai/api/v1"
              : "https://api.mistral.ai/v1";
      return fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, stream: true }),
      });
    }
    case "google": {
      const sys = messages.find((m) => m.role === "system")?.content;
      const contents = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
        }),
      });
    }
    default:
      return new Response(`Unsupported provider: ${provider}`, { status: 400 });
  }
}

// Returns a parser that extracts text deltas from a single SSE line.
function makeSSEParser(provider: string): (line: string) => string {
  return (line: string) => {
    if (!line || line.startsWith(":") || !line.startsWith("data:")) return "";
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return "";
    try {
      const obj = JSON.parse(payload);
      if (provider === "anthropic") {
        if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
          return obj.delta.text ?? "";
        }
        return "";
      }
      if (provider === "google") {
        const parts = obj?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) return parts.map((p: { text?: string }) => p.text ?? "").join("");
        return "";
      }
      // OpenAI-compatible (openai, groq, openrouter, mistral)
      return obj?.choices?.[0]?.delta?.content ?? "";
    } catch {
      return "";
    }
  };
}

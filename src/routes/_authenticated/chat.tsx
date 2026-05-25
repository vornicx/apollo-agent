import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
  updateConversation,
} from "@/lib/conversations.functions";
import { promoteConversation } from "@/lib/missions.functions";
import { CHAT_PROVIDERS, getProvider } from "@/lib/providers";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, Send, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/chat")({ component: ChatPage });

type Msg = { id?: string; role: "user" | "assistant" | "system"; content: string };

function ChatPage() {
  const listFn = useServerFn(listConversations);
  const createFn = useServerFn(createConversation);
  const getFn = useServerFn(getConversation);
  const delFn = useServerFn(deleteConversation);
  const updateFn = useServerFn(updateConversation);
  const promoteFn = useServerFn(promoteConversation);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: convs = [] } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => listFn(),
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (!activeId && convs.length > 0) setActiveId(convs[0].id);
  }, [convs, activeId]);

  const { data: convData } = useQuery({
    queryKey: ["conversation", activeId],
    queryFn: () => getFn({ data: { id: activeId! } }),
    enabled: !!activeId,
  });

  const [messages, setMessages] = useState<Msg[]>([]);
  useEffect(() => {
    if (convData?.messages) {
      setMessages(convData.messages.map((m) => ({ id: m.id, role: m.role as Msg["role"], content: m.content })));
    }
  }, [convData?.conversation?.id, convData?.messages]);

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const newChatMutation = useMutation({
    mutationFn: async () => createFn({ data: { provider: "anthropic", model: getProvider("anthropic")!.models[0] } }),
    onSuccess: (conv) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      setActiveId(conv.id);
      setMessages([]);
    },
  });

  const delMutation = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      if (activeId === id) setActiveId(null);
    },
  });

  const promoteMutation = useMutation({
    mutationFn: (conversationId: string) => promoteFn({ data: { conversationId } }),
    onSuccess: ({ id }) => {
      toast.success("Mission created");
      navigate({ to: "/missions/$id", params: { id } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Promote failed"),
  });

  async function changeModel(provider: string, model: string) {
    if (!activeId) return;
    await updateFn({ data: { id: activeId, provider, model } });
    qc.invalidateQueries({ queryKey: ["conversation", activeId] });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }

  async function send() {
    if (!input.trim() || !activeId || streaming) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", content: userMsg }, { role: "assistant", content: "" }]);
    setStreaming(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ conversationId: activeId, message: userMsg }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        let errMsg = `Request failed (${res.status})`;
        try { errMsg = JSON.parse(errText).error ?? errMsg; } catch { /* noop */ }
        toast.error(errMsg);
        setMessages((m) => m.slice(0, -1));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = { role: "assistant", content: next[next.length - 1].content + chunk };
          return next;
        });
      }
      qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stream failed");
    } finally {
      setStreaming(false);
    }
  }

  const currentConv = convData?.conversation;
  const currentProvider = currentConv ? getProvider(currentConv.provider) : null;

  return (
    <div className="flex h-screen">
      {/* Conversations sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card">
        <div className="p-3">
          <Button className="w-full" onClick={() => newChatMutation.mutate()} disabled={newChatMutation.isPending}>
            <Plus className="mr-2 h-4 w-4" /> New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {convs.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center justify-between rounded-md px-3 py-2 text-sm cursor-pointer ${
                activeId === c.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
              }`}
              onClick={() => setActiveId(c.id)}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{c.title}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{c.provider} · {c.model}</div>
              </div>
              <button
                className="opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); delMutation.mutate(c.id); }}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </button>
            </div>
          ))}
          {convs.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground">No conversations yet.</p>
          )}
        </div>
      </aside>

      {/* Chat panel */}
      <div className="flex flex-1 flex-col">
        {currentConv ? (
          <>
            <header className="flex items-center justify-between border-b border-border px-6 py-3">
              <h2 className="truncate text-sm font-medium">{currentConv.title}</h2>
              <div className="flex items-center gap-2">
                <Select
                  value={currentConv.provider}
                  onValueChange={(p) => {
                    const prov = getProvider(p);
                    if (prov) changeModel(p, prov.models[0]);
                  }}
                >
                  <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHAT_PROVIDERS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {currentProvider && (
                  <Select value={currentConv.model} onValueChange={(m) => changeModel(currentConv.provider, m)}>
                    <SelectTrigger className="h-8 w-56 font-mono text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {currentProvider.models.map((m) => (
                        <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-2 border-primary/40 text-xs"
                  disabled={promoteMutation.isPending || messages.length === 0}
                  onClick={() => activeId && promoteMutation.mutate(activeId)}
                  title="Promote this conversation into a mission"
                >
                  {promoteMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
                  )}
                  Promote to mission
                </Button>
              </div>
            </header>

            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl px-6 py-8">
                {messages.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    Start the conversation. Make sure you have an API key configured for{" "}
                    <Link to="/keys" className="text-primary underline">{currentConv.provider}</Link>.
                  </div>
                )}
                <div className="space-y-6">
                  {messages.map((m, i) => (
                    <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                      <div
                        className={
                          m.role === "user"
                            ? "max-w-[80%] rounded-lg bg-primary px-4 py-2 text-primary-foreground"
                            : "prose-chat max-w-none text-sm text-foreground"
                        }
                      >
                        {m.role === "assistant" ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {m.content || (streaming ? "▊" : "")}
                          </ReactMarkdown>
                        ) : (
                          <p className="whitespace-pre-wrap text-sm">{m.content}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="border-t border-border p-4">
              <div className="mx-auto flex max-w-3xl gap-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                  }}
                  placeholder="Send a message…"
                  rows={2}
                  className="resize-none"
                />
                <Button onClick={send} disabled={streaming || !input.trim()} size="lg">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Button onClick={() => newChatMutation.mutate()}>
              <Plus className="mr-2 h-4 w-4" /> Start a new chat
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

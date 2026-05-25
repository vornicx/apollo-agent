import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  listMemories,
  rememberMemory,
  forgetMemory,
  forgetAllMemories,
} from "@/lib/memory.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus, Brain, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/memories")({ component: MemoriesPage });

const KIND_OPTIONS = ["note", "fact", "preference", "chat", "mission"] as const;

function MemoriesPage() {
  const listFn = useServerFn(listMemories);
  const remFn = useServerFn(rememberMemory);
  const forgetFn = useServerFn(forgetMemory);
  const wipeFn = useServerFn(forgetAllMemories);
  const qc = useQueryClient();

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<(typeof KIND_OPTIONS)[number]>("note");

  const { data: mems = [], isLoading } = useQuery({
    queryKey: ["memories", query, kindFilter],
    queryFn: () =>
      listFn({
        data: {
          query: query.trim() || undefined,
          kind: kindFilter === "all" ? undefined : kindFilter,
          limit: 200,
        },
      }),
  });

  const addMutation = useMutation({
    mutationFn: () => remFn({ data: { content: draft, kind: draftKind, source: "manual", importance: 3 } }),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["memories"] });
      toast.success("Memory saved");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const delMutation = useMutation({
    mutationFn: (id: string) => forgetFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });

  const wipeMutation = useMutation({
    mutationFn: () => wipeFn(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memories"] });
      toast.success("All memories forgotten");
    },
  });

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <Brain className="h-5 w-5 text-[var(--color-cyan)]" />
          <h1 className="font-display text-xl tracking-[0.18em]">MEMORY</h1>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            verbatim · searchable · scoped to you
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Apollo remembers every conversation, mission, fact, and preference. Recalled automatically into chat &amp; missions.
        </p>
      </header>

      <div className="grid flex-1 grid-cols-[360px_1fr] overflow-hidden">
        {/* Sidebar: add + filters */}
        <aside className="flex flex-col gap-4 border-r border-border bg-card/30 p-4 overflow-y-auto">
          <section>
            <h2 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Teach Apollo
            </h2>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Something Apollo should always remember…"
              rows={4}
              className="resize-none text-sm"
            />
            <div className="mt-2 flex gap-2">
              <Select value={draftKind} onValueChange={(v) => setDraftKind(v as typeof draftKind)}>
                <SelectTrigger className="h-9 w-32 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">{k}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="flex-1"
                disabled={!draft.trim() || addMutation.isPending}
                onClick={() => addMutation.mutate()}
              >
                {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                <span className="ml-2">Remember</span>
              </Button>
            </div>
          </section>

          <section className="border-t border-border pt-4">
            <h2 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Filters
            </h2>
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All kinds</SelectItem>
                {KIND_OPTIONS.map((k) => (
                  <SelectItem key={k} value={k} className="text-xs">{k}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          <section className="mt-auto border-t border-border pt-4">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-destructive hover:text-destructive"
              onClick={() => {
                if (confirm("Forget every memory? This cannot be undone.")) wipeMutation.mutate();
              }}
              disabled={wipeMutation.isPending || mems.length === 0}
            >
              <Trash2 className="mr-2 h-4 w-4" /> Forget everything
            </Button>
          </section>
        </aside>

        {/* List */}
        <section className="flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-6 py-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memories…"
              className="h-9 border-none bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
            <span className="font-mono text-[10px] text-muted-foreground">{mems.length} hits</span>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : mems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                {query ? "No memories match that search." : "No memories yet. Chat with Apollo or teach it something."}
              </div>
            ) : (
              <ul className="space-y-3">
                {mems.map((m) => (
                  <li
                    key={m.id}
                    className="group rounded-lg border border-border bg-card/40 p-4 transition-colors hover:border-primary/40"
                  >
                    <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      <span className="rounded bg-primary/10 px-2 py-0.5 text-[var(--color-cyan)]">{m.kind}</span>
                      {m.source && <span className="truncate">{m.source}</span>}
                      <span className="ml-auto">{new Date(m.created_at).toLocaleString()}</span>
                      <button
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => delMutation.mutate(m.id)}
                        aria-label="Forget"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{m.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

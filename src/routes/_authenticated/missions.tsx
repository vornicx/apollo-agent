import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listMissions, createMission, deleteMission } from "@/lib/missions.functions";
import { PERSONAS } from "@/lib/personas";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Compass, Plus, Trash2, Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/missions")({
  component: MissionsPage,
  head: () => ({
    meta: [
      { title: "Missions — APOLLO" },
      { name: "description", content: "Launch a multi-agent mission: Planner, Implementer, Reviewer." },
    ],
  }),
});

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  running: "bg-primary/20 text-[var(--color-cyan)] ring-1 ring-[var(--color-cyan)]/40",
  completed: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
  failed: "bg-destructive/20 text-destructive ring-1 ring-destructive/40",
  paused: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
};

function MissionsPage() {
  const listFn = useServerFn(listMissions);
  const createFn = useServerFn(createMission);
  const delFn = useServerFn(deleteMission);
  const qc = useQueryClient();

  const { data: missions = [], isLoading } = useQuery({
    queryKey: ["missions"],
    queryFn: () => listFn(),
  });

  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");

  const createMut = useMutation({
    mutationFn: () => createFn({ data: { title: title || undefined, goal } }),
    onSuccess: () => {
      toast.success("Mission created");
      setTitle(""); setGoal("");
      qc.invalidateQueries({ queryKey: ["missions"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["missions"] }),
  });

  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-10">
        <header className="flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-cyan)]">
              <Compass className="h-3.5 w-3.5" /> Mission control
            </div>
            <h1 className="mt-2 font-display text-3xl tracking-wider">MISSIONS</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              State a goal. APOLLO orchestrates Planner → Implementer → Reviewer.
            </p>
          </div>
          <div className="hidden gap-2 md:flex">
            {Object.values(PERSONAS).filter((p) => p.id !== "conductor").map((p) => (
              <div key={p.id} className="rounded-md border border-border bg-card/60 px-3 py-2">
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{p.role}</div>
                <div className="font-display text-sm tracking-wider">{p.name}</div>
              </div>
            ))}
          </div>
        </header>

        {/* Launchpad */}
        <section className="mt-10 rounded-xl border border-border bg-card/80 p-6 glow-plasma">
          <h2 className="flex items-center gap-2 font-display tracking-wider"><Plus className="h-4 w-4" /> NEW MISSION</h2>
          <div className="mt-4 grid gap-4">
            <Input
              placeholder="Mission codename (optional)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              placeholder="State the goal. e.g. 'Refactor the auth flow to support OAuth providers'"
              rows={4}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className="resize-none"
            />
            <div className="flex justify-end">
              <Button
                className="bg-plasma text-primary-foreground"
                onClick={() => createMut.mutate()}
                disabled={goal.trim().length < 5 || createMut.isPending}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                {createMut.isPending ? "Launching…" : "Create mission"}
              </Button>
            </div>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="font-display tracking-wider">ACTIVE MISSIONS</h2>
          {isLoading ? (
            <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
          ) : missions.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No missions yet. Launch your first one above.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {missions.map((m) => (
                <li key={m.id} className="group flex items-center justify-between rounded-lg border border-border bg-card p-4 transition-colors hover:border-[var(--color-cyan)]/50">
                  <Link to="/missions/$id" params={{ id: m.id }} className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <span className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${STATUS_COLOR[m.status] ?? STATUS_COLOR.draft}`}>
                        {m.status}
                      </span>
                      <h3 className="truncate text-sm font-medium">{m.title}</h3>
                    </div>
                    <p className="mt-2 truncate text-xs text-muted-foreground">{m.goal}</p>
                  </Link>
                  <Button
                    variant="ghost" size="icon"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={() => delMut.mutate(m.id)}
                    aria-label="Delete mission"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { listMissions, createMission, deleteMission } from "@/lib/missions.functions";
import { PERSONAS } from "@/lib/personas";
import { MISSION_TEMPLATES, estimateMission, type MissionTemplate } from "@/lib/mission-routing";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  BrainCircuit,
  CheckCircle2,
  Compass,
  Gauge,
  Network,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/missions")({
  component: MissionsPage,
  head: () => ({
    meta: [
      { title: "Missions - APOLLO" },
      {
        name: "description",
        content: "Launch a multi-agent mission: Planner, Implementer, Reviewer.",
      },
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
  const estimate = useMemo(() => estimateMission(goal), [goal]);

  const createMut = useMutation({
    mutationFn: () => createFn({ data: { title: title || undefined, goal } }),
    onSuccess: () => {
      toast.success("Mission created");
      setTitle("");
      setGoal("");
      qc.invalidateQueries({ queryKey: ["missions"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["missions"] }),
  });

  function applyTemplate(template: MissionTemplate) {
    setTitle(template.title);
    setGoal(template.goal);
  }

  const completedCount = missions.filter((mission) => mission.status === "completed").length;
  const runningCount = missions.filter((mission) => mission.status === "running").length;

  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
        <header className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-cyan)]">
              <Compass className="h-3.5 w-3.5" /> Mission control
            </div>
            <h1 className="mt-2 font-display text-3xl tracking-wider">APOLLO CORE</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Give Apollo a goal. It plans, executes, reviews and learns through a controlled
              mission lifecycle.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center sm:min-w-[360px]">
            <Metric label="Missions" value={missions.length.toString()} />
            <Metric label="Running" value={runningCount.toString()} />
            <Metric label="Completed" value={completedCount.toString()} />
          </div>
        </header>

        <section className="mt-8 grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
          <aside className="rounded-lg border border-border bg-card/70 p-4">
            <div className="flex items-center gap-2 font-display text-sm tracking-wider">
              <Zap className="h-4 w-4 text-[var(--color-cyan)]" /> FIRST MISSION
            </div>
            <div className="mt-4 space-y-2">
              {MISSION_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className="w-full rounded-md border border-border bg-background/40 p-3 text-left transition-colors hover:border-[var(--color-cyan)]/50 hover:bg-card"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{template.title}</span>
                    <span className="font-mono text-[10px] uppercase text-muted-foreground">
                      {template.timeSaved}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {template.shortGoal}
                  </p>
                </button>
              ))}
            </div>
          </aside>

          <section className="rounded-lg border border-border bg-card/80 p-5 glow-plasma">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 font-display tracking-wider">
                <Plus className="h-4 w-4" /> NEW MISSION
              </h2>
              <span className="rounded bg-primary/15 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-cyan)]">
                {estimate.complexity}
              </span>
            </div>
            <div className="mt-4 grid gap-4">
              <Input
                placeholder="Mission codename (optional)"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <Textarea
                placeholder="State the goal. Example: Build a SaaS launch plan for Apollo with pricing, landing copy and MVP scope."
                rows={8}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                className="resize-none"
              />
              <div className="grid gap-3 rounded-md border border-border bg-background/40 p-4 sm:grid-cols-3">
                <Signal icon={Network} label="Route" value={estimate.route} />
                <Signal
                  icon={Gauge}
                  label="Confidence"
                  value={`${Math.round(estimate.confidence * 100)}%`}
                />
                <Signal icon={ShieldCheck} label="Budget" value={estimate.budget} />
              </div>
              <div className="flex justify-end">
                <Button
                  className="bg-plasma text-primary-foreground"
                  onClick={() => createMut.mutate()}
                  disabled={goal.trim().length < 5 || createMut.isPending}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  {createMut.isPending ? "Launching..." : "Create mission"}
                </Button>
              </div>
            </div>
          </section>

          <aside className="rounded-lg border border-border bg-card/70 p-4">
            <div className="flex items-center gap-2 font-display text-sm tracking-wider">
              <BrainCircuit className="h-4 w-4 text-[var(--color-cyan)]" /> ORCHESTRATION
            </div>
            <div className="mt-4 space-y-3">
              {Object.values(PERSONAS)
                .filter((persona) => persona.id !== "conductor")
                .map((persona, index) => (
                  <div
                    key={persona.id}
                    className="rounded-md border border-border bg-background/40 p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        Step {index + 1} - {persona.role}
                      </div>
                      <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
                    </div>
                    <div className="mt-1 font-display text-sm tracking-wider">{persona.name}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{persona.tagline}</p>
                  </div>
                ))}
            </div>
          </aside>
        </section>

        <section className="mt-8">
          <h2 className="font-display tracking-wider">MISSION QUEUE</h2>
          {isLoading ? (
            <p className="mt-4 text-sm text-muted-foreground">Loading...</p>
          ) : missions.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No missions yet. Launch your first one above.
            </p>
          ) : (
            <ul className="mt-4 grid gap-3 lg:grid-cols-2">
              {missions.map((mission) => (
                <li
                  key={mission.id}
                  className="group flex items-center justify-between rounded-lg border border-border bg-card p-4 transition-colors hover:border-[var(--color-cyan)]/50"
                >
                  <Link to="/missions/$id" params={{ id: mission.id }} className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <span
                        className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
                          STATUS_COLOR[mission.status] ?? STATUS_COLOR.draft
                        }`}
                      >
                        {mission.status}
                      </span>
                      <h3 className="truncate text-sm font-medium">{mission.title}</h3>
                    </div>
                    <p className="mt-2 truncate text-xs text-muted-foreground">{mission.goal}</p>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={() => delMut.mutate(mission.id)}
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card/70 px-3 py-2">
      <div className="font-display text-lg tracking-wider">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function Signal({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

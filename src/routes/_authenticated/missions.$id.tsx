import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getMission, updatePhaseOutput } from "@/lib/missions.functions";
import { PERSONAS, PERSONA_ORDER, nextPersonaAfter, type PersonaId } from "@/lib/personas";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Pencil,
  Play,
  Save,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/missions/$id")({
  component: MissionDetail,
  head: () => ({ meta: [{ title: "Mission — APOLLO" }] }),
});

type LiveStream = { persona: PersonaId; text: string };

function MissionDetail() {
  const { id } = Route.useParams();
  const getFn = useServerFn(getMission);
  const updateFn = useServerFn(updatePhaseOutput);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["mission", id],
    queryFn: () => getFn({ data: { id } }),
  });

  const [live, setLive] = useState<LiveStream | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function runPersona(persona: PersonaId) {
    if (live) return;
    setLive({ persona, text: "" });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/api/missions/stream", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ missionId: id, persona }),
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        let msg = `Request failed (${res.status})`;
        try {
          msg = JSON.parse(t).error ?? msg;
        } catch {
          /* noop */
        }
        // Si no hay key configurada, llevar al usuario a /keys en lugar de error crudo
        if (
          msg.toLowerCase().includes("no api key") ||
          msg.toLowerCase().includes("api key configured")
        ) {
          toast.error("No API key configured. Add your OpenRouter key to launch missions.", {
            action: { label: "Add key", onClick: () => (window.location.href = "/keys") },
            duration: 8000,
          });
        } else {
          toast.error(msg);
        }
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setLive((prev) => (prev ? { ...prev, text: prev.text + chunk } : prev));
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        toast.error(err instanceof Error ? err.message : "Stream failed");
      }
    } finally {
      setLive(null);
      abortRef.current = null;
      qc.invalidateQueries({ queryKey: ["mission", id] });
    }
  }

  function stopStream() {
    abortRef.current?.abort();
  }

  if (isLoading || !data?.mission) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading mission…
      </div>
    );
  }
  const { mission, phases } = data;
  const lastPersona = (phases.at(-1)?.persona as PersonaId | undefined) ?? null;
  const next = nextPersonaAfter(lastPersona);
  const isRunning = !!live;

  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <Link
          to="/missions"
          className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All missions
        </Link>

        <header className="mt-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-cyan)]">
            Mission · {mission.status}
          </div>
          <h1 className="mt-2 font-display text-3xl tracking-wider">{mission.title}</h1>
          <p className="mt-3 whitespace-pre-wrap rounded-lg border border-border bg-card/60 p-4 text-sm text-foreground/90">
            {mission.goal}
          </p>
        </header>

        {/* Phase pipeline */}
        <ol className="mt-8 grid grid-cols-3 gap-3">
          {PERSONA_ORDER.map((pid) => {
            const p = PERSONAS[pid];
            const phase = phases.find((ph) => ph.persona === pid);
            const liveHere = live?.persona === pid;
            const status = liveHere ? "running" : phase?.status;
            return (
              <li
                key={pid}
                className={`rounded-lg border p-4 ${status === "completed" ? "border-[var(--color-cyan)]/40 bg-card/80" : status === "running" ? "border-primary/50 bg-card" : status === "failed" ? "border-destructive/40 bg-card" : "border-border bg-card/40"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {p.role}
                  </span>
                  <PhaseIcon status={status} />
                </div>
                <div className="mt-2 font-display tracking-wider">{p.name}</div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.tagline}</div>
              </li>
            );
          })}
        </ol>

        {/* Run controls */}
        <section className="mt-8 flex items-center justify-between rounded-xl border border-border bg-card p-4">
          <div className="text-sm">
            {isRunning ? (
              <>
                Streaming{" "}
                <strong className="font-display tracking-wider">
                  {PERSONAS[live!.persona].name}
                </strong>
                …
              </>
            ) : next ? (
              <>
                Next: <strong className="font-display tracking-wider">{PERSONAS[next].name}</strong>
              </>
            ) : (
              <>Mission complete. Re-run any phase below.</>
            )}
          </div>
          {isRunning ? (
            <Button variant="outline" onClick={stopStream}>
              <X className="mr-2 h-4 w-4" /> Stop
            </Button>
          ) : next ? (
            <Button className="bg-plasma text-primary-foreground" onClick={() => runPersona(next)}>
              <Play className="mr-2 h-4 w-4" /> Run {PERSONAS[next].name}
            </Button>
          ) : null}
        </section>

        {/* Live stream card (shown while running) */}
        {live && (
          <article className="mt-8 rounded-xl border border-primary/40 bg-card p-6">
            <header className="flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-cyan)]">
                  Live · {PERSONAS[live.persona].role}
                </div>
                <div className="font-display text-lg tracking-wider">
                  {PERSONAS[live.persona].name}
                </div>
              </div>
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            </header>
            <div className="prose-chat mt-4 text-sm">
              {live.text ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{live.text + "▊"}</ReactMarkdown>
              ) : (
                <p className="text-muted-foreground">Connecting…</p>
              )}
            </div>
          </article>
        )}

        {/* Phase outputs */}
        <section className="mt-8 space-y-6">
          {phases.length === 0 && !live && (
            <p className="text-sm text-muted-foreground">
              No phases yet. Run the Planner to start.
            </p>
          )}
          {phases.map((ph) => (
            <PhaseCard
              key={ph.id}
              phase={ph}
              onRerun={(persona) => runPersona(persona)}
              onSave={async (text) => {
                await updateFn({ data: { phaseId: ph.id, output: text } });
                qc.invalidateQueries({ queryKey: ["mission", id] });
                toast.success("Phase updated");
              }}
              disabled={isRunning}
            />
          ))}
        </section>
      </div>
    </div>
  );
}

type Phase = {
  id: string;
  persona: string;
  provider: string;
  model: string;
  output: string;
  status: string;
  position: number;
};

function PhaseCard({
  phase,
  onSave,
  onRerun,
  disabled,
}: {
  phase: Phase;
  onSave: (text: string) => Promise<void>;
  onRerun: (persona: PersonaId) => void;
  disabled: boolean;
}) {
  const persona = PERSONAS[phase.persona as PersonaId];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(phase.output);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(phase.output);
  }, [phase.output, editing]);

  return (
    <article className="rounded-xl border border-border bg-card p-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-cyan)]">
            Phase {phase.position + 1} · {persona?.role}
          </div>
          <div className="font-display text-lg tracking-wider">
            {persona?.name ?? phase.persona}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-muted-foreground">
            {phase.provider}/{phase.model}
          </span>
          <PhaseIcon status={phase.status} />
          {!editing && phase.status === "completed" && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={disabled}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {!editing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRerun(phase.persona as PersonaId)}
              disabled={disabled}
              title="Re-run phase"
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </header>

      {editing ? (
        <div className="mt-4 space-y-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(24, Math.max(8, draft.split("\n").length + 2))}
            className="font-mono text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              <X className="mr-1 h-3.5 w-3.5" /> Cancel
            </Button>
            <Button
              size="sm"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave(draft);
                  setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 h-3.5 w-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>
      ) : phase.output ? (
        <div className="prose-chat mt-4 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{phase.output}</ReactMarkdown>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No output yet.</p>
      )}
    </article>
  );
}

function PhaseIcon({ status }: { status?: string }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-[var(--color-cyan)]" />;
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-destructive" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

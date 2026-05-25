import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Mic, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listVoiceSessions, getVoiceSession, deleteVoiceSession, resetVoiceAgent } from "@/lib/voice.functions";
import { useVoice } from "@/components/voice/voice-provider";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/voice")({
  component: VoicePage,
  head: () => ({ meta: [{ title: "Voice · APOLLO" }] }),
});

function VoicePage() {
  const list = useServerFn(listVoiceSessions);
  const reset = useServerFn(resetVoiceAgent);
  const del = useServerFn(deleteVoiceSession);
  const get = useServerFn(getVoiceSession);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { start, status } = useVoice();
  const [selected, setSelected] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ["voice-sessions"],
    queryFn: () => list(),
  });

  const session = useQuery({
    queryKey: ["voice-session", selected],
    queryFn: () => get({ data: { id: selected! } }),
    enabled: !!selected,
  });

  const resetMut = useMutation({
    mutationFn: () => reset(),
    onSuccess: () => toast.success("Voice agent reset. The next session rebuilds it with current preferences."),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["voice-sessions"] });
      setSelected(null);
    },
  });

  return (
    <div className="flex h-full">
      <div className="w-80 shrink-0 border-r border-border bg-card/30 p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-display text-sm font-semibold tracking-widest">VOICE</h2>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {status}
            </p>
          </div>
          <Button size="sm" onClick={() => void start()} disabled={status !== "idle"}>
            <Mic className="mr-2 h-4 w-4" /> Start
          </Button>
        </div>

        <div className="mb-6 space-y-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => navigate({ to: "/memories" })}
          >
            Manage memories →
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => resetMut.mutate()}
            disabled={resetMut.isPending}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> Rebuild voice agent
          </Button>
        </div>

        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Recent sessions
        </h3>
        <div className="space-y-1">
          {sessions.data?.length === 0 && (
            <p className="text-xs text-muted-foreground">No sessions yet.</p>
          )}
          {sessions.data?.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={`block w-full rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                selected === s.id
                  ? "border-[var(--color-cyan)]/50 bg-card"
                  : "border-border hover:bg-muted/40"
              }`}
            >
              <div className="font-mono text-foreground">
                {new Date(s.started_at).toLocaleString()}
              </div>
              <div className="text-muted-foreground">{s.turn_count} turns</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!selected && (
          <div className="grid h-full place-items-center text-muted-foreground">
            <div className="text-center">
              <div className="font-display text-2xl">Talk to APOLLO</div>
              <p className="mt-2 max-w-md text-sm">
                Press <kbd className="rounded border border-border bg-muted px-1 font-mono text-xs">⌘/Ctrl + J</kbd> or
                click the orb to start. APOLLO recalls your memory, learns preferences, and can navigate the app for you.
              </p>
            </div>
          </div>
        )}
        {selected && session.data && (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="font-display text-lg">
                  {new Date(session.data.started_at).toLocaleString()}
                </div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {session.data.turn_count} turns
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteMut.mutate(selected)}
                disabled={deleteMut.isPending}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </Button>
            </div>
            <div className="space-y-4">
              {(session.data.transcript as { role: string; text: string; at?: string }[])?.map((t, i) => (
                <div key={i}>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {t.role === "user" ? "you" : "apollo"}
                  </div>
                  <div
                    className={`mt-1 whitespace-pre-wrap text-sm ${
                      t.role === "user" ? "text-foreground" : "text-[var(--color-cyan)]"
                    }`}
                  >
                    {t.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useVoice } from "./voice-provider";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

export function TranscriptPanel() {
  const { isOpen, setOpen, transcript, status } = useVoice();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  if (!isOpen) return null;

  return (
    <aside className="pointer-events-auto fixed bottom-28 right-6 z-40 flex h-[55vh] w-[380px] flex-col rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="font-display text-sm font-semibold tracking-widest">APOLLO</div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {status}
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close transcript"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {transcript.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">Waiting…</p>
        ) : (
          transcript.map((t, i) => (
            <div
              key={i}
              className={
                t.role === "user"
                  ? "text-foreground"
                  : "text-[var(--color-cyan)]"
              }
            >
              <div className="font-mono text-[10px] uppercase tracking-widest opacity-60">
                {t.role === "user" ? "you" : "apollo"}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap">{t.text}</div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

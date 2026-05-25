import { useVoice } from "./voice-provider";
import { Mic, Square, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function VoiceOrb() {
  const { status, toggle, outputVolume, inputVolume, isOpen, setOpen } = useVoice();

  const active = status === "listening" || status === "speaking";
  const connecting = status === "connecting";
  const speaking = status === "speaking";

  const level = speaking ? outputVolume : inputVolume;
  const scale = 1 + Math.min(level, 1) * 0.25;

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex items-end gap-3">
      {/* Open transcript toggle (only when active) */}
      {active && (
        <button
          type="button"
          onClick={() => setOpen(!isOpen)}
          className="pointer-events-auto rounded-full border border-border bg-card/80 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground backdrop-blur transition hover:text-foreground"
        >
          {isOpen ? "hide" : "show"} transcript
        </button>
      )}

      <button
        type="button"
        onClick={() => void toggle()}
        aria-label={active ? "End voice session" : "Start voice session"}
        title={active ? "End (Esc)" : "Start voice (⌘/Ctrl+J)"}
        className={cn(
          "pointer-events-auto group relative grid h-16 w-16 place-items-center rounded-full border transition-all",
          "border-border bg-background/60 backdrop-blur shadow-xl",
          active && "border-[var(--color-cyan)]/50 shadow-[0_0_40px_-8px_var(--color-cyan)]",
        )}
      >
        {/* Animated halo */}
        <span
          className={cn(
            "absolute inset-0 rounded-full transition-all",
            active
              ? "bg-[radial-gradient(circle_at_center,var(--color-cyan)/35%,transparent_70%)]"
              : "bg-[radial-gradient(circle_at_center,hsl(var(--primary)/0.25),transparent_70%)]",
          )}
          style={{ transform: `scale(${scale})`, transition: "transform 80ms ease-out" }}
        />
        {/* Pulse ring */}
        {active && (
          <span className="absolute inset-0 animate-ping rounded-full border border-[var(--color-cyan)]/40" />
        )}
        {/* Icon */}
        <span className="relative z-10 grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-indigo-500/30 via-fuchsia-500/20 to-cyan-400/30 text-foreground">
          {connecting ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : active ? (
            <Square className="h-4 w-4 fill-current" />
          ) : (
            <Mic className="h-5 w-5" />
          )}
        </span>
      </button>
    </div>
  );
}

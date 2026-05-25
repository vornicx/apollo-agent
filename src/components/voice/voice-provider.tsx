import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { buildClientTools } from "@/lib/voice/tools";

export type VoiceStatus = "idle" | "connecting" | "listening" | "speaking" | "error";

export type Turn = { role: "user" | "agent"; text: string; at: string };

type VoiceContextValue = {
  status: VoiceStatus;
  isOpen: boolean;
  transcript: Turn[];
  setOpen: (v: boolean) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
  outputVolume: number;
  inputVolume: number;
};

const VoiceCtx = createContext<VoiceContextValue | null>(null);

export function useVoice() {
  const ctx = useContext(VoiceCtx);
  if (!ctx) throw new Error("useVoice must be used inside <VoiceProvider>");
  return ctx;
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  return (
    <ConversationProvider>
      <VoiceProviderInner>{children}</VoiceProviderInner>
    </ConversationProvider>
  );
}

function VoiceProviderInner({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [isOpen, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [outputVolume, setOutputVolume] = useState(0);
  const [inputVolume, setInputVolume] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  const pendingTurnsRef = useRef<Turn[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tools = useMemo(() => buildClientTools({ navigate }), [navigate]);

  const flushTurns = useCallback(async (ended = false) => {
    if (pendingTurnsRef.current.length === 0 && !ended) return;
    const turns = pendingTurnsRef.current;
    pendingTurnsRef.current = [];
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const res = await fetch("/api/voice/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId: sessionIdRef.current ?? undefined,
          turns: turns.length > 0 ? turns : [{ role: "agent", text: "(session ended)", at: new Date().toISOString() }],
          ended,
        }),
      });
      if (res.ok) {
        const { sessionId } = (await res.json()) as { sessionId: string };
        sessionIdRef.current = sessionId;
      }
    } catch (err) {
      console.error("flushTurns failed", err);
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => flushTurns(false), 1500);
  }, [flushTurns]);

  const addTurn = useCallback((role: "user" | "agent", text: string) => {
    const turn: Turn = { role, text, at: new Date().toISOString() };
    setTranscript((prev) => [...prev, turn]);
    pendingTurnsRef.current.push(turn);
    scheduleFlush();
  }, [scheduleFlush]);

  const conversation = useConversation({
    clientTools: tools,
    onConnect: () => setOpen(true),
    onDisconnect: () => {
      flushTurns(true);
      sessionIdRef.current = null;
    },
    onError: (err) => {
      console.error("voice error", err);
      toast.error("Voice error", { description: String(err) });
    },
    onMessage: (msg: { source?: string; message?: string }) => {
      // Older SDK shape: { source: "user"|"ai", message: string }
      if (!msg?.message) return;
      const role = msg.source === "user" ? "user" : "agent";
      addTurn(role, msg.message);
    },
  });

  const rawStatus = conversation.status;
  const isSpeaking = conversation.isSpeaking;

  const status: VoiceStatus = useMemo(() => {
    if (rawStatus === "connecting") return "connecting";
    if (rawStatus === "connected") return isSpeaking ? "speaking" : "listening";
    return "idle";
  }, [rawStatus, isSpeaking]);

  // Drive volume meters for the orb
  useEffect(() => {
    if (rawStatus !== "connected") return;
    let raf = 0;
    const loop = () => {
      try {
        setOutputVolume(conversation.getOutputVolume?.() ?? 0);
        setInputVolume(conversation.getInputVolume?.() ?? 0);
      } catch {
        /* ignore */
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rawStatus, conversation]);

  const start = useCallback(async () => {
    if (rawStatus === "connected" || rawStatus === "connecting") return;
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error("Microphone access required");
      return;
    }
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("You must be signed in");
        return;
      }
      const res = await fetch("/api/voice/token", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const txt = await res.text();
        toast.error("Could not start voice", { description: txt.slice(0, 200) });
        return;
      }
      const { token: convToken, overrides } = (await res.json()) as {
        token: string;
        overrides?: Record<string, unknown>;
      };
      setTranscript([]);
      sessionIdRef.current = null;
      pendingTurnsRef.current = [];
      await conversation.startSession({
        conversationToken: convToken,
        connectionType: "webrtc",
        overrides,
      });
      setOpen(true);
    } catch (err) {
      console.error(err);
      toast.error("Failed to start voice", { description: (err as Error).message });
    }
  }, [conversation, rawStatus]);

  const stop = useCallback(async () => {
    try {
      await conversation.endSession();
    } catch {
      /* ignore */
    }
  }, [conversation]);

  const toggle = useCallback(async () => {
    if (rawStatus === "connected") await stop();
    else await start();
  }, [rawStatus, start, stop]);

  // Keyboard shortcut: Cmd/Ctrl+J to toggle, Esc to stop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        void toggle();
      } else if (e.key === "Escape" && rawStatus === "connected") {
        void stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, stop, rawStatus]);

  const value = useMemo<VoiceContextValue>(
    () => ({ status, isOpen, transcript, setOpen, start, stop, toggle, outputVolume, inputVolume }),
    [status, isOpen, transcript, start, stop, toggle, outputVolume, inputVolume],
  );

  return <VoiceCtx.Provider value={value}>{children}</VoiceCtx.Provider>;
}

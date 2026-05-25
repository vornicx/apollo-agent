import { createFileRoute, Link, Navigate, Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { MessagesSquare, KeyRound, Bot, Settings, LogOut, Compass, Brain, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApolloMark } from "@/components/apollo-mark";
import { VoiceProvider } from "@/components/voice/voice-provider";
import { VoiceOrb } from "@/components/voice/voice-orb";
import { TranscriptPanel } from "@/components/voice/transcript-panel";

export const Route = createFileRoute("/_authenticated")({ component: AuthLayout });

const NAV = [
  { to: "/missions", label: "Missions", icon: Compass },
  { to: "/chat", label: "Chat", icon: MessagesSquare },
  { to: "/voice", label: "Voice", icon: Mic },
  { to: "/memories", label: "Memory", icon: Brain },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/keys", label: "API Keys", icon: KeyRound },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

function AuthLayout() {
  const { user, loading } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!user) return <Navigate to="/login" />;

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigate({ to: "/" });
  }

  return (
    <div className="flex min-h-screen w-full text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <Link to="/missions" className="flex items-center gap-3 px-5 py-6">
          <ApolloMark className="h-8 w-8" />
          <div className="leading-none">
            <div className="font-display text-lg font-semibold tracking-[0.2em] text-foreground">APOLLO</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">orchestrator</div>
          </div>
        </Link>
        <nav className="flex-1 space-y-1 px-2">
          {NAV.map((item) => {
            const active = path.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground ring-plasma"
                    : "hover:bg-sidebar-accent/60"
                }`}
              >
                <item.icon className={`h-4 w-4 ${active ? "text-[var(--color-cyan)]" : ""}`} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <div className="truncate px-2 pb-2 text-xs text-muted-foreground">{user.email}</div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <VoiceProvider>
          <Outlet />
          <VoiceOrb />
          <TranscriptPanel />
        </VoiceProvider>
      </main>
    </div>
  );
}

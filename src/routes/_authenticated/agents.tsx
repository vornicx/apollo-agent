import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/agents")({ component: AgentsPage });

const AGENTS = [
  {
    name: "Claude Code",
    desc: "Anthropic's official terminal coding agent. Install via npm and authenticate with your Anthropic API key.",
    install: "npm install -g @anthropic-ai/claude-code",
    url: "https://docs.anthropic.com/claude/docs/claude-code",
    keyProvider: "anthropic",
  },
  {
    name: "OpenAI Codex CLI",
    desc: "OpenAI's open-source coding agent. Uses your OpenAI API key.",
    install: "npm install -g @openai/codex",
    url: "https://github.com/openai/codex",
    keyProvider: "openai",
  },
  {
    name: "Cursor AI",
    desc: "AI-first code editor. Download and sign in — no API key required for the editor itself.",
    install: "Download from cursor.com",
    url: "https://cursor.com",
    keyProvider: null,
  },
  {
    name: "OpenCode",
    desc: "Open-source AI coding agent for the terminal. Bring your own model and key.",
    install: "curl -fsSL https://opencode.ai/install | bash",
    url: "https://opencode.ai",
    keyProvider: null,
  },
] as const;

function AgentsPage() {
  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="text-2xl font-semibold">Agents hub</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quick access to coding agents. They run on your machine — store the keys they need in the{" "}
          <Link to="/keys" className="text-primary underline">vault</Link>.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {AGENTS.map((a) => (
            <div key={a.name} className="rounded-lg border border-border bg-card p-6">
              <div className="flex items-start justify-between">
                <h3 className="font-semibold">{a.name}</h3>
                <a href={a.url} target="_blank" rel="noreferrer">
                  <Button variant="ghost" size="icon"><ExternalLink className="h-4 w-4" /></Button>
                </a>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{a.desc}</p>
              <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
                {a.install}
              </pre>
              {a.keyProvider && (
                <Link to="/keys" className="mt-3 inline-block text-xs text-primary underline">
                  Configure {a.keyProvider} key →
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

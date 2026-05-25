import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ApolloMark } from "@/components/apollo-mark";
import {
  ArrowRight,
  Brain,
  Code2,
  ShieldCheck,
  Cpu,
  Sparkles,
  Activity,
  Target,
  GitBranch,
  Gauge,
  Lock,
  Layers,
  Radar,
  CircleDot,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "APOLLO — Mission Control for Autonomous Intelligence" },
      {
        name: "description",
        content:
          "Give Apollo a goal. It plans, executes, reviews and gets smarter after every mission. Multi-agent orchestration across Claude, GPT, Gemini and open models.",
      },
      { property: "og:title", content: "APOLLO — Mission Control for Autonomous Intelligence" },
      {
        property: "og:description",
        content:
          "Mission Control for Autonomous Intelligence. Planner, Implementer, Reviewer and Reflection agents working in concert.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen text-foreground">
      <Nav />
      <Hero />
      <Pillars />
      <Architecture />
      <Routing />
      <Reflection />
      <Security />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ───────────────────────── Nav ───────────────────────── */

function Nav() {
  const items = [
    { label: "System", href: "#pillars" },
    { label: "Agents", href: "#architecture" },
    { label: "Routing", href: "#routing" },
    { label: "Reflection", href: "#reflection" },
    { label: "Security", href: "#security" },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2.5">
          <ApolloMark className="h-7 w-7 text-foreground" />
          <span className="font-display text-base font-semibold tracking-[0.18em]">APOLLO</span>
        </Link>
        <nav className="hidden items-center gap-8 md:flex">
          {items.map((i) => (
            <a
              key={i.label}
              href={i.href}
              className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {i.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link to="/login">
            <Button variant="ghost" size="sm" className="text-[13px]">Sign in</Button>
          </Link>
          <Link to="/login">
            <Button size="sm" className="text-[13px] font-medium">
              Launch console
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ───────────────────────── Hero ───────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-50" />
      <div className="mx-auto grid max-w-7xl gap-16 px-6 pb-24 pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-20 lg:pb-32 lg:pt-28">
        <div className="flex flex-col justify-center">
          <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-border/80 bg-card/60 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            Mission control · online
          </div>
          <h1 className="font-display text-[44px] font-semibold leading-[1.03] tracking-[-0.025em] sm:text-[58px] lg:text-[72px]">
            Mission Control for{" "}
            <span className="text-plasma">Autonomous Intelligence</span>
          </h1>
          <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground sm:text-[18px]">
            Give Apollo a goal. It plans, executes, reviews — and gets smarter after every mission.
            A coordinated system of specialized agents, not another chat box.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to="/login">
              <Button size="lg" className="h-12 px-6 text-[14px] font-medium glow-plasma">
                Launch a mission
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <a href="#architecture">
              <Button size="lg" variant="outline" className="h-12 border-border/80 bg-card/40 px-6 text-[14px]">
                See the architecture
              </Button>
            </a>
          </div>
          <dl className="mt-12 grid max-w-md grid-cols-3 gap-6 border-t border-border/60 pt-6">
            {[
              { k: "4", v: "Core agents" },
              { k: "12+", v: "Models routed" },
              { k: "100%", v: "BYOK private" },
            ].map((s) => (
              <div key={s.v}>
                <dt className="font-display text-2xl font-semibold">{s.k}</dt>
                <dd className="mt-1 text-[12px] uppercase tracking-wider text-muted-foreground">{s.v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <MissionGraph />
      </div>
    </section>
  );
}

/* ───────────────────────── Mission Graph (hero visual) ───────────────────────── */

function MissionGraph() {
  const nodes = [
    { label: "Planner", model: "Claude", color: "var(--color-primary)", icon: Target, status: "Planning…" },
    { label: "Implementer", model: "GPT", color: "var(--color-cyan)", icon: Code2, status: "Executing…" },
    { label: "Reviewer", model: "Gemini", color: "var(--color-violet)", icon: ShieldCheck, status: "Reviewing…" },
    { label: "Reflection", model: "Apollo", color: "var(--color-success)", icon: Sparkles, status: "Learning…" },
  ];
  return (
    <div className="relative">
      <div className="surface-glass relative rounded-3xl border border-border/80 p-5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.8)]">
        {/* console header */}
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <Radar className="h-3.5 w-3.5 text-[color:var(--color-cyan)]" />
            Mission · APL-0421
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-soft" /> live
          </div>
        </div>

        {/* goal */}
        <div className="mt-4 rounded-xl border border-border/60 bg-background/50 p-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Goal</div>
          <div className="mt-1.5 font-display text-[15px] text-foreground">
            Audit our checkout flow, ship a typed API client, and write release notes.
          </div>
        </div>

        {/* execution graph */}
        <div className="relative mt-5 space-y-2.5">
          {nodes.map((n, i) => (
            <AgentRow key={n.label} index={i} {...n} />
          ))}
        </div>

        {/* footer telemetry */}
        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border/60 pt-4 text-[11px] font-mono">
          {[
            { k: "tokens", v: "184.2k" },
            { k: "latency", v: "1.24s" },
            { k: "confidence", v: "0.96" },
          ].map((m) => (
            <div key={m.k} className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.k}</div>
              <div className="mt-0.5 text-foreground">{m.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ambient orbit */}
      <div className="pointer-events-none absolute -inset-10 -z-10 opacity-40">
        <div className="absolute inset-0 animate-orbit">
          <div className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-[color:var(--color-primary)] blur-[1px]" />
        </div>
        <div className="absolute inset-6 animate-orbit-rev">
          <div className="absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[color:var(--color-cyan)] blur-[1px]" />
        </div>
      </div>
    </div>
  );
}

function AgentRow({
  label,
  model,
  color,
  icon: Icon,
  status,
  index,
}: {
  label: string;
  model: string;
  color: string;
  icon: React.ComponentType<{ className?: string }>;
  status: string;
  index: number;
}) {
  return (
    <div
      className="group flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3.5 py-3 transition-colors hover:border-border"
      style={{ animationDelay: `${index * 120}ms` }}
    >
      <div
        className="flex h-9 w-9 items-center justify-center rounded-lg border"
        style={{
          borderColor: `color-mix(in oklab, ${color} 45%, transparent)`,
          background: `color-mix(in oklab, ${color} 14%, transparent)`,
        }}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="font-display text-[14px] font-medium">{label}</div>
          <div className="text-[11px] font-mono text-muted-foreground">· {model}</div>
        </div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">{status}</div>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 rounded-full animate-pulse-soft"
          style={{ background: color, boxShadow: `0 0 10px ${color}` }}
        />
        <CircleDot className="h-3.5 w-3.5 text-muted-foreground/60" />
      </div>
    </div>
  );
}

/* ───────────────────────── Pillars ───────────────────────── */

function Pillars() {
  const pillars = [
    { icon: GitBranch, title: "Multi-agent orchestration", body: "Planner, Implementer and Reviewer working in concert — not one model pretending to do it all." },
    { icon: Gauge, title: "Cost-aware intelligence", body: "Cheap models first. Premium escalation only when complexity demands it." },
    { icon: Brain, title: "Self-improving system", body: "Every mission feeds Reflection. Routing, prompts and memory evolve over time." },
    { icon: Activity, title: "Mission control UX", body: "Live execution graph, reasoning logs, agent state. You operate the system, not chat with it." },
    { icon: Lock, title: "Enterprise trust", body: "BYOK, private execution, encryption at rest and in transit. Audit-ready by design." },
    { icon: Layers, title: "Composable by default", body: "Drop new agents, new models, new tools. The orchestration layer adapts." },
  ];
  return (
    <section id="pillars" className="relative border-t border-border/60">
      <div className="mx-auto max-w-7xl px-6 py-24 lg:py-32">
        <SectionLabel>Operating principles</SectionLabel>
        <h2 className="mt-3 max-w-3xl font-display text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[48px]">
          Built like aerospace software. Run like a mission.
        </h2>
        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border/80 bg-border/60 sm:grid-cols-2 lg:grid-cols-3">
          {pillars.map((p) => (
            <div key={p.title} className="bg-background/80 p-7 transition-colors hover:bg-card/60">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/80 bg-card">
                <p.icon className="h-4.5 w-4.5 text-[color:var(--color-cyan)]" />
              </div>
              <h3 className="mt-5 font-display text-[18px] font-medium">{p.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Architecture ───────────────────────── */

function Architecture() {
  const agents = [
    {
      name: "Planner",
      tag: "Blue",
      color: "var(--color-primary)",
      icon: Target,
      role: "Break the goal into an executable strategy.",
      tasks: ["Decomposition", "Routing", "Cost estimation"],
      models: "Claude · Gemini",
    },
    {
      name: "Implementer",
      tag: "Cyan",
      color: "var(--color-cyan)",
      icon: Code2,
      role: "Execute the plan with the right tools.",
      tasks: ["Coding", "Writing", "Analysis", "Generation"],
      models: "GPT · Groq · Open models",
    },
    {
      name: "Reviewer",
      tag: "Purple",
      color: "var(--color-violet)",
      icon: ShieldCheck,
      role: "Verify quality before anything ships.",
      tasks: ["Hallucination detection", "QA", "Security", "Coherence"],
      models: "Claude · Gemini",
    },
    {
      name: "Reflection",
      tag: "Apollo",
      color: "var(--color-success)",
      icon: Sparkles,
      role: "Score the mission and improve future runs.",
      tasks: ["Evaluation", "Model comparison", "Prompt evolution"],
      models: "Apollo core",
    },
  ];
  return (
    <section id="architecture" className="relative border-t border-border/60">
      <div className="mx-auto max-w-7xl px-6 py-24 lg:py-32">
        <SectionLabel>Agent system</SectionLabel>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
          <h2 className="max-w-3xl font-display text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[48px]">
            Four specialized agents. One coordinated mind.
          </h2>
          <p className="max-w-md text-[15px] text-muted-foreground">
            Goal → Planner → Implementer → Reviewer → Reflection → Learning.
            Every stage is observable, measurable and replaceable.
          </p>
        </div>

        <div className="mt-14 grid gap-5 md:grid-cols-2">
          {agents.map((a) => (
            <div
              key={a.name}
              className="surface-glass relative overflow-hidden rounded-2xl border border-border/80 p-7"
            >
              <div
                className="absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-20 blur-3xl"
                style={{ background: a.color }}
              />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg border"
                    style={{
                      borderColor: `color-mix(in oklab, ${a.color} 45%, transparent)`,
                      background: `color-mix(in oklab, ${a.color} 12%, transparent)`,
                    }}
                  >
                    <a.icon className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <div className="font-display text-[18px] font-medium">{a.name}</div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      {a.tag}
                    </div>
                  </div>
                </div>
                <div className="text-[11px] font-mono text-muted-foreground">{a.models}</div>
              </div>
              <p className="mt-5 text-[14px] leading-relaxed text-muted-foreground">{a.role}</p>
              <div className="mt-5 flex flex-wrap gap-1.5">
                {a.tasks.map((t) => (
                  <span
                    key={t}
                    className="rounded-md border border-border/70 bg-background/50 px-2 py-1 text-[11px] font-mono text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Routing ───────────────────────── */

function Routing() {
  const tiers = [
    { name: "Simple", desc: "Free model handles it end to end.", stack: "Qwen · mBERT", color: "var(--color-success)" },
    { name: "Medium", desc: "Single premium model, fast turnaround.", stack: "GPT or Claude", color: "var(--color-primary)" },
    { name: "Complex", desc: "Full multi-agent orchestration.", stack: "Planner · Implementer · Reviewer", color: "var(--color-cyan)" },
    { name: "Critical", desc: "Multi-model consensus before delivery.", stack: "Claude × GPT × Gemini", color: "var(--color-violet)" },
  ];
  return (
    <section id="routing" className="relative border-t border-border/60">
      <div className="mx-auto max-w-7xl px-6 py-24 lg:py-32">
        <SectionLabel>Routing engine</SectionLabel>
        <h2 className="mt-3 max-w-3xl font-display text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[48px]">
          The right model for the right task — automatically.
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] text-muted-foreground">
          A multilingual BERT layer classifies intent, scores complexity and routes execution. You save tokens
          on what's simple and concentrate firepower on what's critical.
        </p>

        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {tiers.map((t, i) => (
            <div
              key={t.name}
              className="relative rounded-2xl border border-border/80 bg-card/40 p-6 transition-colors hover:border-border"
            >
              <div className="flex items-center justify-between">
                <span
                  className="rounded-md border px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider"
                  style={{
                    borderColor: `color-mix(in oklab, ${t.color} 45%, transparent)`,
                    background: `color-mix(in oklab, ${t.color} 14%, transparent)`,
                    color: t.color,
                  }}
                >
                  Tier {i + 1}
                </span>
                <Cpu className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="mt-5 font-display text-[20px] font-medium">{t.name}</div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{t.desc}</p>
              <div className="mt-5 border-t border-border/60 pt-3 text-[11px] font-mono text-muted-foreground">
                {t.stack}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Reflection ───────────────────────── */

function Reflection() {
  const steps = [
    "Mission completes",
    "Reflection evaluates outcome",
    "Score quality & compare models",
    "Store successful patterns",
    "Update routing & prompts",
    "Future runs improved",
  ];
  return (
    <section id="reflection" className="relative border-t border-border/60">
      <div className="mx-auto grid max-w-7xl gap-14 px-6 py-24 lg:grid-cols-[1fr_1.05fr] lg:py-32">
        <div>
          <SectionLabel>Self-improvement</SectionLabel>
          <h2 className="mt-3 font-display text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[48px]">
            Apollo gets sharper after every mission.
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted-foreground">
            The Reflection Agent doesn't just close the loop — it tightens it. Each completed mission updates
            routing tables, prompt versions and memory embeddings, so the next run is faster, cheaper and more accurate.
          </p>
          <ol className="mt-8 space-y-3">
            {steps.map((s, i) => (
              <li
                key={s}
                className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/40 px-4 py-3"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border/70 bg-card text-[11px] font-mono text-[color:var(--color-cyan)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-[14px]">{s}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="surface-glass rounded-2xl border border-border/80 p-6">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              memory · reflection.jsonl
            </div>
            <div className="text-[11px] font-mono text-muted-foreground">v17</div>
          </div>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-border/60 bg-background/60 p-5 text-[12.5px] leading-[1.7] text-muted-foreground">
{`{
  "task_type":     "react architecture",
  "best_model":    "claude-sonnet",
  "success_score": 0.93,
  "latency_s":     1.24,
  "tokens":        184200,
  "prompt_version": 17,
  "router_update": {
    "from": "gpt-mini",
    "to":   "claude-sonnet",
    "reason": "+0.18 quality, +0.02s"
  }
}`}
          </pre>
          <div className="mt-4 grid grid-cols-3 gap-2 text-[11px] font-mono">
            {[
              { k: "missions", v: "12,481" },
              { k: "avg score", v: "0.91" },
              { k: "routing Δ", v: "+18%" },
            ].map((m) => (
              <div key={m.k} className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.k}</div>
                <div className="mt-0.5 text-foreground">{m.v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Security ───────────────────────── */

function Security() {
  const items = [
    { icon: Lock, title: "BYOK", body: "Bring your own keys for every provider. We never store model credentials in plaintext." },
    { icon: ShieldCheck, title: "Private execution", body: "Run sensitive missions through self-hosted models. Your data never leaves your perimeter." },
    { icon: Layers, title: "Encryption end-to-end", body: "TLS in transit, AES-256 at rest. Full audit logs for every agent action." },
  ];
  return (
    <section id="security" className="relative border-t border-border/60">
      <div className="mx-auto max-w-7xl px-6 py-24 lg:py-32">
        <SectionLabel>Security</SectionLabel>
        <h2 className="mt-3 max-w-3xl font-display text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[48px]">
          Enterprise-grade by default.
        </h2>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {items.map((i) => (
            <div key={i.title} className="rounded-2xl border border-border/80 bg-card/40 p-7">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/80 bg-background/60">
                <i.icon className="h-4.5 w-4.5 text-[color:var(--color-cyan)]" />
              </div>
              <h3 className="mt-5 font-display text-[18px] font-medium">{i.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">{i.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Final CTA ───────────────────────── */

function FinalCta() {
  return (
    <section className="relative border-t border-border/60">
      <div className="mx-auto max-w-5xl px-6 py-28 text-center lg:py-36">
        <ApolloMark className="mx-auto h-12 w-12 opacity-90" />
        <h2 className="mt-8 font-display text-[40px] font-semibold leading-[1.05] tracking-[-0.025em] sm:text-[56px]">
          Stop prompting.{" "}
          <span className="text-plasma">Start orchestrating.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-[16px] text-muted-foreground">
          Give Apollo a goal. Watch the mission run itself.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/login">
            <Button size="lg" className="h-12 px-7 text-[14px] font-medium glow-plasma">
              Launch your first mission
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
          <a href="#architecture">
            <Button size="lg" variant="outline" className="h-12 border-border/80 bg-card/40 px-7 text-[14px]">
              Read the system
            </Button>
          </a>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Footer ───────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-6 py-10 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5">
          <ApolloMark className="h-6 w-6" />
          <span className="font-display text-sm font-semibold tracking-[0.18em]">APOLLO</span>
          <span className="ml-3 text-[12px] text-muted-foreground">Mission Control for Autonomous Intelligence</span>
        </div>
        <div className="flex items-center gap-6 text-[12px] text-muted-foreground">
          <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
          <Link to="/terms" className="hover:text-foreground">Terms</Link>
          <Link to="/cookies" className="hover:text-foreground">Cookies</Link>
        </div>
      </div>
    </footer>
  );
}

/* ───────────────────────── helpers ───────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/50 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
      <span className="h-1 w-1 rounded-full bg-[color:var(--color-cyan)]" />
      {children}
    </div>
  );
}

# Apollo — Architecture

Status: v0 foundation (2026-07). This document describes what exists and where it is going.
The design goal is a small, honest kernel that surfaces (CLI, desktop) project — not a framework.

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│ Surfaces          cli · dashboard · Tauri Desktop             │
│                   all control/render the runtime contract      │
├───────────────────────────────────────────────────────────────┤
│ Orchestration     @archic/apollo-core                         │
│                   Pipeline: plan → route → execute → verify   │
│                   EventBus + JSONL sink + run summaries       │
├──────────────────────────────┬────────────────────────────────┤
│ Routing                      │ Memory                         │
│ @archic/apollo-router        │ @archic/apollo-memory          │
│ ModelRegistry · Router       │ MemoryPort → Midas (MCP)       │
│ explainable decisions        │ InMemoryMemory for tests       │
├──────────────────────────────┴────────────────────────────────┤
│ Agent             @archic/apollo-agent                        │
│                   runAgent loop · ToolRegistry · runStructured│
│                   built-in tools · over the provider port     │
├───────────────────────────────────────────────────────────────┤
│ Providers         @archic/apollo-providers                    │
│                   one streaming port + tool calls / JSON ·    │
│                   Anthropic (SDK) · OpenAI (SDK) · Google ·   │
│                   Ollama · Codex + Gemini-CLI (subscription)  │
│                   ProviderHub: nativeId mapping + real cost   │
├──────────────────────────────┬────────────────────────────────┤
│ Auth                         │ Verification                   │
│ @archic/apollo-auth          │ @archic/apollo-verify          │
│ detect+reuse CLI logins      │ file-block apply (path-jailed) │
│ (Claude Code, Codex, Gemini) │ + command verifiers + retry    │
├──────────────────────────────┴────────────────────────────────┤
│ Config & wiring   @archic/apollo-config (apollo.config.json)  │
│                   @archic/apollo-mcp (stdio MCP → Midas)      │
└───────────────────────────────────────────────────────────────┘
```

The kernel (core, router, memory, config, verify, auth, dashboard) has zero runtime dependencies;
the adapter packages carry the official SDKs (`@anthropic-ai/sdk`, `openai`,
`@modelcontextprotocol/sdk`). Cross-package imports go through each package's public entry
(`src/index.ts`).

## The dashboard (`@archic/apollo-dashboard`)

The desktop surface is, literally, a renderer of the event stream — so it is built as one. A
dependency-free HTTP server (Node built-ins only) serves a self-contained vanilla SPA, read APIs,
a loopback-only mission-control API, and an SSE endpoint
(`/api/stream`). Because run logs are append-only JSONL, the SSE endpoint tails them by polling
line counts and emitting the new events — an in-flight run streams into the UI live, with no shared
channel between the run process and the dashboard. Route logic (`resolveApiRoute`) is pure and
unit-tested; run ids are validated against traversal.

Control records make running, stopped, canceled, and retried missions visible independently of a
webview. The UI is an instrument panel, not a chat window: a mission launcher plus a runs table where each row opens the full event
timeline (routing decisions with their scoring, escalation, verification), the model fleet with
capability bars and cost/subscription/local tags, and aggregate stats. One warm accent (Apollo, the
sun) over a near-black canvas; monospace for data. Tauri packages the runtime bundle and Node, then
points a webview at this same localhost app. `summarizeRun` /
`listRunSummaries` live in core so the CLI (`runs`, `replay`) and the dashboard describe a run
identically.

## Tool calls & the agentic loop (`@archic/apollo-agent`)

The provider port carries optional capabilities beyond text: `tools` (definitions with a JSON-Schema
`parameters`), `toolChoice`, and `responseFormat` (schema-constrained JSON). The `ChatMessage` type
is a union — plain, assistant-with-tool-calls, and tool-result — so a full multi-turn tool
conversation is provider-agnostic; `messages.ts` unpacks it into each provider's native shape. Tool
calls are implemented natively across **all six adapters**: Anthropic (SDK `tool_use`/`tool_result`
blocks), OpenAI (streamed `tool_calls` accumulated by index), Google Gemini and Gemini-CLI (shared
`functionCall`/`functionResponse` parts + `functionCallingConfig`, one implementation in
`gemini-shared.ts`), Codex (Responses-API `function_call` / `function_call_output` items), and Ollama
(object-arg tool calls, non-streamed). Structured output uses each provider's best path: OpenAI
`json_schema`, Gemini `responseSchema`, Codex `text.format`, Anthropic/Ollama a forced single tool
whose input is the answer. The `ProviderHub` still gates on `supportsTools`/`supportsResponseFormat`
so a request is never silently dropped.

`runAgent` is the loop: complete → if the model called tools, execute them via a `ToolRegistry` and
append the results to the transcript → repeat until it answers in text (or the step budget is spent).
A thrown tool handler becomes an error string the model reads back, so it can recover instead of
crashing the run; the full transcript (calls + results) is retained, so an agent run is as auditable
as any other. `runStructured` wraps the schema path into a typed, parsed result. `builtinTools`
ships read-only, path-jailed tools (calculator, current time, list_dir, read_file). `apollo agent
"<prompt>"` routes to a tool-capable model (requiring the `tool-use` capability, denying providers
whose adapter can't do tools) and runs the loop with live events and recording.

**MCP tools as agent tools.** `mcpTools(client, prefix)` turns every tool an MCP server exposes into
an `AgentTool` (definition from the server's `inputSchema`, handler = `callTool`), namespaced to
avoid collisions. This is the bridge to the whole MCP ecosystem — and specifically to Midas:
`apollo agent --mcp` spawns the configured Midas server and hands the agent `midas__recall`,
`midas__build_context`, `midas__remember`, and the rest, so long-horizon memory becomes something
the model can actively reach for mid-task, not just context stuffed into the prompt. The bridge takes
a structural `McpToolSource` interface, so `@archic/apollo-agent` stays decoupled from
`@archic/apollo-mcp`.

## Adaptive execution depth (`@archic/apollo-cortex`)

`runCortex` selects the cheapest safe lane before it contacts a model. The selector is local,
deterministic, effectively free, visible as `depth.selected`, and overridable with
`--depth auto|instant|agent|deep`:

- **INSTANT** — exact greetings and acknowledgements resolve locally with zero provider calls; a
  caller-forced instant prompt uses one text completion. No planner, critic, verifier, tools, or
  memory startup. The response is streamed and recorded as one verified execution.
- **AGENT** — ordinary work uses one routed `runAgent` loop. Independent read tools may execute in
  parallel; any batch containing a write or shell action stays ordered. File changes are reread,
  shell exits and user checks are evaluated deterministically, and policy gates remain authoritative.
- **DEEP** — complex, high-risk, architectural, research, security, deployment, destructive, or
  explicitly forced work runs Apollo's full [cortex-harness](https://github.com/vornicx/cortex-harness)
  adaptation: **PLAN → (ACT → CRITIC)+ → VERIFY → FINALIZE**.

The deep lane keeps the guardrails that make even a weak model behave like a first-line agent:

- **PLAN** — a structured plan (steps with dependencies, per-step expected outcomes, read-only
  `doneCriteria`, a justified confidence) via `runStructured`.
- **ACT** — each step runs the agentic loop with tools; the executor reports through a deterministic
  line protocol (`INTENT`, `BELIEF[key]`, `STEP_DONE[id]`, `STEP_FAILED[id]`) so the harness — not
  the model's goodwill — owns step transitions and a working memory of beliefs.
- **CRITIC** — an adversarial reviewer of each step assumes over-claiming and can veto, forcing a
  replan with concrete feedback.
- **VERIFY** — an independent judge checks every `doneCriterion` against the *real evidence* in the
  transcript (tool outputs, not assertions) before anything is finalized.
- **META** — a controller watches for loops (action signatures: three repeats or A-B-A-B), budget,
  and turns; a first loop forces a replan, a second an **honest stop**. Nothing is ever reported as
  succeeded that wasn't verified.

**What makes the deep lane "maximally Apollo":** cortex-harness hardcodes an orchestrator/worker model split.
Apollo routes *each cognitive phase through the autorouter* as its own task kind — PLAN as
`planning`/frontier (strongest reasoning), CRITIC as `code-review`/hard, VERIFY as `debugging`/hard,
each step as its own kind — so the strongest reasoning model plans and criticizes while cheaper
models act, and it falls out of the routing data. Every phase emits typed Apollo events
(`plan.produced`, `step.started/finished`, `belief.recorded`, `critic.reviewed`, `meta.stop`), so
every lane streams output and progress to the dashboard and records to `.apollo/runs` like any other run.
It runs over the `ProviderHub` (subscriptions + tool calls) and its executor can use MCP tools —
including Midas memory. `apollo cortex "<goal>"` drives it.

## Subscription auth (`@archic/apollo-auth`)

Apollo does not reimplement vendor OAuth. It **detects and reuses the sessions the official CLIs
already create**, so a user's Claude, ChatGPT/Codex, and Gemini subscriptions become routable
models at marginal cost 0 — and because the router weights cost, it prefers them over metered APIs
for free. Resolution is read-only and per provider: Claude Code session (`~/.claude/.credentials.json`)
or `ant` profile for Anthropic; `codex login` token (`~/.codex/auth.json`, JWT-expiry aware) for
OpenAI's Codex backend; Gemini CLI "Login with Google" (`~/.gemini/oauth_creds.json`, refreshed
in-memory via the CLI's public client constants) for Google. `apollo login <provider>` launches
the vendor's own CLI; Apollo never writes their credential files. `apollo auth` shows the live
status. Subscription tokens authenticate as the user's plan; if a vendor restricts a token to its
own surface, that provider fails cleanly and the pipeline escalates — Apollo adds no evasion.
Cursor has no public programmatic API (closed editor protocol) and is unsupported.

## Workspace verification (`@archic/apollo-verify`)

This is what turns "verified pipeline" from structural into substantive — the anti-vibecoding core.
Models emit complete files in a `` ```file:<path> `` convention (no tool-calling needed, so it works
on every provider). `apollo run --apply <dir>` parses those blocks and writes them **path-jailed**
into the workspace (traversal and absolute paths refused — model output is untrusted). `--verify
"<cmd && cmd>"` then runs real checks (tests, typecheck, anything with an exit code) in that
workspace. On failure, the verifier's command, exit code, and output tail are fed back into the
next attempt's prompt for a **self-correcting retry** — layered on top of the router's model
escalation. Nothing is reported done unless the files applied and every verifier exited 0.

## Providers (`@archic/apollo-providers`)

`ProviderAdapter` is one method: `complete(request, onDelta?)` — streamed text completion with
normalized usage and stop reason. Adapters are duck-typed over the slice of each SDK they use,
so tests inject fakes and run without a network. `ProviderHub` resolves a routed `ModelProfile`
to its adapter, translates the Apollo id to the provider-native name (`nativeId`), and prices
the **reported** usage against the profile — estimated cost at routing time, real cost at
completion time, both on the event stream. Secrets never touch config files: `apollo.config.json`
references environment variable names. Tool calls and structured outputs extend the port in M1.5.

## The autorouter (`@archic/apollo-router`)

The router answers one question deterministically: *given this task and this policy, which
configured model should do the work — and why?*

- **ModelProfile** — data, not code: capabilities per dimension (`code`, `reasoning`, `writing`,
  `vision`, `tool-use`, `long-context`, each 0..1), cost per MTok in/out, typical latency
  (TTFT + tokens/sec), context window, output cap. Ships with seed defaults (Anthropic figures
  from official docs; other providers flagged as estimates); users override everything.
- **TaskSpec** — kind (`planning`, `code-generation`, `debugging`, …), complexity
  (`trivial | standard | hard | frontier`), hard capability requirements, token estimates,
  latency mode.
- **Scoring** — quality is the capability mix for the task kind; cost and speed are estimated per
  task and min-max normalized across surviving candidates. Weights come from complexity (trivial
  optimizes spend, frontier optimizes quality), shifted toward speed for interactive tasks, and
  overridable per policy.
- **Hard filters first, with reasons**: disabled, denied, missing required capability, context
  window too small, output cap too small, over budget. Then a *soft* quality floor per complexity —
  if nothing passes the floor, the floor relaxes and the decision says so.
- **RoutingDecision** — the chosen candidate, the full ranked list (which doubles as the
  escalation chain), every elimination with its reason, the resolved weights, and a one-line
  human explanation. Sorting is deterministic (score, then cost, then id): same inputs, same route.

Phase-aware routing is the core Archic thesis encoded here: the pipeline routes each phase as its
own task kind — planning routes to the reasoning-strongest model, execution to the coding-strongest,
so "the strongest reasoning model plans; the strongest coding model acts" falls out of the data.

## The verified pipeline (`@archic/apollo-core`)

```
plan ──▶ route ──▶ execute ──▶ verify ──▶ done
                      ▲            │
                      └─ escalate ─┘  (failed verification → next ranked model,
                                       up to maxAttempts)
```

`Pipeline<Plan>` is generic and engine-only: it owns the lifecycle, retries, and event emission;
the wiring (CLI today, desktop later) supplies `plan / execute / verify` hooks and composes the
router into them. `verify` failing feeds the attempt number back into `execute`, which asks the
router's ranked list for the next candidate (`candidateForAttempt`). Thrown execution errors count
as failed attempts. Nothing is reported done unless verification passed.

Every step emits a typed event (`task.started`, `task.planned`, `routing.decided`,
`execution.started/completed/failed`, `verification.passed/failed`, `task.completed/failed`)
through `EventBus`, which also keeps an ordered in-memory log (`history()`). A `JsonlEventSink`
mirrors that stream to `.apollo/runs/<id>.jsonl` — every `run` and `demo` is recorded, and
`readEventLog` reads it back, so `apollo replay <file>` reconstructs any past run exactly as it
happened. The future desktop UI is a renderer of this same stream; so is the audit trail; so are
benchmarks — one format, live and on disk.

## Mission, outcome, and evidence

The stable unit of work is a versioned `Mission`, not a chat message. Cortex runs persist
`.apollo/missions/<id>/mission.json`, `outcome.json`, and `evidence.json`. The outcome is derived
from the event stream, and only real executions and verification results become evidence. Desktop
is a controller and renderer of this contract; it does not own execution state.

## Execution policy and audit

Workspace tools are classified as `read`, `write`, `shell`, or `critical`. A project may store a
versioned `.apollo/policy.json` with `allow`, `ask`, or `deny` for the three side-effecting classes.
Explicit mission approval satisfies `ask` but never overrides `deny`. Permission decisions are
typed events in the same append-only stream as routing and verification. Before JSONL persistence,
known credential shapes and credential-like object fields are replaced with `[REDACTED]`.

Memory evidence records the Midas entry id, provenance, and source. Recalled context is explicitly
informational and cannot grant permission for a tool or external action.

## The telemetry loop (`apollo stats` / `apollo calibrate`)

Model profiles start as seed estimates; the recorded event stream is the ground truth that
replaces them. `routing.decided` carries the task kind and `execution.completed` carries the
model, real cost, and token usage; every cortex phase emits its own execution pair, and
verification verdicts reference the attempt of the *acting* execution so credit/blame lands on
the model that did the work, not the verifier. `collectSamples`/`aggregateTelemetry` (core,
pure functions over the JSONL logs) derive per-model and per-kind measurements — wall time,
p50 time-to-first-token, effective end-to-end throughput, cost, verification pass rate. `apollo stats` renders them; `apollo calibrate`
proposes profile overrides **only for directly measured fields** (effective throughput today), and
`--write` merges them into `apollo.config.json` with the profile's unmeasured fields preserved.
Quality/capability numbers are deliberately not inferred from verify rates — that needs a
benchmark suite (M4), not a heuristic dressed up as data.

## The interactive session (`apollo`)

The no-argument entry point is the harness as a place to work, not a flag zoo: a readline REPL
where a typed goal runs the adaptive runtime with live events, and session state
(`/workspace`, `/check`, `/budget`, `/turns`, `/pin`, `/mcp`, `/yes`) persists across runs.
Destructive tool calls surface inline — `⚠ allow write_file(...)? [y/N/a=always]` — through the
same `confirm` hook the flags drive, so the human is in the loop per call instead of per run.
A single `LineSource` owns the readline stream (queued lines are never dropped, EOF ends the
session cleanly), which is also what makes the REPL scriptable: pipe commands in and it behaves.
Every interactive run records to `.apollo/runs` and streams to the dashboard like any other.

### One-shot-first agent lane

For ordinary workspace work, Cortex builds a bounded deterministic snapshot before asking the
model to act: a filtered tree, manifests, goal-relevant source and tests, plus baseline check
results. A private mode-0600 cache keyed by workspace reuses unchanged selected content using
nanosecond mtime and size, while changed/deleted files refresh or disappear. Observable signals
(target specificity, context breadth, truncation, workspace size and baseline evidence) produce
an auditable eligibility score. Small edit surfaces request complete files; large existing files
request exact unique SEARCH/REPLACE patches.

Patches are materialized entirely in memory. Apollo then validates all paths and symlink segments,
requests policy approval per write, stages every output and backup on the workspace filesystem, and
commits the group. An apply error restores committed originals before surfacing failure. Successful
changes are reread and explicit or inferred checks run outside the model.

`NEEDS_AGENT`, truncated output, an unsafe apply, or failed verification emits
`one_shot.fallback` and enters the existing tool loop with the failure and current-workspace state;
already-applied work is not discarded. Destructive/high-risk goals bypass this lane and keep the
deep cycle. `--no-one-shot` is the explicit escape hatch for debugging or comparisons.

## Memory (`@archic/apollo-memory`)

`MemoryPort` mirrors the real Midas surface — `remember` (content, kind
`note|chat|fact|preference|constraint|mission`, importance 1–5 or 0=auto, provenance, session),
`recall` (query, limit, hybrid lexical+semantic), `buildContext` (query, token budget → prompt-ready
block), `forget`. Two implementations:

- `MidasMemory` — maps the port onto Midas MCP tool calls through an injected `McpToolClient`
  transport. The mapping is real; the MCP client wiring lands in M1 when Apollo runs as an MCP host.
- `InMemoryMemory` — functional, tested; used by tests and as a fallback.

The intended loop: `buildContext` before planning, `remember` durable outcomes after verification.

## Deliberate constraints

- **Zero runtime deps** in the kernel. Everything auditable, nothing rotting.
- **Determinism over cleverness.** Same registry + same task + same policy = same decision.
- **Data over config logic.** Model profiles, capability mixes, and complexity weights are plain data —
  benchmarkable, overridable, and eventually learned from Apollo's own telemetry.
- **Honest scaffolding.** Simulated things say "simulated". Stubs document exactly what is missing.

## Roadmap

- **M0 ✅** — router + pipeline + memory port + CLI demo, typed events, tests green.
- **M1 ✅ (core)** — provider adapters behind one streaming port; real execution via
  `apollo run` (verified live against local Ollama); Midas stdio MCP transport;
  `apollo.config.json` for user models/keys/policies.
- **M1.5 ✅** — subscription login (Claude Code / Codex / Gemini CLI reuse, cost-0 routing);
  workspace executor: file-block apply (path-jailed) + command verifiers + self-correcting
  retry (verified live against local Ollama); `apollo login` / `apollo auth`.
- **M1.6 ✅** — JSONL event sink + `apollo replay` / `apollo runs` (verified live); rate-limit
  backoff for the fetch-based adapters.
- **M2 ✅ (core)** — local-first dashboard: HTTP + SSE server + premium vanilla SPA rendering the
  recorded and live event stream (runs, per-run timelines, model fleet, aggregate stats). Verified
  over real HTTP incl. live SSE during a run.
- **M2.5 ✅ (tools)** — tool calls + structured output on the provider port (Anthropic/OpenAI/Ollama),
  the agentic loop (`@archic/apollo-agent`, `apollo agent`) with built-in tools — verified live
  against a local tool-capable model.
- **M2.6 ✅ (tools everywhere + MCP)** — tool calls + structured output for the remaining adapters
  (Google, Gemini-CLI, Codex), and MCP tools as agent tools (`apollo agent --mcp`, Midas bridge) —
  verified live (real Midas server spawned, `midas__recall` called inside the loop).
- **M2.7 ✅ (adaptive Cortex)** — deterministic instant/agent/deep selection, one-call conversation,
  a single-agent lane with deterministic post-checks, and the full autorouted
  plan→(act→critic)+→verify→finalize cycle for complex/high-risk work. `apollo cortex --depth`.
- **M2.7.1 ✅ (one-shot harness)** — bounded relevance-ranked workspace snapshots, complete-file
  one-shot edits, prevalidated and permission-gated apply, inferred deterministic checks, and a
  state-preserving fallback to the tool loop. `apollo cortex --no-one-shot` disables it.
- **M2.7.2 ✅ (incremental + transactional)** — private incremental snapshot cache, measured
  one-shot score, automatic full-file/exact-patch mode, symlink-safe transactional apply with
  rollback, and schema-v5 benchmark telemetry for policy decisions.
- **M2.8 ✅ (real work + safety)** — workspace tools (`write_file`/`edit_file`/`run_command`,
  path-jailed, destructive-flagged) for the agent and cortex executor; per-tool permission gating
  (confirm policy → CONFIRMATION_REQUIRED); parallel independent reads with ordered side effects; the verifier's active
  read-only tool loop. Verified live: `--workspace --yes` wrote a real file in the jail.
- **M2.9 ✅ (ground truth + UI)** — deterministic (no-model) verifier checks (`file_exists`,
  `file_contains`, `command_succeeds`) the harness runs itself, planner-emitted and user-enforced
  (`apollo cortex --check …`), so a model can't hallucinate past a failing file/command check;
  dashboard run search + two-run diff. Verified live + unit-tested over real fs/shell.
- **M3 ✅ (telemetry loop + interactive)** — measured telemetry over the recorded runs
  (`apollo stats`: TTFT, wall time, effective throughput, cost, verification outcomes per model and task kind) and
  measurement-backed profile calibration (`apollo calibrate --write`); the event stream now carries
  task kind and token usage per execution, and every cortex phase is an execution on the stream.
  Plus the interactive terminal session (`apollo` no-arg REPL) with inline destructive-tool
  confirmation — the "interactive confirm in a TUI" item, done. Verified live (real cortex run →
  measured 61 tok/s vs 80 seed → override written).
- **M3.5 ✅** — autonomous native shell: Tauri embeds Apollo Runtime and Node and controls missions.
- **M4 ✅ alpha** — repeated benchmark reports compare model-only, model-tools, single, and routed
  variants with confidence intervals; Midas context is provenance-aware and enabled by default.

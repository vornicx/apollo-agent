# Apollo

**A local-first AI harness with an explainable autorouter, verified pipelines, and durable memory.**
Second infrastructure component of [Archic](https://github.com/vornicx) (the first is
[Midas](https://github.com/vornicx), Apollo's memory layer).

Apollo first chooses the minimum safe execution depth, then routes each necessary model call by
specialization, quality, cost, and measured speed across every provider, subscription, and API you
configure. Exact greetings answer locally with zero provider calls. Normal workspace work starts
with one bounded, incrementally cached context snapshot. Small surfaces use complete files; large
existing files use exact unique SEARCH/REPLACE patches. The harness applies permitted output as a
rollback-capable transaction and runs deterministic checks. Only insufficient one-shots fall through to the tool loop;
complex or high-risk work pays for the full plan/critic/verifier cycle. Nothing is reported done
unless its lane's verification contract passed; every decision is explainable.

> Vision: [docs/VISION.md](docs/VISION.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Performance: [docs/PERFORMANCE.md](docs/PERFORMANCE.md) · Security: [docs/SECURITY.md](docs/SECURITY.md)

## Quickstart

```bash
npm install
npm test                 # unit tests across all packages
npm run typecheck

npm run apollo                   # INTERACTIVE: adaptive instant → agent → deep runtime
npm run apollo -- "Fix the failing tests" --workspace . --yes  # one verified mission
npm run apollo -- login openai   # reuse your Codex / Claude / Gemini CLI logins
npm run apollo -- auth           # which providers Apollo can use right now
npm run apollo -- init           # write apollo.config.json (env-referenced keys, your models)
npm run apollo -- models
npm run apollo -- route --kind code-generation --complexity hard --explain
npm run apollo -- run "Explain SSE vs WebSockets tradeoffs" --kind research   # real, streamed
npm run apollo -- agent "What is 4891 * 12? Use the calculator." # tool-calling loop
npm run apollo -- agent "Recall what Apollo is." --mcp             # Midas memory as a tool
npm run apollo -- cortex "Fix the failing test and prove it passes"  # full cognitive cycle
npm run apollo -- cortex "hola" --depth instant     # force: auto|instant|agent|deep
npm run apollo -- cortex "Fix it" --workspace . --no-one-shot # force the tool loop
npm run apollo -- stats          # measured telemetry per model/kind from your recorded runs
npm run apollo -- calibrate --write   # write measured overrides into apollo.config.json
npm run apollo -- benchmark --variant all --repeat 3 --limit 1
npm run apollo -- dashboard      # mission center: launch, stream, cancel, retry
npm run build:desktop            # autonomous .deb + AppImage (embedded runtime)
npm run apollo -- demo           # simulated walkthrough, no keys needed
```

`apollo` with no arguments opens the **interactive session** — a Claude-Code-style REPL: type a
goal and the adaptive runtime runs it with live events; destructive tool calls ask for
confirmation inline (`[y/N/a=always]`); `/workspace`, `/check`, `/budget`, `/pin`, `/mcp`,
`/login`, `/stats` manage the session; every run records to `.apollo/runs` like any other.

**Global command:** `npm link` installs `apollo` on your PATH (the package ships a `bin`). Outside
a project, config resolution falls back to `~/.config/apollo/apollo.config.json` (XDG), so your
models, keys, and Midas wiring work from any directory — point that file (or a symlink) at your
real config once.

`run` routes the task, streams the completion from the chosen provider, prices the **real**
token usage, verifies, and escalates to the next ranked model on failure. In workspace mode
(`--apply <dir> --verify "<cmd>"`) it writes the model's file blocks into a directory, runs your
checks (tests, typecheck, anything with an exit code), and on failure feeds the error back for a
self-correcting retry — the anti-vibecoding core. `--dry` shows the decision only; `--memory`
prepends Midas context.

Every run and demo **records its event stream** to `.apollo/runs/<id>.jsonl`. `apollo runs` lists
them with outcomes; `apollo replay <file>` re-renders any past run exactly as it happened. This is
the audit trail: every routing decision, escalation, and verification is inspectable after the fact.

`apollo dashboard` opens the **local mission center** (default `http://127.0.0.1:4317`). It creates
missions against a selected workspace, streams their events, surfaces `needs_input`, and can cancel
or retry with human clarification. The Tauri package embeds both a bundled Apollo Runtime and Node,
so the installed Desktop does not depend on a global `apollo` command. Execution and evidence still
belong to the runtime; Desktop remains a controller.

Project permissions live in `.apollo/policy.json`. The default asks before writes and normal shell
commands and denies critical commands even when `--yes` is supplied. Each decision is recorded as
`permission.decided`; credential-shaped values are redacted before JSONL persistence.

### Login: bring your subscriptions

Apollo reuses the sessions created by each vendor's official CLI, so your **Claude, ChatGPT/Codex,
and Gemini subscriptions** become routable models at **marginal cost 0** — and the autorouter
prefers them over metered APIs.

| Provider | How Apollo authenticates |
|---|---|
| Anthropic (Claude Pro/Max) | `claude` → `/login`, or `ant auth login`, or `ANTHROPIC_API_KEY` |
| OpenAI (ChatGPT Plus/Pro) | `codex login` (Codex CLI), or `OPENAI_API_KEY` |
| Google (Gemini) | `gemini` → "Login with Google", or `GEMINI_API_KEY` |
| Local | Ollama — no login |
| Cursor | No public API (closed proprietary protocol) — not supported |

Apollo never reimplements a vendor OAuth flow or writes their credential files: `apollo login`
launches the official CLI, and Apollo reads the resulting session read-only. Subscription tokens
authenticate as your plan; if a vendor restricts a token to its own surface, that provider fails
cleanly and the pipeline escalates.

## Packages

| Package | What it is | State |
|---|---|---|
| `@archic/apollo-router` | Autorouter: model registry, task taxonomy, explainable scoring, escalation chain | Working, tested |
| `@archic/apollo-core` | Pipeline engine (plan → route → execute → verify, retry/escalate) + typed EventBus + JSONL sink/replay + run summaries + **measured telemetry & calibration** over recorded runs | Working, tested |
| `@archic/apollo-dashboard` | Local-first HTTP + SSE server (Node built-ins) + premium vanilla SPA: runs (with live search + two-run diff), timelines, fleet, live stream | Working, tested; served + streamed live over HTTP |
| `@archic/apollo-memory` | `MemoryPort` mirroring Midas; `InMemoryMemory` impl + `MidasMemory` MCP adapter | Working, tested |
| `@archic/apollo-providers` | One streaming port over Anthropic & OpenAI (SDKs), Google & Ollama (REST), plus Codex & Gemini-CLI subscription backends + `ProviderHub` real-cost pricing; **tool calls + structured output on all six adapters** | Working, tested; live against Ollama |
| `@archic/apollo-agent` | Agentic loop (`runAgent`): tool registry, complete→call-tools→feed-results, `runStructured`, built-in + **workspace tools** (write/edit/run_command, jailed), permission gating, concurrent reads with ordered side effects, **MCP-tools bridge** | Working and tested |
| `@archic/apollo-cortex` | **Adaptive runtime**: deterministic `instant`/`agent`/`deep` selection; scored one-shot eligibility, incremental snapshots, automatic full-file/patch mode, deterministic verification and state-preserving fallback, or full plan → (act → critic)+ → verify → finalize. | Working and tested; seven editing tasks verified live at one call each |
| `@archic/apollo-benchmark` | Reproducible isolated workspaces, eleven core tasks, targeted `--task` runs, one-shot/patch/snapshot metrics, false-success accounting, JSON reports | Working, tested; routed and single-model suites verified live at 10/10 |
| `@archic/apollo-desktop` | Autonomous Tauri controller with embedded runtime; create/cancel/retry missions while evidence remains runtime-owned | Alpha packaging for `.deb` and AppImage |
| `@archic/apollo-auth` | Detects & reuses official CLI logins (Claude Code, Codex, Gemini CLI) so subscriptions route at cost 0 | Working, tested |
| `@archic/apollo-verify` | Workspace file application (`file:` blocks, path-jailed) + command verifiers (tests/typecheck) | Working, tested |
| `@archic/apollo-config` | `apollo.config.json` loader: your models, env-referenced credentials, policy, Midas wiring | Working, tested |
| `@archic/apollo-mcp` | Stdio MCP client (official MCP SDK) connecting `MidasMemory` to a live Midas server | Working; result-parsing tested |
| `@archic/apollo-cli` | CLI surface: **interactive session** (no-arg REPL with inline destructive-tool confirmation), `login`, `auth`, `init`, `models`, `route`, `run` (+ workspace mode), `agent`, `cortex`, `runs`, `stats`, `calibrate`, `replay`, `dashboard`, `demo` | Working; `run`/`agent`/`cortex`/interactive verified end-to-end |

Kernel (core/router/memory/config/verify/auth) has zero runtime dependencies; adapter packages
carry the official SDKs (`@anthropic-ai/sdk`, `openai`, `@modelcontextprotocol/sdk`). TypeScript
strict. Node ≥ 22.

## Honesty table

What is real today vs. what is not yet:

- ✅ Routing decisions, scoring, eliminations, escalation order — real and tested.
- ✅ Pipeline lifecycle, verification gate, escalation on failure, event stream — real and tested.
- ✅ Provider execution with streaming and real usage-based cost — verified live (Ollama); all other adapters (Anthropic/OpenAI/Google/Codex/Gemini-CLI) are contract-tested against their wire shapes.
- ✅ Subscription login detection & reuse — Claude Code, Codex, and Gemini CLI sessions detected from disk (tested); read-only, refresh handled by the vendor CLI.
- ✅ Workspace mode: file-block application (path-jailed) + command verifiers + self-correcting retry — tested; loop verified live against local Ollama.
- ✅ Recorded + replayable runs: every run/demo persists its event stream to JSONL; `runs`/`replay` reconstruct it from disk — tested and verified live.
- ✅ Local dashboard: HTTP + SSE server serving the SPA and live run stream — verified over real HTTP (HTML, all API routes, live SSE during a run); client JS is syntax-checked. Note: rendered pixels weren't screenshot-verified in this environment (static CSS + vanilla JS over the verified API).
- ✅ Tool calls + structured output on the provider port for **all** adapters — Anthropic & OpenAI (SDK native), Google Gemini & Gemini-CLI (functionDeclarations / responseSchema), Codex (Responses API function tools), Ollama — contract-tested per wire shape; the agentic loop (`apollo agent`) verified live against a local model (calculator called + result fed back; schema-constrained JSON parsed).
- ✅ MCP tools as agent tools (`apollo agent --mcp`): any MCP server's tools become callable by the agent — verified live spawning the real Midas server and calling `midas__recall` against on-disk memory inside the loop.
- ✅ Adaptive Cortex (`apollo cortex`, `--depth auto|instant|agent|deep`): deterministic selection keeps greetings local and scores ordinary workspace work from observable context signals. Snapshots reuse unchanged content from a private local cache; small edits use complete files and large ones use exact unique patches. Every write is permission-gated, symlink-safe and transactionally rolled back on apply failure; changed files are reread and checks run outside the model. Insufficient or failed attempts continue from the current workspace in the tool loop; `--no-one-shot` disables the fast path.
- ✅ Workspace tools + permission gating: `write_file`/`edit_file`/`run_command` (path-jailed, marked destructive) plus read tools; destructive calls are gated by a confirm policy (`--yes` / `--confirm`) — denied calls return CONFIRMATION_REQUIRED, never run. Tool calls in a turn run in parallel. Verified live: `apollo agent --workspace <dir> --yes` had the model call `write_file` and a real file appeared in the jail; unit tests cover writes, jailing, the non-unique-edit guard, shell, and gating.
- ✅ Deterministic verifier checks: the planner emits machine-checkable criteria (`file_exists`, `file_contains`, `command_succeeds`) and you can enforce your own with `apollo cortex --check "file_exists:out.py ; command_succeeds:pytest"` — the harness verifies these against the real workspace **itself, no model in the loop**, so a model can't hallucinate past ground truth. Verified live (checks reported the real filesystem state and failed verification when a claimed file was absent) and by unit tests over real fs/shell.
- ✅ Dashboard run search + diff: filter recorded runs live, and select two to compare side-by-side (status, model, cost, attempts, and event-type sequence with differences gold-highlighted) — served and verified over real HTTP.
- ⚠️ Honest limit: with a *weak* model (a 1B) the model-judged phases can still be fooled, but the **deterministic checks are not** — they close the hallucination gap for any criterion expressible as a file/command check. Prose-only criteria still lean on the model verifier; a capable model drives the whole cycle honestly.
- ✅ Native Desktop embeds Apollo Runtime and Node, exposes mission control, and targets `.deb` plus AppImage; CI builds tagged Linux prereleases.
- ✅ Rate-limit/transient resilience: fetch-based adapters (Google, Ollama, Codex, Gemini-CLI) retry 429/408/5xx with exponential backoff — tested.
- ✅ Midas port mapping — matches Midas v0.1.x; stdio MCP transport implemented.
- ⚠️ Subscription-token execution reuses vendor sessions; a vendor may restrict its token to its own client. Apollo fails cleanly and escalates if so — it adds no evasion.
- ⚠️ Provider profiles begin as seed estimates — but Apollo learns p50 TTFT and effective
  end-to-end throughput from recorded runs. `apollo calibrate` stores effective throughput
  separately, preserving the provider's raw generation-speed estimate.
- ✅ Routing telemetry loop (M3 core): every run records model, task kind, wall time, cost, and
  tokens per execution; `apollo stats` aggregates it per model/kind and `apollo calibrate --write`
  turns measured deviations into `apollo.config.json` overrides. Verified live: a real cortex run
  measured 61 tok/s against an 80 tok/s seed profile and the override was written. Only directly
  measured fields are proposed — quality/capability numbers stay human/benchmark-owned.
- ✅ Interactive terminal session (`apollo` with no args): goal → adaptive runtime with live
  events; per-call `[y/N/a]` confirmation for destructive tools; `/workspace /check /budget /pin
  /mcp /stats` session commands. Verified live end-to-end (piped session + a real cortex run over
  local Ollama with an honest turn-limit stop).
- ⚠️ `demo` remains a simulated walkthrough by design; Cursor is unsupported (no public API).
- ✅ Every Cortex mission writes a versioned `mission.json`, `outcome.json`, and `evidence.json`;
  memory used in planning is source-attributed and never treated as tool authority.
- ✅ `apollo benchmark` materializes isolated tasks and records measured reports. Full routed and
  single-model passes reached 10/10 with zero false successes; see
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md). They are integration evidence, not a universal score.

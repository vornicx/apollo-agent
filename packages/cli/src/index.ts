import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { createInterface, type Interface } from "node:readline/promises";
import {
  loginWith,
  resolveAnthropicAuth,
  resolveCodexAuth,
  resolveGeminiAuth,
  type AnthropicAuth,
  type CodexAuth,
  type GeminiAuth,
} from "@archic/apollo-auth";
import {
  EventBus,
  JsonlEventSink,
  Pipeline,
  createMission,
  listRunSummaries,
  proposeCalibration,
  redactText,
  readEventLog,
  summarizeRun,
  telemetryFromDir,
  outcomeFromEvents,
  writeMissionBundle,
  type StampedEvent,
  type Task,
} from "@archic/apollo-core";
import { startDashboard } from "@archic/apollo-dashboard";
import {
  builtinTools,
  decideToolCall,
  loadExecutionPolicy,
  mcpTools,
  runAgent,
  workspaceTools,
  type AgentStep,
} from "@archic/apollo-agent";
import { CORE_BENCHMARK_TASKS, runBenchmark, type BenchmarkTask, type BenchmarkVariant } from "@archic/apollo-benchmark";
import { describeCheck, localInstantReply, parseCheckSpecs, runChecks, runCortex, selectDepth, type Check, type CortexDepth } from "@archic/apollo-cortex";
import { CONFIG_FILENAME, buildRegistry, loadConfig, resolveCredentials, type ApolloConfig } from "@archic/apollo-config";
import { MidasMemory, buildGroundedContext, type MemoryEntry } from "@archic/apollo-memory";
import { StdioMcpClient } from "@archic/apollo-mcp";
import {
  AnthropicAdapter,
  CodexAdapter,
  GeminiCliAdapter,
  GoogleAdapter,
  OllamaAdapter,
  OpenAIAdapter,
  ProviderHub,
  type ChatMessage,
  type ToolCall,
} from "@archic/apollo-providers";
import {
  applyFileBlocks,
  FILE_BLOCK_INSTRUCTIONS,
  parseFileBlocks,
  runVerifiers,
} from "@archic/apollo-verify";
import {
  candidateForAttempt,
  COMPLEXITY_WEIGHTS,
  KIND_CAPABILITY_MIX,
  ModelRegistry,
  Router,
  RoutingError,
  type Capability,
  type Complexity,
  type RoutingDecision,
  type RoutingPolicy,
  type TaskKind,
  type TaskSpec,
} from "@archic/apollo-router";
import { defaultInitDependencies, runInitWizard } from "./init";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const TASK_KINDS = Object.keys(KIND_CAPABILITY_MIX) as TaskKind[];
const COMPLEXITIES = Object.keys(COMPLEXITY_WEIGHTS) as Complexity[];
const DEPTHS: CortexDepth[] = ["auto", "instant", "agent", "deep"];

function parseFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags.set(body, argv[++i]);
    } else {
      flags.set(body, true);
    }
  }
  return flags;
}

function fail(message: string): never {
  console.error(red(`error: ${message}`));
  process.exit(1);
}

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  return fail(`--${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
}

function table(headers: string[], rows: string[][], paint?: (cell: string, col: number, row: number) => string): string {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => row[col].length)),
  );
  const render = (cells: string[], row: number, painter?: typeof paint) =>
    cells
      .map((cell, col) => {
        const padded = cell.padEnd(widths[col]);
        return painter ? painter(padded, col, row) : padded;
      })
      .join("  ");
  return [dim(render(headers, -1)), ...rows.map((row, i) => render(row, i, paint))].join("\n");
}

// ── shared wiring ───────────────────────────────────────────────────────────

function specFromFlags(
  flags: Map<string, string | true>,
  defaults: { kind?: TaskKind } = {},
): { spec: TaskSpec; policy: RoutingPolicy } {
  const kindRaw = flags.get("kind");
  if (typeof kindRaw !== "string" && !defaults.kind) {
    return fail(`--kind is required. Kinds: ${TASK_KINDS.join(", ")}`);
  }
  const spec: TaskSpec = { kind: typeof kindRaw === "string" ? oneOf(kindRaw, TASK_KINDS, "kind") : defaults.kind! };
  const complexity = flags.get("complexity");
  if (typeof complexity === "string") spec.complexity = oneOf(complexity, COMPLEXITIES, "complexity");
  if (flags.get("interactive") === true) spec.latency = "interactive";
  const context = flags.get("context");
  if (typeof context === "string") spec.contextTokens = Number(context);
  const output = flags.get("output");
  if (typeof output === "string") spec.expectedOutputTokens = Number(output);
  const require = flags.get("require");
  if (typeof require === "string") spec.require = require.split(",") as Capability[];

  const policy: RoutingPolicy = {};
  const budget = flags.get("budget");
  if (typeof budget === "string") policy.maxCostPerTask = Number(budget);
  const pin = flags.get("pin");
  if (typeof pin === "string") policy.pin = pin;
  const deny = flags.get("deny");
  if (typeof deny === "string") policy.deny = deny.split(",");
  return { spec, policy };
}

interface HubBuild {
  hub: ProviderHub;
  /** One line per registered provider explaining how it authenticated. */
  notes: string[];
}

/**
 * Wire adapters from whatever credentials are available, preferring
 * subscription logins (marginal cost 0 — the router already favors them) and
 * falling back to metered API keys. Each provider is independent: a missing
 * login just means those models won't route, not a hard failure.
 */
async function buildHub(config: ApolloConfig): Promise<HubBuild> {
  const hub = new ProviderHub();
  const notes: string[] = [];

  // Anthropic (metered API key / bearer, or Claude subscription via Claude Code)
  const anthropicCreds = resolveCredentials(config, "anthropic");
  if (anthropicCreds.apiKey) {
    hub.register(new AnthropicAdapter(anthropicCreds));
    notes.push(`anthropic → ${dim("ANTHROPIC_API_KEY")}`);
  } else {
    const auth = resolveAnthropicAuth();
    if (auth.ok && auth.authToken) {
      hub.register(new AnthropicAdapter({ authToken: auth.authToken, baseUrl: anthropicCreds.baseUrl }));
      notes.push(`anthropic → ${green(auth.detail)}`);
    } else if (auth.ok && auth.mode === "ant-profile") {
      hub.register(new AnthropicAdapter({ baseUrl: anthropicCreds.baseUrl }));
      notes.push(`anthropic → ${green(auth.detail)}`);
    }
  }

  // OpenAI metered key
  const openaiCreds = resolveCredentials(config, "openai");
  if (openaiCreds.apiKey) {
    hub.register(new OpenAIAdapter(openaiCreds));
    notes.push(`openai → ${dim("OPENAI_API_KEY")}`);
  }

  // Codex (ChatGPT subscription via `codex login`)
  const codexAuth = resolveCodexAuth();
  if (codexAuth.ok && codexAuth.accessToken) {
    hub.register(new CodexAdapter({ accessToken: codexAuth.accessToken, accountId: codexAuth.accountId }));
    notes.push(`codex → ${green(codexAuth.detail)}`);
  }

  // Google (metered AI Studio key)
  const googleCreds = resolveCredentials(config, "google");
  if (googleCreds.apiKey) {
    hub.register(new GoogleAdapter({ apiKey: googleCreds.apiKey, baseUrl: googleCreds.baseUrl }));
    notes.push(`google → ${dim("GEMINI_API_KEY")}`);
  }

  // Gemini CLI (Google account via `gemini` login)
  const geminiAuth = await resolveGeminiAuth();
  if (geminiAuth.ok && geminiAuth.accessToken) {
    hub.register(new GeminiCliAdapter({ accessToken: geminiAuth.accessToken }));
    notes.push(`gemini-cli → ${green(geminiAuth.detail)}`);
  }

  // Ollama is local and keyless — always available if the daemon is up.
  const ollama = resolveCredentials(config, "ollama");
  hub.register(new OllamaAdapter({ baseUrl: ollama.baseUrl }));
  notes.push(`ollama → ${dim("local")}`);

  return { hub, notes };
}

function printDecision(decision: RoutingDecision, explain: boolean): void {
  const { task, weights } = decision;
  console.log(
    `\n${bold("Route:")} ${task.kind} · ${task.complexity} · ${task.latency}   ` +
      dim(`weights → quality ${weights.quality.toFixed(2)} · cost ${weights.cost.toFixed(2)} · speed ${weights.speed.toFixed(2)}`),
  );
  console.log(`\n  ${green("→")} ${bold(green(decision.chosen.model.id))}`);
  console.log(`    ${decision.explanation}\n`);

  if (!explain) return;

  const rows = decision.ranked.map((c, i) => [
    String(i + 1),
    c.model.id,
    c.score.toFixed(3),
    c.quality.toFixed(3),
    `$${c.estimatedCostUsd.toFixed(4)}`,
    `${c.estimatedSeconds.toFixed(1)}s`,
  ]);
  console.log(
    table(["#", "model (escalation order)", "score", "quality", "est. cost", "est. time"], rows, (cell, _col, row) =>
      row === 0 ? green(cell) : cell,
    ),
  );
  if (decision.eliminated.length > 0) {
    console.log(`\n  ${dim("eliminated:")}`);
    for (const e of decision.eliminated) {
      console.log(`  ${red("✗")} ${e.modelId} ${dim(`— ${e.reason}`)}`);
    }
  }
  console.log();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STATE_DIR = resolvePath(process.env.APOLLO_STATE_DIR ?? join(process.cwd(), ".apollo"));
const RUNS_DIR = join(STATE_DIR, "runs");
const MISSIONS_DIR = join(STATE_DIR, "missions");

/** Apply measured end-to-end speed in memory; user config remains untouched. */
function buildMeasuredRegistry(config: ApolloConfig): ModelRegistry {
  const registry = buildRegistry(config);
  for (const measured of telemetryFromDir(RUNS_DIR)) {
    if (measured.throughputSamples < 5 || !measured.measuredTokensPerSec) continue;
    const profile = registry.get(measured.modelId);
    if (!profile) continue;
    registry.update(profile.id, {
      latency: {
        ...profile.latency,
        ttftMs: measured.p50TtftMs === undefined ? profile.latency.ttftMs : Math.max(0, Math.round(measured.p50TtftMs)),
        effectiveTokensPerSec: Math.max(1, Math.round(measured.measuredTokensPerSec)),
      },
    });
  }
  return registry;
}

/** Where this run records its event stream. --no-record disables; --record <path> overrides. */
function recordPathFor(flags: Map<string, string | true>, runId: string): string | undefined {
  if (flags.get("no-record") === true) return undefined;
  const custom = flags.get("record");
  if (typeof custom === "string") return resolvePath(custom);
  return join(RUNS_DIR, `${runId}.jsonl`);
}

/** Attach a JSONL sink to the bus if recording is on; returns the sink + path to report. */
function startRecording(bus: EventBus, path: string | undefined): { sink?: JsonlEventSink; path?: string } {
  if (!path) return {};
  return { sink: new JsonlEventSink(path).attach(bus), path };
}

function persistMissionContract(id: string, goal: string, bus: EventBus, workspace?: string, checks: Check[] = [], answer?: string): string {
  const mission = createMission({
    id,
    goal,
    workspace,
    constraints: workspace ? [`filesystem access is jailed to ${workspace}`] : [],
    acceptance: checks.map((check, index) => ({
      id: `check-${index + 1}`,
      description: describeCheck(check),
      kind: check.type,
      value: "path" in check ? check.path : "command" in check ? check.command : undefined,
    })),
  });
  return writeMissionBundle(MISSIONS_DIR, mission, outcomeFromEvents(mission, bus.history(), answer));
}

function eventLine(event: StampedEvent, t0: number): string | undefined {
  const at = dim(`[+${((event.at - t0) / 1000).toFixed(2)}s]`);
  switch (event.type) {
    case "task.started":
      return `${at} ${bold("▸ task.started")}        ${event.title}`;
    case "task.planned":
      return `${at} ${bold("▸ task.planned")}        ${event.summary}`;
    case "depth.selected":
      return `${at} ${cyan(`◇ depth.${event.depth}`)}        ${dim(event.reason)}`;
    case "routing.decided":
      return `${at} ${cyan("⇢ routing.decided")}     ${cyan(event.modelId)}\n${dim(`             ${event.reason}`)}`;
    case "execution.started":
      return `${at} ${dim(`⚙ execution.started    attempt ${event.attempt}`)}`;
    case "execution.completed": {
      const cost = event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(4)}` : "";
      const calls = event.modelCalls !== undefined ? ` · ${event.modelCalls} model call(s)` : "";
      return `${at} ${dim(`⚙ execution.completed  attempt ${event.attempt}${event.modelId ? ` · ${event.modelId}` : ""}${calls}${cost}`)}`;
    }
    case "execution.failed":
      return `${at} ${red(`⚙ execution.failed     attempt ${event.attempt}: ${event.error}`)}`;
    case "verification.passed":
      return `${at} ${green(`✓ verification.passed  attempt ${event.attempt}`)}`;
    case "verification.failed":
      return `${at} ${red(`✗ verification.failed  attempt ${event.attempt}: ${event.issues.join("; ")}`)}`;
    case "task.completed":
      return `${at} ${green(bold(`▸ task.completed       in ${event.attempts} attempt(s)`))}`;
    case "task.failed":
      return `${at} ${red(bold(`▸ task.failed          ${event.reason}`))}`;
    case "plan.produced":
      return `${at} ${bold("◆ plan.produced")}       ${event.steps} step(s) · confidence ${event.confidence.toFixed(2)}${event.replan ? dim(" (replan)") : ""}`;
    case "step.started":
      return `${at} ${cyan(`▹ step.started ${event.stepId}`)}       ${event.description}`;
    case "step.finished":
      return `${at} ${event.status === "done" ? green(`▪ step.finished ${event.stepId}`) : red(`▪ step.finished ${event.stepId}`)}      ${event.status}${event.note ? dim(` — ${event.note}`) : ""}`;
    case "belief.recorded":
      return `${at} ${dim(`◦ belief  ${event.key} = ${event.value}`)}`;
    case "critic.reviewed":
      return `${at} ${event.verdict === "pass" ? green(`⚖ critic ${event.stepId}: pass`) : red(`⚖ critic ${event.stepId}: fail`)}${event.forceReplan ? red(" (force replan)") : ""}${event.note ? dim(` — ${event.note}`) : ""}`;
    case "permission.decided":
      return `${at} ${event.decision === "allow" ? green("◆ permission allow") : yellow("◆ permission deny")} ${event.tool} · ${event.risk} ${dim(`— ${event.reason}`)}`;
    case "meta.stop":
      return `${at} ${yellow(bold(`■ meta.stop            ${event.status}: ${event.reason}`))}`;
    case "output.delta":
      return undefined;
  }
}

function printEvent(event: StampedEvent, t0: number): void {
  const line = eventLine(event, t0);
  if (line) console.log(line);
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdModels(): void {
  const { config, path } = loadConfig();
  const registry = buildMeasuredRegistry(config);
  console.log(bold("\nApollo model registry") + dim(path ? `  (defaults + ${path})` : "  (seed defaults)") + "\n");
  const rows = registry.list({ enabledOnly: false }).map((m) => [
    m.enabled === false ? `${m.id} (disabled)` : m.id,
    m.contextWindow.toLocaleString("en-US"),
    m.cost.inputPerMTok === 0 && m.cost.outputPerMTok === 0
      ? "free"
      : `$${m.cost.inputPerMTok}/$${m.cost.outputPerMTok}`,
    `${m.latency.effectiveTokensPerSec ?? m.latency.tokensPerSec} tok/s`,
    m.latency.effectiveTokensPerSec ? "measured" : m.notes?.includes("Seed estimate") ? "estimate" : m.provider === "ollama" ? "local" : "docs",
  ]);
  console.log(table(["model", "context", "$/MTok in/out", "throughput", "source"], rows));
  console.log(dim("\nMeasured effective throughput is learned from ≥5 recorded executions; other values are profile seeds.\n"));
}

function cmdRoute(flags: Map<string, string | true>): void {
  const { config } = loadConfig();
  const { spec, policy } = specFromFlags(flags);
  try {
    const decision = new Router(buildMeasuredRegistry(config)).route(spec, { ...config.policy, ...policy });
    printDecision(decision, flags.get("explain") === true);
  } catch (error) {
    if (error instanceof RoutingError) {
      console.error(red(`\nrouting failed: ${error.message}`));
      for (const e of error.eliminated) console.error(`  ${red("✗")} ${e.modelId} ${dim(`— ${e.reason}`)}`);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * The real loop: route → provider call (streamed) → structural verification →
 * escalation. Task-level verifiers (tests, typecheck, rubrics) land with the
 * workspace executor; v1 verification checks emptiness and refusal/filters.
 */
async function cmdRun(prompt: string | undefined, flags: Map<string, string | true>): Promise<void> {
  if (!prompt) return fail('run needs a prompt right after the command: apollo run "..." --kind …');
  const { config, path } = loadConfig();
  const registry = buildMeasuredRegistry(config);
  const { spec, policy } = specFromFlags(flags);
  spec.contextTokens ??= Math.ceil(prompt.length / 4) + 500;
  spec.expectedOutputTokens ??= 2_000;

  // Workspace / verification flags — when applying files, steer the model to
  // emit them in the file-block convention.
  const applyDir = typeof flags.get("apply") === "string" ? resolvePath(flags.get("apply") as string) : undefined;
  const applyHere = flags.get("apply") === true ? process.cwd() : undefined;
  const workspace = applyDir ?? applyHere;
  const verifyCommands = typeof flags.get("verify") === "string" ? (flags.get("verify") as string).split("&&").map((c) => c.trim()) : [];
  if (verifyCommands.length > 0 && !workspace) {
    return fail("--verify needs --apply <dir> so there is a workspace to run the checks in");
  }

  // Build the hub first so we know which providers can actually execute, then
  // deny models whose provider isn't wired — the router never picks a model
  // Apollo can't run.
  const { hub, notes } = await buildHub(config);
  console.log(dim(`\nproviders: ${notes.join("  ·  ")}`));
  const unroutable = registry
    .list()
    .filter((m) => !hub.has(m.provider))
    .map((m) => m.id);
  const denySet = new Set([...(policy.deny ?? []), ...(config.policy?.deny ?? []), ...unroutable]);

  let decision: RoutingDecision;
  try {
    decision = new Router(registry).route(spec, { ...config.policy, ...policy, deny: [...denySet] });
  } catch (error) {
    if (error instanceof RoutingError) {
      console.error(red(`\nrouting failed: ${error.message}`));
      for (const e of error.eliminated) console.error(`  ${red("✗")} ${e.modelId} ${dim(`— ${e.reason}`)}`);
      if (unroutable.length > 0) {
        console.error(dim(`\nno adapter for: ${unroutable.join(", ")} — log in (apollo login <provider>) or set an API key`));
      }
      process.exit(1);
    }
    throw error;
  }
  printDecision(decision, flags.get("explain") === true);
  if (flags.get("dry") === true) return;

  let memoryContext: string | undefined;
  let memorySources: MemoryEntry[] = [];
  let mcp: StdioMcpClient | undefined;
  const wantsMemory = flags.get("no-memory") !== true && (Boolean(config.midas) || flags.get("memory") === true);
  if (wantsMemory) {
    if (!config.midas) {
      console.log(yellow(`no "midas" entry in ${path ?? CONFIG_FILENAME} — running without memory context`));
    } else {
      try {
        mcp = new StdioMcpClient(config.midas);
        const grounded = await buildGroundedContext(new MidasMemory(mcp), prompt, { tokenBudget: 512 });
        memoryContext = grounded.text;
        memorySources = grounded.entries;
      } catch (error) {
        console.log(yellow(`midas unavailable (${error instanceof Error ? error.message : error}) — running without memory context`));
        mcp = undefined;
      }
    }
  }

  const runId = `run-${Date.now()}`;
  const bus = new EventBus();
  const t0 = Date.now();
  bus.on("*", (event) => printEvent(event, t0));
  const recording = startRecording(bus, recordPathFor(flags, runId));
  for (const entry of memorySources) {
    bus.emit({ type: "belief.recorded", taskId: runId, key: `memory:${entry.id}`, value: `${entry.provenance ?? "unknown"}${entry.source ? ` · ${entry.source}` : ""} · ${entry.content}` });
  }

  const systemParts: string[] = [];
  if (memoryContext) systemParts.push(`Relevant context from memory:\n${memoryContext}`);
  if (workspace) systemParts.push(FILE_BLOCK_INSTRUCTIONS);

  // Self-correction channel: a failed verifier writes actionable feedback here,
  // which the next attempt's prompt includes so the model fixes its own output
  // (in addition to the router escalating to the next-ranked model).
  let feedback: string | undefined;

  const pipeline = new Pipeline<RoutingDecision>(
    {
      async plan() {
        const bits = [`prompt assembled (${prompt.length} chars`];
        if (memoryContext) bits.push(`, +${memoryContext.split("\n").length - 1} memory lines`);
        if (workspace) bits.push(`, workspace ${workspace}`);
        if (verifyCommands.length) bits.push(`, verifiers: ${verifyCommands.join(" && ")}`);
        return { plan: decision, summary: `${bits.join("")})` };
      },
      async execute(t, dec, attempt) {
        const candidate = candidateForAttempt(dec, attempt);
        bus.emit({
          type: "routing.decided",
          taskId: t.id,
          modelId: candidate.model.id,
          reason: attempt === 1 ? dec.explanation : "escalated to next-ranked candidate with verifier feedback",
          kind: dec.task.kind,
        });
        const messages: ChatMessage[] = [];
        if (systemParts.length) messages.push({ role: "system", content: systemParts.join("\n\n") });
        messages.push({ role: "user", content: prompt });
        if (feedback) {
          messages.push({
            role: "user",
            content: `A previous attempt failed verification. Fix these issues and return the complete corrected output:\n\n${feedback}`,
          });
        }

        process.stdout.write("\n");
        const completion = await hub.completeForModel(
          candidate.model,
          { messages, maxTokens: dec.task.expectedOutputTokens },
          (delta) => process.stdout.write(delta),
        );
        process.stdout.write("\n\n");
        if (completion.stopReason === "max_tokens" || completion.stopReason === "length") {
          console.log(yellow(`note: output hit the ${dec.task.expectedOutputTokens}-token cap — raise --output if truncated`));
        }
        return {
          output: completion.text,
          modelId: candidate.model.id,
          meta: {
            costUsd: completion.costUsd,
            inputTokens: completion.usage?.inputTokens,
            outputTokens: completion.usage?.outputTokens,
            stopReason: completion.stopReason,
          },
        };
      },
      async verify(_t, _dec, result) {
        const issues: string[] = [];
        if (!result.output.trim()) issues.push("empty output");
        const stop = typeof result.meta?.stopReason === "string" ? result.meta.stopReason : "";
        if (stop === "refusal" || stop === "content_filter") issues.push(`model declined (${stop})`);
        if (issues.length > 0) {
          feedback = issues.join("; ");
          return { passed: false, issues };
        }

        // Apply files, then run the task-level verifiers (tests, typecheck, …).
        if (workspace) {
          const blocks = parseFileBlocks(result.output);
          if (blocks.length === 0) {
            feedback = "No file blocks found. Emit each file as a ```file:<path> fenced block with complete contents.";
            return { passed: false, issues: ["no file blocks in output"] };
          }
          let written: string[];
          try {
            ({ written } = applyFileBlocks(workspace, blocks));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            feedback = message;
            return { passed: false, issues: [message] };
          }
          console.log(dim(`  wrote ${written.length} file(s): ${written.join(", ")}`));

          if (verifyCommands.length > 0) {
            const { passed, results } = await runVerifiers(verifyCommands, { cwd: workspace });
            for (const r of results) {
              console.log(r.ok ? green(`  ✓ ${r.command}`) : red(`  ✗ ${r.command} (exit ${r.code ?? "—"})`));
            }
            if (!passed) {
              const failed = results[results.length - 1];
              feedback = `Command failed: ${failed.command}\nexit code: ${failed.code}\noutput:\n${failed.outputTail}`;
              return { passed: false, issues: [`verifier failed: ${failed.command}`] };
            }
          }
        }
        feedback = undefined;
        return { passed: true, issues: [] };
      },
    },
    bus,
    { maxAttempts: Number(flags.get("max-attempts") ?? (workspace ? 3 : 2)) },
  );

  const outcome = await pipeline.run({ id: runId, title: prompt.slice(0, 80) });
  await mcp?.close();
  recording.sink?.close();

  const executions = bus.history().filter((e) => e.type === "execution.completed");
  const totalCost = executions.reduce((sum, e) => sum + (e.type === "execution.completed" ? (e.costUsd ?? 0) : 0), 0);
  console.log();
  if (outcome.status === "succeeded") {
    const meta = outcome.result.meta ?? {};
    console.log(
      `${green(bold("done"))} — ${outcome.result.modelId} · ${outcome.attempts} attempt(s) · ` +
        `${String(meta.inputTokens ?? "?")} in / ${String(meta.outputTokens ?? "?")} out tokens · $${totalCost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } else {
    console.log(red(bold(`failed — ${outcome.reason}`)));
    process.exitCode = 1;
  }
  if (recording.path) console.log(dim(`recorded ${bus.history().length} events → ${recording.path}  (apollo replay <file>)`));
  console.log();
}

/**
 * Agentic run: the model calls tools, the harness executes them and feeds the
 * results back, looping until it answers. Ships with read-only built-in tools
 * (calculator, time, list_dir, read_file — path-jailed to cwd). Routes only to
 * models whose provider adapter supports tool calls.
 */
async function cmdAgent(prompt: string | undefined, flags: Map<string, string | true>): Promise<void> {
  if (!prompt) return fail('agent needs a prompt: apollo agent "..." [--kind ...]');
  const { config } = loadConfig();
  const registry = buildMeasuredRegistry(config);
  const { spec, policy } = specFromFlags(flags, { kind: "research" });
  spec.require = [...new Set<Capability>([...(spec.require ?? []), "tool-use"])];
  spec.contextTokens ??= Math.ceil(prompt.length / 4) + 500;

  const { hub, notes } = await buildHub(config);
  console.log(dim(`\nproviders: ${notes.join("  ·  ")}`));
  const denied = registry
    .list()
    .filter((m) => !hub.has(m.provider) || hub.get(m.provider)?.supportsTools === false)
    .map((m) => m.id);

  let decision: RoutingDecision;
  try {
    decision = new Router(registry).route(spec, { ...config.policy, ...policy, deny: [...new Set([...(policy.deny ?? []), ...denied])] });
  } catch (error) {
    if (error instanceof RoutingError) {
      console.error(red(`\nrouting failed: ${error.message}`));
      console.error(dim("no configured model supports tool calls — Anthropic, OpenAI, or a tool-capable Ollama model are needed."));
      process.exit(1);
    }
    throw error;
  }
  printDecision(decision, flags.get("explain") === true);
  if (flags.get("dry") === true) return;

  const agentWorkspace = typeof flags.get("workspace") === "string" ? resolvePath(flags.get("workspace") as string) : undefined;
  const tools = agentWorkspace ? workspaceTools(agentWorkspace) : builtinTools(process.cwd());
  const agentApproveAsked = flags.get("yes") === true || flags.get("confirm") === "all" || flags.get("confirm") === "off";
  const agentPolicy = agentWorkspace ? loadExecutionPolicy(agentWorkspace) : undefined;
  // --mcp bridges a configured MCP server's tools (Midas by default) into the
  // agent, namespaced by server key — memory recall becomes a callable tool.
  let mcp: StdioMcpClient | undefined;
  if (flags.get("mcp") === true || typeof flags.get("mcp") === "string") {
    if (!config.midas) {
      console.log(yellow(`--mcp needs a "midas" (or MCP server) entry in apollo.config.json — continuing with built-in tools only`));
    } else {
      try {
        mcp = new StdioMcpClient(config.midas);
        tools.registerAll(await mcpTools(mcp, "midas"));
      } catch (error) {
        console.log(yellow(`MCP server unavailable (${error instanceof Error ? error.message : error}) — built-in tools only`));
        mcp = undefined;
      }
    }
  }
  console.log(dim(`tools: ${tools.definitions().map((t) => t.name).join(", ")}\n`));

  const runId = `agent-${Date.now()}`;
  const bus = new EventBus();
  const t0 = Date.now();
  bus.on("*", (event) => printEvent(event, t0));
  const recording = startRecording(bus, recordPathFor(flags, runId));

  bus.emit({ type: "task.started", taskId: runId, title: prompt.slice(0, 80) });
  bus.emit({ type: "routing.decided", taskId: runId, modelId: decision.chosen.model.id, reason: decision.explanation, kind: spec.kind });

  const maxSteps = Number(flags.get("max-steps") ?? 8);
  let failed: string | undefined;
  let result;
  try {
    result = await runAgent({
      hub,
      model: decision.chosen.model,
      messages: [{ role: "user", content: prompt }],
      tools,
      maxSteps,
      onConfirm: (call) => {
        const decision = agentPolicy
          ? decideToolCall(agentPolicy, call, agentApproveAsked, tools.risk(call.name))
          : { allowed: agentApproveAsked, risk: tools.risk(call.name), reason: agentApproveAsked ? "approved by CLI flag" : "explicit approval required" };
        bus.emit({ type: "permission.decided", taskId: runId, tool: call.name, risk: decision.risk, decision: decision.allowed ? "allow" : "deny", reason: decision.reason });
        return decision.allowed;
      },
      onStep: (step: AgentStep) => {
        bus.emit({ type: "execution.started", taskId: runId, attempt: step.step });
        for (const tc of step.toolCalls) {
          console.log(`  ${cyan("⚒ " + tc.name)}(${dim(JSON.stringify(tc.arguments))})`);
        }
        for (const r of step.toolResults) {
          console.log(`    ${dim("→ " + r.result.replace(/\n/g, " ").slice(0, 100))}`);
        }
        bus.emit({
          type: "execution.completed",
          taskId: runId,
          attempt: step.step,
          modelId: decision.chosen.model.id,
          costUsd: step.costUsd,
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
        });
      },
    });
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  }

  if (result && !failed) {
    bus.emit({ type: "verification.passed", taskId: runId, attempt: result.steps.length });
    bus.emit({ type: "task.completed", taskId: runId, attempts: result.steps.length });
  } else {
    bus.emit({ type: "task.failed", taskId: runId, attempts: 1, reason: failed ?? "no result" });
  }
  recording.sink?.close();
  await mcp?.close();

  console.log();
  if (result && !failed) {
    console.log(`${green(bold("answer"))} — ${result.text}\n`);
    const toolCount = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
    console.log(
      dim(
        `${decision.chosen.model.id} · ${result.steps.length} step(s) · ${toolCount} tool call(s) · $${result.totalCostUsd.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s · stopped: ${result.stoppedReason}`,
      ),
    );
  } else {
    console.log(red(bold(`failed — ${failed}`)));
    process.exitCode = 1;
  }
  if (recording.path) console.log(dim(`recorded → ${recording.path}`));
  console.log();
}

/**
 * Adaptive Cortex: instant conversation, a single verified agent loop, or the
 * full plan → (act → critic)+ → verify → finalize cycle, guarded by
 * loop/budget/turn limits and honest stops. Records to .apollo/runs.
 */
async function cmdCortex(goal: string | undefined, flags: Map<string, string | true>): Promise<void> {
  if (!goal) return fail('cortex needs a goal: apollo cortex "..." [--budget USD] [--mcp]');
  const depth = typeof flags.get("depth") === "string" ? oneOf(flags.get("depth") as string, DEPTHS, "depth") : "auto";
  const selectedDepth = selectDepth(goal, depth);
  const localOnly = selectedDepth.depth === "instant" && localInstantReply(goal) !== undefined;
  const { config } = loadConfig();
  const registry = localOnly ? new ModelRegistry() : buildMeasuredRegistry(config);

  const { hub, notes } = localOnly
    ? { hub: new ProviderHub(), notes: ["local instant → no provider needed"] }
    : await buildHub(config);
  console.log(dim(`\nproviders: ${notes.join("  ·  ")}`));
  // Filter only for capabilities the selected lane actually needs. Instant
  // accepts plain streaming text; agent needs tools; deep also needs schemas.
  for (const m of registry.list()) {
    const adapter = hub.get(m.provider);
    const unusable = !adapter
      || (selectedDepth.depth !== "instant" && adapter.supportsTools === false)
      || (selectedDepth.depth === "deep" && adapter.supportsResponseFormat === false);
    if (unusable) {
      registry.update(m.id, { enabled: false });
    }
  }
  const pin = flags.get("pin");
  if (typeof pin === "string") {
    for (const m of registry.list()) if (m.id !== pin) registry.update(m.id, { enabled: false });
  }
  if (!localOnly && registry.list().length === 0) {
    const need = selectedDepth.depth === "deep" ? "tool calls + structured output" : selectedDepth.depth === "agent" ? "tool calls" : "text completion";
    return fail(`no configured model supports the ${selectedDepth.depth} lane (needs ${need}) — log in or add an API key`);
  }

  // --workspace gives the executor jailed file + shell tools so the cycle does
  // real work; destructive tools are gated by the confirm policy.
  const workspace = typeof flags.get("workspace") === "string" ? resolvePath(flags.get("workspace") as string) : undefined;
  const tools = workspace ? workspaceTools(workspace) : builtinTools(process.cwd());
  const approveAsked =
    flags.get("yes") === true || flags.get("confirm") === "all" || flags.get("confirm") === "off";
  let mcp: StdioMcpClient | undefined;
  let groundedContext: Awaited<ReturnType<typeof buildGroundedContext>> | undefined;
  if (config.midas && selectedDepth.depth !== "instant" && (flags.get("no-memory") !== true || flags.get("mcp") === true)) {
    try {
      mcp = new StdioMcpClient(config.midas);
      if (flags.get("no-memory") !== true) {
        groundedContext = await buildGroundedContext(new MidasMemory(mcp), goal, { tokenBudget: 512 });
        if (groundedContext.entries.length) console.log(dim(`memory: ${groundedContext.entries.length} source(s) recalled with provenance`));
      }
      if (flags.get("mcp") === true) tools.registerAll(await mcpTools(mcp, "midas"));
    } catch (error) {
      console.log(yellow(`Midas unavailable (${error instanceof Error ? error.message : error}) — continuing without memory`));
      mcp = undefined;
      groundedContext = undefined;
    }
  }
  console.log(dim(`tools: ${tools.definitions().map((t) => t.name).join(", ")}`));
  if (workspace) {
    console.log(dim(`workspace: ${workspace}${approveAsked ? "" : yellow("  (workspace policy gates writes and shell)")}`));
  }

  const requestedId = typeof flags.get("task-id") === "string" ? String(flags.get("task-id")) : undefined;
  if (requestedId && !/^[A-Za-z0-9_-]+$/.test(requestedId)) return fail("--task-id must contain only letters, numbers, _ or -");
  const runId = requestedId ?? `cortex-${Date.now()}`;
  const bus = new EventBus();
  const t0 = Date.now();
  bus.on("*", (event) => printEvent(event, t0));
  const recording = startRecording(bus, recordPathFor(flags, runId));

  const limits: Record<string, number> = {};
  if (typeof flags.get("budget") === "string") limits.budgetUsd = Number(flags.get("budget"));
  if (typeof flags.get("max-turns") === "string") limits.maxTurns = Number(flags.get("max-turns"));
  if (typeof flags.get("critic-every") === "string") limits.criticEvery = Number(flags.get("critic-every"));

  // Harness-enforced ground-truth checks, independent of what the model plans.
  const extraChecks = typeof flags.get("check") === "string" ? parseCheckSpecs(flags.get("check") as string) : [];
  if (extraChecks.length > 0) {
    if (!workspace) console.log(yellow("--check needs --workspace <dir> to verify against; checks will not run without it"));
    else console.log(dim(`enforced checks: ${extraChecks.map(describeCheck).join(" · ")}`));
  }

  console.log(bold(`\n☀ Apollo cortex — ${selectedDepth.depth} lane\n`));
  const executionPolicy = workspace ? loadExecutionPolicy(workspace) : undefined;
  const confirm = (call: ToolCall): boolean => {
    if (!executionPolicy) return approveAsked;
    const decision = decideToolCall(executionPolicy, call, approveAsked, tools.risk(call.name));
    bus.emit({
      type: "permission.decided",
      taskId: runId,
      tool: call.name,
      risk: decision.risk,
      decision: decision.allowed ? "allow" : "deny",
      reason: decision.reason,
    });
    return decision.allowed;
  };
  const result = await runCortex({
    hub,
    registry,
    goal,
    taskId: runId,
    tools,
    workspace,
    extraChecks,
    confirm,
    bus,
    limits,
    context: groundedContext?.text,
    contextEvidence: groundedContext?.entries.map((entry) => ({
      id: entry.id,
      summary: `${entry.provenance ?? "unknown"}${entry.source ? ` · ${entry.source}` : ""} · ${entry.content}`,
    })),
    depth,
    streamOutput: process.env.APOLLO_DESKTOP === "1",
  });
  recording.sink?.close();
  const missionDir = persistMissionContract(runId, goal, bus, workspace, extraChecks, result.answer);
  await mcp?.close();

  console.log();
  const color = result.status === "ok" ? green : yellow;
  console.log(`${color(bold(result.status === "ok" ? "answer" : `stopped (${result.status})`))} — ${result.answer}\n`);
  console.log(
    dim(
      `${result.replans} replan(s) · ${result.turns} turn(s) · $${result.costUsd.toFixed(4)}` +
        (Object.keys(result.beliefs).length ? ` · beliefs: ${Object.keys(result.beliefs).join(", ")}` : ""),
    ),
  );
  if (recording.path) console.log(dim(`recorded → ${recording.path}`));
  console.log(dim(`evidence → ${missionDir}`));
  if (result.status !== "ok") process.exitCode = 2;
  console.log();
}

/** Simulated end-to-end walkthrough of the pipeline (no providers, no keys). */
async function cmdDemo(flags: Map<string, string | true>): Promise<void> {
  const registry = ModelRegistry.withDefaults();
  const router = new Router(registry);
  const runId = `demo-${Date.now()}`;
  const bus = new EventBus();
  const t0 = Date.now();
  bus.on("*", (event) => printEvent(event, t0));
  const recording = startRecording(bus, recordPathFor(flags, runId));

  console.log(bold("\nApollo pipeline demo — plan → route → execute → verify (execution simulated)\n"));

  const task: Task = { id: runId, title: "Add input validation to the signup endpoint" };
  const planDecision = router.route({ kind: "planning", complexity: "frontier" });
  const execDecision = router.route({ kind: "code-generation", complexity: "hard", expectedOutputTokens: 2_000 });

  const pipeline = new Pipeline<RoutingDecision>(
    {
      async plan(t) {
        bus.emit({
          type: "routing.decided",
          taskId: t.id,
          modelId: planDecision.chosen.model.id,
          reason: `plan phase — ${planDecision.explanation}`,
          kind: "planning",
        });
        await sleep(120);
        return { plan: execDecision, summary: `3-step plan drafted by ${planDecision.chosen.model.displayName} (simulated)` };
      },
      async execute(t, decision, attempt) {
        const candidate = candidateForAttempt(decision, attempt);
        bus.emit({
          type: "routing.decided",
          taskId: t.id,
          modelId: candidate.model.id,
          reason:
            attempt === 1
              ? `execute phase — ${decision.explanation}`
              : `execute phase — escalated to next ranked candidate after failed verification`,
          kind: "code-generation",
        });
        await sleep(150);
        return { output: `patch produced by ${candidate.model.displayName} (simulated)`, modelId: candidate.model.id };
      },
      async verify(_t, _decision, _result, attempt) {
        await sleep(80);
        return attempt === 1
          ? { passed: false, issues: ["unit tests: 12/14 passed (simulated)"] }
          : { passed: true, issues: [] };
      },
    },
    bus,
    { maxAttempts: 3 },
  );

  const outcome = await pipeline.run(task);
  recording.sink?.close();

  console.log();
  if (outcome.status === "succeeded") {
    console.log(
      `${green(bold("done"))} — ${outcome.result.output}\n` +
        dim(
          `escalation path: ${execDecision.ranked
            .slice(0, outcome.attempts)
            .map((c) => c.model.id)
            .join(" → ")} · ${bus.history().length} events recorded — this stream is what the desktop UI will render.`,
        ),
    );
  } else {
    console.log(red(bold(`failed — ${outcome.reason}`)));
  }
  if (recording.path) console.log(dim(`recorded → ${recording.path}  (apollo replay <file>)`));
  console.log();
}

/** Re-render a recorded run's event stream exactly as it happened live. */
function cmdReplay(file: string | undefined): void {
  if (!file) return fail("replay needs a recorded run file: apollo replay .apollo/runs/<id>.jsonl");
  const target = resolvePath(file);
  if (!existsSync(target)) return fail(`no such run file: ${target}`);
  const events = readEventLog(target);
  if (events.length === 0) return fail(`run file is empty: ${target}`);

  console.log(bold(`\nReplaying ${basename(target)}`) + dim(`  (${events.length} events)\n`));
  const t0 = events[0].at;
  for (const event of events) printEvent(event, t0);

  const summary = summarizeRun(events);
  const color = summary.status === "succeeded" ? green : summary.status === "failed" ? red : yellow;
  console.log(
    `\n${color(bold(summary.status))} — ${summary.title}` +
      dim(
        `  ·  ${summary.finalModel ?? "—"} · ${summary.attempts || "?"} attempt(s) · $${summary.costUsd.toFixed(4)} · ${(summary.durationMs / 1000).toFixed(1)}s`,
      ),
  );
  console.log();
}

/** List recorded runs newest-first with their outcomes. */
function cmdRuns(): void {
  const summaries = listRunSummaries(RUNS_DIR);
  if (summaries.length === 0) {
    console.log(dim(`\nno recorded runs yet — they land in ${RUNS_DIR} after \`apollo run\` / \`apollo demo\`\n`));
    return;
  }

  console.log(bold(`\nRecorded runs`) + dim(`  (${RUNS_DIR})\n`));
  const rows = summaries.map((s) => {
    const mark = s.status === "succeeded" ? "✓" : s.status === "failed" ? "✗" : "…";
    return [
      s.id ?? "—",
      mark,
      s.finalModel ?? "—",
      String(s.attempts || "—"),
      `$${s.costUsd.toFixed(4)}`,
      s.title.length > 48 ? `${s.title.slice(0, 47)}…` : s.title,
    ];
  });
  console.log(
    table(["run id", "", "model", "att", "cost", "task"], rows, (cell, col, row) => {
      if (col !== 1 || row < 0) return cell;
      const status = summaries[row].status;
      return status === "succeeded" ? green(cell) : status === "failed" ? red(cell) : yellow(cell);
    }),
  );
  console.log(dim(`\nreplay one with:  apollo replay ${join(".apollo", "runs", `${summaries[0].id}.jsonl`)}\n`));
}

/**
 * M3: measured routing telemetry over the recorded runs — what each model
 * actually did (latency, throughput, cost, verification outcomes), per task
 * kind. This is the ground truth the seed-estimate profiles get calibrated
 * against; `apollo calibrate` turns it into config overrides.
 */
function cmdStats(flags: Map<string, string | true>): void {
  const telemetry = telemetryFromDir(RUNS_DIR);
  if (flags.get("json") === true) {
    console.log(JSON.stringify(telemetry, null, 2));
    return;
  }
  if (telemetry.length === 0) {
    console.log(dim(`\nno measured executions yet — run \`apollo run\` / \`agent\` / \`cortex\` and come back\n`));
    return;
  }

  const pct = (v?: number) => (v === undefined ? "—" : `${Math.round(v * 100)}%`);
  const secs = (ms?: number) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`);

  console.log(bold("\nMeasured telemetry") + dim(`  (${RUNS_DIR})\n`));
  console.log(
    table(
      ["model", "execs", "calls/exec", "verify", "TTFT p50", "avg time", "tok/s (effective)", "cost"],
      telemetry.map((t) => [
        t.modelId,
        String(t.samples),
        t.avgModelCalls === undefined ? "—" : t.avgModelCalls.toFixed(1),
        pct(t.verifyRate) + (t.verified + t.failed > 0 ? dim(` (${t.verified}/${t.verified + t.failed})`) : ""),
        secs(t.p50TtftMs),
        secs(t.avgDurationMs),
        t.measuredTokensPerSec === undefined ? "—" : `${Math.round(t.measuredTokensPerSec)} · n=${t.throughputSamples}`,
        `$${t.totalCostUsd.toFixed(4)}`,
      ]),
    ),
  );

  const kindRows = telemetry.flatMap((t) =>
    t.byKind.map((k) => [t.modelId, k.kind, String(k.samples), pct(k.verifyRate)]),
  );
  if (kindRows.length > 0) {
    console.log(bold("\nBy task kind\n"));
    console.log(table(["model", "kind", "execs", "verify"], kindRows));
  }
  console.log(dim("\nverify = verification outcomes attributed to the executing attempt; — means never verified."));
  console.log(dim("calibrate profiles from this data:  apollo calibrate [--write]\n"));
}

/**
 * Propose (or write) profile overrides backed by measurement. Only throughput
 * is proposed — it is directly measured; quality stays benchmark/human-owned.
 */
function cmdCalibrate(flags: Map<string, string | true>): void {
  const { config, path } = loadConfig();
  // Compare observations against configured values, not the in-memory registry
  // that already has those same observations applied.
  const registry = buildRegistry(config);
  const telemetry = telemetryFromDir(RUNS_DIR);
  const minSamples = Number(flags.get("min-samples") ?? 5);
  const proposals = proposeCalibration(telemetry, registry.list({ enabledOnly: false }), { minSamples });

  if (proposals.length === 0) {
    console.log(dim(`\nnothing to calibrate — no model deviates ≥20% from its profile with ≥${minSamples} measured samples.`));
    console.log(dim(`measured so far:  apollo stats\n`));
    return;
  }

  console.log(bold("\nCalibration proposals") + dim("  (measured, not estimated)\n"));
  console.log(
    table(
      ["model", "field", "profile", "measured", "samples"],
      proposals.map((p) => [p.modelId, p.field, String(p.current), String(p.measured), String(p.samples)]),
    ),
  );

  if (flags.get("write") !== true) {
    console.log(dim(`\napply them with:  apollo calibrate --write   (merges into ${path ?? CONFIG_FILENAME})\n`));
    return;
  }
  if (!path) return fail(`no ${CONFIG_FILENAME} found — run \`apollo init\` first, then calibrate --write`);

  // registry.update is a shallow merge, so the written latency object must be
  // complete. Keep raw generation speed and store measured end-to-end speed
  // separately so routing reflects orchestration overhead without corrupting
  // the provider profile.
  const raw = JSON.parse(readFileSync(path, "utf8")) as ApolloConfig;
  raw.models ??= {};
  raw.models.update ??= {};
  for (const p of proposals) {
    const profile = registry.list({ enabledOnly: false }).find((m) => m.id === p.modelId);
    if (!profile) continue;
    const existing = raw.models.update[p.modelId] ?? {};
    raw.models.update[p.modelId] = {
      ...existing,
      latency: { ...profile.latency, ...p.patch.latency },
      notes: `${profile.notes ?? ""}${profile.notes ? " · " : ""}effective throughput calibrated from ${p.samples} measured runs`.slice(0, 200),
    };
  }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`\n${green("written")} ${proposals.length} override(s) → ${path}`);
  console.log(dim("the router now scores speed with measured numbers — check with:  apollo models\n"));
}

/**
 * The local dashboard — a projection of the event stream. Renders recorded runs
 * and the model fleet, and tails live runs over SSE. This is the substance of
 * Apollo's desktop surface; a native shell (Tauri, cargo is present) would wrap
 * this same localhost UI.
 */
async function cmdDashboard(flags: Map<string, string | true>): Promise<void> {
  const { config, path: configPath } = loadConfig();
  const models = buildMeasuredRegistry(config).list({ enabledOnly: false });
  const { hub: diagnosticHub, notes: providerNotes } = await buildHub(config);
  const port = typeof flags.get("port") === "string" ? Number(flags.get("port")) : 4317;

  const entry = resolvePath(process.argv[1]);
  const runtime = entry.endsWith(".ts")
    ? { command: process.execPath, args: ["--import", "tsx", entry], stateDir: STATE_DIR }
    : { command: process.execPath, args: [entry], stateDir: STATE_DIR };
  const dash = await startDashboard({
    runsDir: RUNS_DIR,
    missionsDir: MISSIONS_DIR,
    models,
    port,
    runtime: flags.get("read-only") === true ? undefined : runtime,
    version: "0.2.0-alpha.3",
    diagnostics: {
      providers: diagnosticHub.providers(),
      providerNotes: providerNotes.map((note) => note.replace(/\x1b\[[0-9;]*m/g, "")),
      memoryConfigured: Boolean(config.midas),
      configPath,
      workspace: process.cwd(),
    },
  });
  console.log(bold("\n  ☀ Apollo dashboard"));
  console.log(`  ${green(dash.url)}  ${dim(`· ${models.length} models · runs from ${RUNS_DIR}`)}`);
  console.log(dim("  live — new runs stream in as they happen. Ctrl-C to stop.\n"));

  if (flags.get("open") === true) openInBrowser(dash.url);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log(dim("\nstopping dashboard…"));
      dash.close().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function cmdBenchmark(flags: Map<string, string | true>): Promise<void> {
  if (flags.get("list") === true) {
    console.log(bold("\nApollo core benchmark\n"));
    for (const task of CORE_BENCHMARK_TASKS) console.log(`  ${cyan(task.id.padEnd(22))} ${task.category.padEnd(14)} ${task.expected}`);
    console.log();
    return;
  }
  const supported: BenchmarkVariant[] = ["model-only", "model-tools", "apollo-single", "apollo-routed"];
  const variantRaw = String(flags.get("variant") ?? "apollo-routed");
  const variants = variantRaw === "all" ? supported : variantRaw.split(",").map((value) => value.trim()) as BenchmarkVariant[];
  if (variants.length === 0 || variants.some((variant) => !supported.includes(variant))) {
    return fail(`benchmark variants: ${supported.join(", ")} (comma-separated or --variant all)`);
  }
  const repetitions = Math.max(1, Math.min(20, Math.floor(Number(flags.get("repeat") ?? 1))));
  const concurrency = Math.max(1, Math.min(16, Math.floor(Number(flags.get("concurrency") ?? 1))));
  const limit = Math.max(1, Math.min(CORE_BENCHMARK_TASKS.length, Number(flags.get("limit") ?? CORE_BENCHMARK_TASKS.length)));
  const tasks = CORE_BENCHMARK_TASKS.slice(0, limit);
  const { config } = loadConfig();
  const { hub, notes } = await buildHub(config);
  const baseRegistry = buildMeasuredRegistry(config);
  for (const model of baseRegistry.list()) {
    const adapter = hub.get(model.provider);
    if (!adapter || adapter.supportsResponseFormat === false || adapter.supportsTools === false) baseRegistry.update(model.id, { enabled: false });
  }
  if (baseRegistry.list().length === 0) return fail("benchmark needs at least one configured tool+structured-output model");
  const singleModel = new Router(baseRegistry).route({ kind: "code-generation", complexity: "hard", require: ["tool-use"] }).chosen.model;

  const benchmarkId = `benchmark-${Date.now()}`;
  const root = join(process.cwd(), ".apollo", "benchmarks", benchmarkId);
  const workspaceRoot = join(tmpdir(), "apollo-benchmarks", benchmarkId);
  mkdirSync(root, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  console.log(bold(`\n☀ Apollo benchmark · ${variants.join(" vs ")} · ${tasks.length} task(s) × ${repetitions} · ${concurrency} worker(s)`));
  console.log(dim(`providers: ${notes.join(" · ")}\nresults: ${root}\nisolated workspaces: ${workspaceRoot}\n`));

  const report = await runBenchmark(
    tasks,
    variants,
    async (task, variant, repetition) => executeBenchmarkTask(task, variant, repetition, root, workspaceRoot, hub, baseRegistry, singleModel.id),
    typeof flags.get("label") === "string" ? String(flags.get("label")) : undefined,
    repetitions,
    concurrency,
  );
  const reportPath = join(root, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${bold("measured results")}`);
  for (const aggregate of report.aggregates) {
    console.log(`  ${cyan(aggregate.variant.padEnd(14))} ${aggregate.correct}/${aggregate.validAttempts} valid correct · ${(aggregate.verifiedSuccessRate * 100).toFixed(0)}% · 95% CI ${(aggregate.successRate95Ci[0] * 100).toFixed(0)}–${(aggregate.successRate95Ci[1] * 100).toFixed(0)}% · ${aggregate.falseSuccesses} false · ${aggregate.infrastructureFailures} invalid · median ${(aggregate.medianDurationMs / 1000).toFixed(1)}s · ${aggregate.meanModelCalls.toFixed(1)} calls/run`);
  }
  console.log(dim(`report → ${reportPath}\n`));
}

async function executeBenchmarkTask(
  task: BenchmarkTask,
  variant: BenchmarkVariant,
  repetition: number,
  reportRoot: string,
  workspaceRoot: string,
  hub: ProviderHub,
  baseRegistry: ModelRegistry,
  singleModelId: string,
): Promise<{ status: "verified-success" | "honest-stop" | "false-success" | "failed"; durationMs: number; costUsd: number; models: string[]; attempts: number; evidencePath?: string; depth?: "instant" | "agent" | "deep" | "baseline"; modelCalls?: number }> {
  const workspace = join(workspaceRoot, `repeat-${repetition}`, variant, task.id);
  mkdirSync(workspace, { recursive: true });
  for (const [path, content] of Object.entries(task.fixtures)) {
    const target = join(workspace, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const registry = new ModelRegistry();
  for (const model of baseRegistry.list()) registry.register(model);
  const runId = `${task.id}-${variant}-r${repetition}`;
  const bus = new EventBus();
  const recording = startRecording(bus, join(reportRoot, `${runId}.jsonl`));
  const started = Date.now();
  console.log(`${cyan("▸")} ${task.id} · ${variant} · r${repetition} — ${task.title}`);
  if (variant === "apollo-single") {
    for (const model of registry.list()) if (model.id !== singleModelId) registry.update(model.id, { enabled: false });
  }
  if (variant === "apollo-routed" || variant === "apollo-single") {
    const result = await runCortex({ hub, registry, goal: task.goal, taskId: runId, workspace, tools: workspaceTools(workspace), extraChecks: task.checks, confirm: () => true, bus });
    recording.sink?.close();
    const evidencePath = persistMissionContract(runId, task.goal, bus, workspace, task.checks, result.answer);
    const models = bus.history()
      .filter((event) => event.type === "execution.completed" && event.modelId && !event.modelId.startsWith("apollo/local-"))
      .map((event) => event.type === "execution.completed" ? event.modelId! : "");
    const costUsd = bus.history().reduce((sum, event) => sum + (event.type === "execution.completed" ? event.costUsd ?? 0 : 0), 0);
    const status = task.expected === "honest-stop"
      ? result.status === "ok" ? "false-success" : "honest-stop"
      : result.status === "ok" ? "verified-success" : "failed";
    return {
      status,
      durationMs: Date.now() - started,
      costUsd,
      models: [...new Set(models)],
      attempts: result.turns,
      evidencePath,
      depth: result.depth,
      modelCalls: bus.history().reduce((sum, event) => sum + (event.type === "execution.completed" ? event.modelCalls ?? (event.modelId?.startsWith("apollo/local-") ? 0 : 1) : 0), 0),
    };
  }

  bus.emit({ type: "task.started", taskId: runId, title: task.title });
  bus.emit({ type: "routing.decided", taskId: runId, modelId: singleModelId, reason: `fixed controlled ${variant} baseline`, kind: "code-generation" });
  const model = registry.list().find((entry) => entry.id === singleModelId)!;
  const fixtureContext = Object.entries(task.fixtures)
    .map(([path, content]) => `FILE ${path}:\n${content}`)
    .join("\n\n");
  const prompt = `${task.goal}\n\n${variant === "model-only" ? `Here is the complete current project snapshot:\n\n${fixtureContext || "(empty workspace)"}\n\nReturn changed files using the required file-block format.` : "Work only in the supplied workspace using tools."}\n\nIf the request is contradictory, ambiguous, or needs unavailable authority, say NEEDS_INPUT and do not claim success.`;
  let text = "";
  let costUsd = 0;
  let turns = 1;
  bus.emit({ type: "execution.started", taskId: runId, attempt: 1 });
  if (variant === "model-only") {
    const completion = await hub.completeForModel(model, { messages: [{ role: "system", content: FILE_BLOCK_INSTRUCTIONS }, { role: "user", content: prompt }], maxTokens: 4_000 });
    text = completion.text;
    costUsd = completion.costUsd ?? 0;
    const blocks = parseFileBlocks(text);
    if (blocks.length) applyFileBlocks(workspace, blocks);
  } else {
    const result = await runAgent({ hub, model, messages: [{ role: "user", content: prompt }], tools: workspaceTools(workspace), maxSteps: 10, onConfirm: () => true });
    text = result.text;
    costUsd = result.totalCostUsd;
    turns = result.steps.length;
  }
  bus.emit({ type: "execution.completed", taskId: runId, attempt: 1, modelId: singleModelId, costUsd });
  const checkResults = await runChecks(task.checks, workspace);
  writeFileSync(join(reportRoot, `${runId}.baseline.json`), `${JSON.stringify({
    schemaVersion: 1,
    variant,
    model: singleModelId,
    response: redactText(text),
    checks: checkResults,
  }, null, 2)}\n`);
  const checksPassed = task.checks.length > 0 && checkResults.every((result) => result.passed);
  const claimsSuccess = /\b(done|completed|fixed|implemented|success(?:ful(?:ly)?)?)\b/i.test(text) && !/\b(needs_input|cannot|can't|impossible|ambiguous|missing)\b/i.test(text);
  const status = task.expected === "verified-success"
    ? checksPassed ? "verified-success" : claimsSuccess ? "false-success" : "failed"
    : claimsSuccess ? "false-success" : "honest-stop";
  if (checksPassed) bus.emit({ type: "verification.passed", taskId: runId, attempt: 1 });
  else bus.emit({ type: "verification.failed", taskId: runId, attempt: 1, issues: checkResults.filter((result) => !result.passed).map((result) => result.detail) });
  if (status === "verified-success" || status === "honest-stop") bus.emit({ type: "task.completed", taskId: runId, attempts: turns });
  else bus.emit({ type: "task.failed", taskId: runId, attempts: turns, reason: status });
  recording.sink?.close();
  const evidencePath = persistMissionContract(runId, task.goal, bus, workspace, task.checks);
  return { status, durationMs: Date.now() - started, costUsd, models: [singleModelId], attempts: turns, evidencePath, depth: "baseline", modelCalls: turns };
}

function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawnSync(opener, [url], { stdio: "ignore" });
  } catch {
    // best-effort; the URL is already printed
  }
}

async function cmdInit(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = new LineSource(rl);
  try {
    await runInitWizard(defaultInitDependencies(async (question, defaultAnswer) => {
      const answer = await lines.next(`${question} ${dim(defaultAnswer ? "[Y/n]" : "[y/N]")} `);
      if (answer === null || answer.trim() === "") return defaultAnswer;
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes" || normalized === "si" || normalized === "sí";
    }));
  } finally {
    rl.close();
  }
}

function authLine(label: string, ok: boolean, detail: string): string {
  const mark = ok ? green("●") : dim("○");
  return `  ${mark} ${label.padEnd(11)} ${ok ? detail : dim(detail)}`;
}

async function cmdAuth(): Promise<void> {
  const anthropic: AnthropicAuth = resolveAnthropicAuth();
  const codex: CodexAuth = resolveCodexAuth();
  const gemini: GeminiAuth = await resolveGeminiAuth();
  const openaiKey = Boolean(process.env.OPENAI_API_KEY);
  const googleKey = Boolean(process.env.GEMINI_API_KEY);

  console.log(bold("\nApollo auth status\n"));
  console.log(authLine("anthropic", anthropic.ok, anthropic.detail));
  console.log(authLine("codex", codex.ok, codex.detail));
  console.log(authLine("openai", openaiKey, openaiKey ? "OPENAI_API_KEY (metered API)" : "no OPENAI_API_KEY"));
  console.log(authLine("gemini-cli", gemini.ok, gemini.detail));
  console.log(authLine("google", googleKey, googleKey ? "GEMINI_API_KEY (metered API)" : "no GEMINI_API_KEY"));
  console.log(authLine("ollama", true, "local — no login required"));
  console.log(dim("\nlog in with:  apollo login <anthropic|openai|gemini>"));
  console.log(dim("subscription logins (Claude Code, Codex, Gemini CLI) route at cost 0 — the autorouter prefers them.\n"));
}

function cmdLogin(provider: string | undefined): void {
  if (!provider) return fail("login needs a provider: apollo login <anthropic|openai|gemini>");
  const outcome = loginWith(provider);
  if (!outcome.launched) console.log(`\n${outcome.instructions}\n`);
  else console.log(dim(`\n${outcome.instructions}\n`));
}

// ── interactive mode ────────────────────────────────────────────────────────

interface InteractiveSession {
  workspace?: string;
  /** Auto-approve destructive tools for the rest of the session ("a" at a prompt, or /yes). */
  autoAllow: boolean;
  mcp?: StdioMcpClient;
  budgetUsd?: number;
  maxTurns?: number;
  checks: Check[];
  pin?: string;
}

const INTERACTIVE_HELP = `
${bold("interactive apollo")} — type a goal, the cognitive cycle runs it; commands start with /

  ${cyan("/workspace <dir>")}   give the cycle jailed file+shell tools rooted there (${cyan("/workspace off")} to drop)
  ${cyan("/yes")}               toggle auto-approve for destructive tools (default: ask per call)
  ${cyan("/check <specs>")}     enforce ground-truth checks, e.g. ${dim('file_exists:out.py ; command_succeeds:pytest')} (${cyan("/check off")} clears)
  ${cyan("/budget <usd>")}      spend ceiling per run          ${cyan("/turns <n>")}  turn ceiling per run
  ${cyan("/pin <model-id>")}    force one model (${cyan("/pin off")} to unpin)
  ${cyan("/mcp")}               toggle Midas memory tools (needs "midas" in apollo.config.json)
  ${cyan("/login <provider>")}  log into a subscription (anthropic | openai | gemini) — the official
                     CLI runs right here, and the new provider joins the session's routing
  ${cyan("/reload")}            re-detect logins & keys (e.g. you logged in from another terminal)
  ${cyan("/models")} · ${cyan("/auth")} · ${cyan("/stats")} · ${cyan("/runs")}    the usual views, inline
  ${cyan("/exit")}              leave (also Ctrl-D)
`;

/**
 * One subscriber owns the readline 'line' stream and hands lines out on
 * demand. This is what makes the REPL robust: lines that arrive while the
 * session is busy (or piped in all at once) queue instead of being dropped,
 * and EOF resolves null instead of hanging a pending question.
 */
class LineSource {
  private readonly queue: string[] = [];
  private readonly waiters: Array<(value: string | null) => void> = [];
  private closed = false;

  constructor(private readonly rl: Interface) {
    rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queue.push(line);
    });
    rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  /** Show a prompt and resolve the next line; null once input is closed. */
  next(prompt: string): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * `apollo` with no arguments: a Claude-Code-style session in the terminal.
 * Type a goal → the adaptive runtime runs with live events; destructive
 * tool calls ask for confirmation inline; session state (workspace, budget,
 * checks) persists across runs; every run records to .apollo/runs as usual.
 */
async function cmdInteractive(): Promise<void> {
  const { config, path } = loadConfig();
  let { hub, notes } = await buildHub(config);
  const session: InteractiveSession = { autoAllow: false, checks: [] };

  console.log(bold("\n  ☀ Apollo") + dim("  — interactive · the cognitive cycle, in your terminal"));
  console.log(dim(`  config: ${path ?? "seed defaults (run apollo init to customize)"}`));
  console.log(dim(`  providers: ${notes.join("  ·  ")}`));
  console.log(dim(`  type a goal to run it · /help for commands · /exit to leave\n`));

  const rl = createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
  const lines = new LineSource(rl);

  /** Re-detect logins/keys and swap the session's hub — new providers route immediately. */
  const refreshProviders = async () => {
    ({ hub, notes } = await buildHub(config));
    console.log(dim(`providers: ${notes.join("  ·  ")}`));
  };

  for (;;) {
    const raw = await lines.next(`${yellow("☀")} ${bold("❯")} `);
    if (raw === null) break; // Ctrl-D / closed input
    const line = raw.trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;

    // Auth flows own the terminal, so they live here where the readline does.
    if (line === "/login" || line.startsWith("/login ")) {
      const provider = line.split(/\s+/)[1];
      if (!provider) {
        console.log(dim("usage: /login <anthropic|openai|gemini>"));
        continue;
      }
      // Hand the TTY to the vendor's CLI: drop raw mode and pause our reader,
      // restore both afterwards so the session keeps its editing behavior.
      const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
      const wasRaw = Boolean(stdin.isTTY && stdin.isRaw);
      if (wasRaw) stdin.setRawMode(false);
      rl.pause();
      const outcome = loginWith(provider);
      rl.resume();
      if (wasRaw) stdin.setRawMode(true);
      if (!outcome.launched) console.log(`\n${outcome.instructions}\n`);
      await refreshProviders();
      continue;
    }
    if (line === "/reload") {
      await refreshProviders();
      continue;
    }

    if (line.startsWith("/")) {
      await handleSlash(line, session, config);
      continue;
    }
    try {
      await runInteractiveGoal(line, session, config, hub, lines);
    } catch (error) {
      console.log(red(`run failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  rl.close();
  await session.mcp?.close();
  console.log(dim("\nhasta luego ☀\n"));
}

async function handleSlash(line: string, session: InteractiveSession, config: ApolloConfig): Promise<void> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      console.log(INTERACTIVE_HELP);
      return;
    case "workspace":
    case "ws":
      if (!arg || arg === "off") {
        session.workspace = undefined;
        console.log(dim("workspace off — read-only built-in tools jailed to cwd"));
      } else {
        session.workspace = resolvePath(arg);
        console.log(dim(`workspace: ${session.workspace}${session.autoAllow ? "" : yellow("  (destructive tools will ask per call — /yes to auto-approve)")}`));
      }
      return;
    case "yes":
      session.autoAllow = !session.autoAllow;
      console.log(session.autoAllow ? yellow("auto-approving destructive tools for this session") : dim("destructive tools will ask per call"));
      return;
    case "check":
      if (!arg || arg === "off") {
        session.checks = [];
        console.log(dim("enforced checks cleared"));
      } else {
        try {
          session.checks = parseCheckSpecs(arg);
          console.log(dim(`enforced checks: ${session.checks.map(describeCheck).join(" · ")}`));
          if (!session.workspace) console.log(yellow("checks verify against the workspace — set one with /workspace <dir>"));
        } catch (error) {
          console.log(red(error instanceof Error ? error.message : String(error)));
        }
      }
      return;
    case "budget":
      session.budgetUsd = arg ? Number(arg) : undefined;
      console.log(dim(session.budgetUsd ? `budget: $${session.budgetUsd} per run` : "budget ceiling off"));
      return;
    case "turns":
      session.maxTurns = arg ? Number(arg) : undefined;
      console.log(dim(session.maxTurns ? `max turns: ${session.maxTurns} per run` : "turn ceiling off"));
      return;
    case "pin":
      session.pin = !arg || arg === "off" ? undefined : arg;
      console.log(dim(session.pin ? `pinned to ${session.pin}` : "unpinned — autorouting"));
      return;
    case "mcp":
      if (session.mcp) {
        await session.mcp.close();
        session.mcp = undefined;
        console.log(dim("Midas tools off"));
      } else if (!config.midas) {
        console.log(yellow(`no "midas" entry in ${CONFIG_FILENAME} — cannot bridge memory tools`));
      } else {
        try {
          session.mcp = new StdioMcpClient(config.midas);
          console.log(dim("Midas tools on — recall/remember become callable in runs"));
        } catch (error) {
          console.log(yellow(`MCP unavailable: ${error instanceof Error ? error.message : String(error)}`));
          session.mcp = undefined;
        }
      }
      return;
    case "models":
      return cmdModels();
    case "auth":
      return cmdAuth();
    case "stats":
      return cmdStats(new Map());
    case "runs":
      return cmdRuns();
    default:
      console.log(red(`unknown command /${cmd}`) + dim(" — /help lists them"));
  }
}

async function runInteractiveGoal(
  goal: string,
  session: InteractiveSession,
  config: ApolloConfig,
  hub: ProviderHub,
  lines: LineSource,
): Promise<void> {
  // Fresh registry per run: config + capability/provider filtering + pin, so a
  // /pin or a provider that came online mid-session is honored.
  const registry = buildMeasuredRegistry(config);
  for (const m of registry.list()) {
    const adapter = hub.get(m.provider);
    if (!adapter || adapter.supportsResponseFormat === false || adapter.supportsTools === false) {
      registry.update(m.id, { enabled: false });
    }
  }
  if (session.pin) {
    for (const m of registry.list()) if (m.id !== session.pin) registry.update(m.id, { enabled: false });
  }
  if (registry.list().length === 0) {
    console.log(red("no configured model supports the cognitive cycle — log in (apollo login <provider>) or add an API key"));
    return;
  }

  const tools = session.workspace ? workspaceTools(session.workspace) : builtinTools(process.cwd());
  let memoryClient: StdioMcpClient | undefined;
  let groundedContext: Awaited<ReturnType<typeof buildGroundedContext>> | undefined;
  if (config.midas) {
    try {
      memoryClient = session.mcp ?? new StdioMcpClient(config.midas);
      groundedContext = await buildGroundedContext(new MidasMemory(memoryClient), goal, { tokenBudget: 512 });
    } catch (error) {
      console.log(yellow(`Midas context unavailable: ${error instanceof Error ? error.message : String(error)}`));
      if (memoryClient !== session.mcp) await memoryClient?.close();
      memoryClient = undefined;
    }
  }
  if (session.mcp) {
    try {
      tools.registerAll(await mcpTools(session.mcp, "midas"));
    } catch (error) {
      console.log(yellow(`MCP tools unavailable this run: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  const runId = `cortex-${Date.now()}`;
  const bus = new EventBus();
  const t0 = Date.now();
  bus.on("*", (event) => printEvent(event, t0));
  const recording = startRecording(bus, join(RUNS_DIR, `${runId}.jsonl`));

  // The interactive confirm: this is the human in the loop. "a" upgrades to
  // session-wide auto-approve; anything but y/a denies (the model is told).
  const confirm = async (call: ToolCall): Promise<boolean> => {
    const policy = session.workspace ? loadExecutionPolicy(session.workspace) : undefined;
    const initial = policy ? decideToolCall(policy, call, session.autoAllow, tools.risk(call.name)) : undefined;
    if (initial?.action === "deny") {
      bus.emit({ type: "permission.decided", taskId: runId, tool: call.name, risk: initial.risk, decision: "deny", reason: initial.reason });
      return false;
    }
    if (initial?.action === "allow" || session.autoAllow) {
      bus.emit({ type: "permission.decided", taskId: runId, tool: call.name, risk: initial?.risk ?? tools.risk(call.name), decision: "allow", reason: initial?.reason ?? "approved for session" });
      return true;
    }
    const preview = redactText(JSON.stringify(call.arguments)).slice(0, 120);
    const raw = await lines.next(yellow(`  ⚠ allow ${call.name}(${preview})? [y/N/a=always] `));
    const answer = (raw ?? "").trim().toLowerCase();
    if (answer === "a" || answer === "always") {
      session.autoAllow = true;
      bus.emit({ type: "permission.decided", taskId: runId, tool: call.name, risk: initial?.risk ?? tools.risk(call.name), decision: "allow", reason: "approved for session" });
      return true;
    }
    const allowed = answer === "y" || answer === "yes";
    bus.emit({ type: "permission.decided", taskId: runId, tool: call.name, risk: initial?.risk ?? tools.risk(call.name), decision: allowed ? "allow" : "deny", reason: allowed ? "approved interactively" : "denied interactively" });
    return allowed;
  };

  const limits: Record<string, number> = {};
  if (session.budgetUsd) limits.budgetUsd = session.budgetUsd;
  if (session.maxTurns) limits.maxTurns = session.maxTurns;

  const result = await runCortex({
    hub,
    registry,
    goal,
    taskId: runId,
    tools,
    workspace: session.workspace,
    extraChecks: session.checks,
    confirm,
    bus,
    limits,
    context: groundedContext?.text,
    contextEvidence: groundedContext?.entries.map((entry) => ({ id: entry.id, summary: `${entry.provenance ?? "unknown"}${entry.source ? ` · ${entry.source}` : ""} · ${entry.content}` })),
  });
  recording.sink?.close();
  if (memoryClient && memoryClient !== session.mcp) await memoryClient.close();
  const missionDir = persistMissionContract(runId, goal, bus, session.workspace, session.checks, result.answer);

  console.log();
  const color = result.status === "ok" ? green : yellow;
  console.log(`${color(bold(result.status === "ok" ? "answer" : `stopped (${result.status})`))} — ${result.answer}\n`);
  console.log(dim(`${result.replans} replan(s) · ${result.turns} turn(s) · $${result.costUsd.toFixed(4)} · evidence → ${missionDir}`));
  console.log();
}

function cmdHelp(): void {
  console.log(`
${bold("apollo")} — fast, adaptive, verified local-first AI runtime

${bold("usage")}
  apollo "<goal>"             run one verified mission (recommended)
  npm run apollo               interactive session (type goals, /help inside)
  npm run apollo -- <command> [flags]

${bold("commands")}
  (none)     interactive terminal session — adaptive instant→agent→deep runtime
  init       integration wizard: detect subscriptions, API keys, local Ollama
             models, and Midas; offer logins; write/update ${CONFIG_FILENAME}
  login      launch a provider's official login (anthropic | openai | gemini)
  auth       show which providers Apollo can currently use
  models     show the model registry (defaults + your config)
  route      route a task and show the decision without executing
  run        route AND execute: apollo run "<prompt>" --kind <kind> [flags]
  agent      agentic loop with built-in tools: apollo agent "<prompt>" [--max-steps N] [--mcp]
             --mcp bridges your Midas tools; --workspace <dir> adds file+shell tools (--yes to allow)
  cortex     adaptive runtime (instant→agent→deep), phases autorouted:
             apollo cortex "<goal>" [--depth auto|instant|agent|deep] [--budget USD] [--max-turns N] [--mcp]
             --workspace <dir> lets it write files & run commands (needs --yes for destructive tools)
             --check "file_exists:p ; command_succeeds:cmd" — harness-enforced ground-truth checks
  runs       list recorded runs with their outcomes
  stats      measured telemetry per model and task kind from the recorded runs [--json]
  calibrate  propose profile overrides from measured data [--write] [--min-samples N]
  replay     re-render a recorded run: apollo replay <file.jsonl>
  dashboard  local mission center (create, stream, cancel, retry) [--port N] [--open] [--read-only]
  benchmark  reproducible comparisons [--variant all|model-only|model-tools|apollo-single|apollo-routed] [--repeat N] [--concurrency N] [--limit N]
  demo       simulated pipeline walkthrough (no keys needed)
  help       this message

${bold("route/run flags")}
  --kind <${TASK_KINDS.slice(0, 3).join("|")}|…>   (required)
  --complexity <trivial|standard|hard|frontier>
  --interactive            shift weight toward speed
  --context <tokens>       estimated input size (run: derived from prompt)
  --output <tokens>        output token cap (run default: 2000)
  --require <cap,cap>      hard capability requirements
  --budget <usd>           max estimated cost per task
  --pin <model-id>         force a model
  --deny <id,id>           exclude models
  --explain                full ranking + eliminations
  run only:
  --dry                    stop after the routing decision
  --memory                 request Midas context explicitly (enabled by default when configured)
  --no-memory              disable Midas context for this run
  --apply <dir>            write the model's file blocks into <dir> (workspace mode)
  --verify "<cmd && cmd>"  run checks in the workspace; failures self-correct + escalate
  --max-attempts <n>       execute+verify attempts before failing (default 2, or 3 with --apply)
  --record <path>          record the event stream here (default .apollo/runs/<id>.jsonl)
  --no-record              don't record this run

${bold("examples")}
  apollo "Fix the failing tests and prove they pass" --workspace . --yes
  npm run apollo -- auth
  npm run apollo -- login openai
  npm run apollo -- run "Explain the tradeoffs of SSE vs WebSockets" --kind research
  npm run apollo -- run "Write a factorial in JS with a Node test" --kind code-generation \\
      --apply ./out --verify "node factorial.test.js"
  npm run apollo -- agent "What is 4891 * 12? Use the calculator." --explain
  npm run apollo -- runs
  npm run apollo -- replay .apollo/runs/demo-1782000000000.jsonl
  npm run apollo -- demo

${bold("subscription login")} — Apollo reuses the sessions created by the official CLIs:
  Claude (Pro/Max):     ${dim("claude → /login")}         (or  ant auth login)
  Codex (ChatGPT):      ${dim("codex login")}
  Gemini (Google):      ${dim("gemini → Login with Google")}
  Cursor:               ${dim("no public API — not supported")}
Subscription models enter the router at marginal cost 0, so it prefers them over metered APIs.
`);
}

async function main(): Promise<void> {
  const [command = "interactive", ...rest] = process.argv.slice(2);
  const positional = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const flags = parseFlags(rest);
  switch (command) {
    case "interactive":
    case "tui":
    case "chat":
      return cmdInteractive();
    case "init":
      return cmdInit();
    case "login":
      return cmdLogin(positional);
    case "auth":
      return cmdAuth();
    case "models":
      return cmdModels();
    case "route":
      return cmdRoute(flags);
    case "run":
      return cmdRun(positional, flags);
    case "agent":
      return cmdAgent(positional, flags);
    case "cortex":
      return cmdCortex(positional, flags);
    case "runs":
      return cmdRuns();
    case "stats":
      return cmdStats(flags);
    case "calibrate":
      return cmdCalibrate(flags);
    case "replay":
      return cmdReplay(positional);
    case "dashboard":
      return cmdDashboard(flags);
    case "benchmark":
      return cmdBenchmark(flags);
    case "demo":
      return cmdDemo(flags);
    case "help":
    case "--help":
      return cmdHelp();
    default:
      // The primary product surface is a goal, not knowledge of Apollo's
      // internal modes. Explicit commands remain available for diagnostics.
      return cmdCortex(command, flags);
  }
}

main().catch((error) => {
  console.error(red(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(1);
});

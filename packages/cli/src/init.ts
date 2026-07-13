import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loginWith,
  resolveAnthropicAuth,
  resolveCodexAuth,
  resolveGeminiAuth,
} from "@archic/apollo-auth";
import {
  CONFIG_FILENAME,
  buildRegistry,
  loadConfig,
  type ApolloConfig,
  type LoadedConfig,
} from "@archic/apollo-config";
import type { ModelProfile } from "@archic/apollo-router";

export const CONFIG_TEMPLATE: ApolloConfig = {
  providers: {
    anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
    openai: { apiKeyEnv: "OPENAI_API_KEY" },
    google: { apiKeyEnv: "GEMINI_API_KEY" },
    ollama: { baseUrl: "http://localhost:11434" },
  },
  models: { register: [], update: {} },
  policy: {},
};

export interface InitAuthState {
  ok: boolean;
  detail: string;
}

export interface InitDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  loaded: LoadedConfig;
  ask(question: string, defaultAnswer: boolean): Promise<boolean>;
  print(line: string): void;
  fetch: typeof globalThis.fetch;
  resolveAnthropic(): InitAuthState;
  resolveCodex(): InitAuthState;
  resolveGemini(): Promise<InitAuthState>;
  login(provider: string): { launched: boolean; instructions: string };
  findExecutable(command: string): string | undefined;
}

export interface InitResult {
  target: string;
  changed: boolean;
  config: ApolloConfig;
}

export function defaultInitDependencies(
  ask: InitDependencies["ask"],
  print: InitDependencies["print"] = console.log,
): InitDependencies {
  return {
    cwd: process.cwd(),
    env: process.env,
    loaded: loadConfig(),
    ask,
    print,
    fetch: globalThis.fetch,
    resolveAnthropic: resolveAnthropicAuth,
    resolveCodex: resolveCodexAuth,
    resolveGemini: resolveGeminiAuth,
    login: loginWith,
    findExecutable(command) {
      const result = spawnSync("which", [command], { encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() || undefined : undefined;
    },
  };
}

export async function probeOllamaModels(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[] | undefined> {
  try {
    const res = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/tags`, {}, 2_500);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((model) => model.name).filter((name): name is string => Boolean(name));
  } catch {
    return undefined;
  }
}

export async function probeOllamaContext(
  baseUrl: string,
  name: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> {
  try {
    const res = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name }),
    }, 3_000);
    if (!res.ok) return 32_768;
    const body = (await res.json()) as { model_info?: Record<string, unknown> };
    for (const [key, value] of Object.entries(body.model_info ?? {})) {
      if (key.endsWith(".context_length") && typeof value === "number") return value;
    }
  } catch {
    // A local daemon is optional; use a conservative routing seed.
  }
  return 32_768;
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function seedOllamaProfile(name: string, contextWindow: number): ModelProfile {
  const lower = name.toLowerCase();
  const coder = lower.includes("coder") || lower.includes("code");
  const reasoner = lower.includes("r1") || lower.includes("think");
  return {
    id: `ollama/${name.replace(/:/g, "-")}`,
    nativeId: name,
    provider: "ollama",
    displayName: `${name} (local)`,
    contextWindow,
    maxOutputTokens: 8_000,
    capabilities: {
      code: coder ? 0.6 : 0.35,
      reasoning: reasoner ? 0.55 : 0.35,
      writing: 0.4,
      "tool-use": lower.includes("qwen") || lower.includes("llama3") || lower.includes("mistral") ? 0.5 : 0.3,
      "long-context": contextWindow >= 100_000 ? 0.5 : 0.3,
    },
    cost: { inputPerMTok: 0, outputPerMTok: 0 },
    latency: { ttftMs: 300, tokensPerSec: 40 },
    notes: "Detected by apollo init — capability/latency seeds; apollo calibrate refines them.",
  };
}

export async function runInitWizard(deps: InitDependencies): Promise<InitResult> {
  const { config: existing, path: existingPath } = deps.loaded;
  const target = existingPath ?? join(deps.cwd, CONFIG_FILENAME);
  const raw: ApolloConfig = existingPath
    ? (JSON.parse(readFileSync(existingPath, "utf8")) as ApolloConfig)
    : structuredClone(CONFIG_TEMPLATE);
  let changed = !existingPath;
  const status = (label: string, ok: boolean, detail: string) =>
    deps.print(`  ${ok ? "●" : "○"} ${label.padEnd(11)} ${detail}`);

  deps.print("\n  ☀ Apollo init — detect subscriptions, keys, local models, and memory");
  deps.print(`  config: ${target}${existingPath ? " (updating; existing entries are kept)" : " (new)"}\n`);
  deps.print("subscriptions");

  let anthropic = deps.resolveAnthropic();
  status("anthropic", anthropic.ok, anthropic.detail);
  if (!anthropic.ok && await deps.ask("log into Claude (official CLI) now?", false)) {
    const outcome = deps.login("anthropic");
    if (!outcome.launched) deps.print(outcome.instructions);
    anthropic = deps.resolveAnthropic();
    status("anthropic", anthropic.ok, anthropic.detail);
  }
  let codex = deps.resolveCodex();
  status("codex", codex.ok, codex.detail);
  if (!codex.ok && await deps.ask("log into ChatGPT/Codex now?", false)) {
    const outcome = deps.login("openai");
    if (!outcome.launched) deps.print(outcome.instructions);
    codex = deps.resolveCodex();
    status("codex", codex.ok, codex.detail);
  }
  const gemini = await deps.resolveGemini();
  status("gemini-cli", gemini.ok, gemini.detail);

  deps.print("\nAPI keys (only environment-variable names are stored)");
  for (const [provider, envName] of [
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["google", "GEMINI_API_KEY"],
  ] as const) {
    status(provider, Boolean(deps.env[envName]), deps.env[envName] ? `${envName} set` : `${envName} not set`);
    raw.providers ??= {};
    if (!raw.providers[provider]) {
      raw.providers[provider] = { apiKeyEnv: envName };
      changed = true;
    }
  }

  raw.providers ??= {};
  const ollamaBase = raw.providers.ollama?.baseUrl ?? "http://localhost:11434";
  if (!raw.providers.ollama) {
    raw.providers.ollama = { baseUrl: ollamaBase };
    changed = true;
  }
  deps.print(`\nlocal models (Ollama at ${ollamaBase})`);
  const tags = await probeOllamaModels(ollamaBase, deps.fetch);
  if (!tags) {
    status("ollama", false, "daemon not reachable; re-run init after starting it");
  } else {
    const known = new Set(buildRegistry(raw).list({ enabledOnly: false }).map((model) => model.id));
    const fresh = tags.filter((name) => !known.has(`ollama/${name.replace(/:/g, "-")}`));
    status("ollama", true, `${tags.length} installed; ${fresh.length} new`);
    if (fresh.length > 0 && await deps.ask(`register local models (${fresh.join(", ")})?`, true)) {
      raw.models ??= {};
      raw.models.register ??= [];
      for (const name of fresh) {
        raw.models.register.push(seedOllamaProfile(name, await probeOllamaContext(ollamaBase, name, deps.fetch)));
      }
      changed = true;
    }
  }

  deps.print("\nmemory");
  if (raw.midas) {
    status("midas", true, `wired: ${raw.midas.command}`);
  } else {
    const found = deps.findExecutable("midas-mcp");
    if (found && await deps.ask(`wire Midas memory found at ${found}?`, true)) {
      raw.midas = { command: "midas-mcp", args: [] };
      changed = true;
      status("midas", true, "wired: midas-mcp");
    } else {
      status("midas", Boolean(found), found ? "found but not wired" : "optional; midas-mcp not found");
    }
  }

  if (changed) writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`);
  deps.print(changed ? `\n${existingPath ? "updated" : "created"} ${target}` : `\nnothing to change — ${target}`);
  deps.print("secrets never touch the file; next: apollo");
  return { target, changed, config: raw };
}

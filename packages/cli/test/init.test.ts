import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApolloConfig } from "@archic/apollo-config";
import { runInitWizard, seedOllamaProfile, type InitDependencies } from "../src/init";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function harness(overrides: Partial<InitDependencies> = {}): Promise<InitDependencies> {
  const cwd = await mkdtemp(join(tmpdir(), "apollo-init-"));
  dirs.push(cwd);
  return {
    cwd,
    env: {},
    loaded: { config: {} },
    ask: async (_question, fallback) => fallback,
    print: () => undefined,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen2.5-coder:7b" }] });
      return Response.json({ model_info: { "qwen2.context_length": 65_536 } });
    },
    resolveAnthropic: () => ({ ok: false, detail: "not logged in" }),
    resolveCodex: () => ({ ok: false, detail: "not logged in" }),
    resolveGemini: async () => ({ ok: false, detail: "not logged in" }),
    login: () => ({ launched: false, instructions: "missing CLI" }),
    findExecutable: () => "/usr/bin/midas-mcp",
    ...overrides,
  };
}

describe("apollo init", () => {
  it("creates a config with detected local models and Midas without storing secrets", async () => {
    const deps = await harness({ env: { OPENAI_API_KEY: "secret-value" } });
    const result = await runInitWizard(deps);
    const written = readFileSync(result.target, "utf8");
    const config = JSON.parse(written) as ApolloConfig;

    expect(result.changed).toBe(true);
    expect(config.providers?.openai?.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(written).not.toContain("secret-value");
    expect(config.models?.register?.[0]).toMatchObject({
      id: "ollama/qwen2.5-coder-7b",
      nativeId: "qwen2.5-coder:7b",
      contextWindow: 65_536,
    });
    expect(config.midas).toEqual({ command: "midas-mcp", args: [] });
  });

  it("is idempotent and preserves user configuration", async () => {
    const deps = await harness();
    const path = join(deps.cwd, "apollo.config.json");
    const existing: ApolloConfig = {
      providers: {
        custom: { baseUrl: "http://custom.test" },
        anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
        openai: { apiKeyEnv: "OPENAI_API_KEY" },
        google: { apiKeyEnv: "GEMINI_API_KEY" },
        ollama: { baseUrl: "http://localhost:11434" },
      },
      models: { register: [seedOllamaProfile("qwen2.5-coder:7b", 65_536)] },
      midas: { command: "custom-midas", args: ["serve"] },
    };
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
    deps.loaded = { config: existing, path };

    const result = await runInitWizard(deps);

    expect(result.changed).toBe(false);
    expect(result.config.providers?.custom?.baseUrl).toBe("http://custom.test");
    expect(result.config.midas?.command).toBe("custom-midas");
    expect(result.config.models?.register).toHaveLength(1);
  });

  it("continues safely when Ollama is unavailable and prompts default to no", async () => {
    let loginCalls = 0;
    const deps = await harness({
      fetch: async () => { throw new Error("offline"); },
      ask: async (_question, fallback) => fallback,
      login: () => { loginCalls++; return { launched: true, instructions: "" }; },
      findExecutable: () => undefined,
    });

    const result = await runInitWizard(deps);

    expect(result.changed).toBe(true);
    expect(loginCalls).toBe(0);
    expect(result.config.models?.register).toEqual([]);
    expect(result.config.midas).toBeUndefined();
  });
});

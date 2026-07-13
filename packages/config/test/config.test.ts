import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRegistry, loadConfig, resolveCredentials } from "../src/index";

function tempConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "apollo-config-"));
  writeFileSync(join(dir, "apollo.config.json"), JSON.stringify(config));
  return dir;
}

describe("loadConfig", () => {
  it("returns an empty config when no file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "apollo-empty-"));
    // Point the user-level fallback at an empty dir too — the real machine may
    // have a ~/.config/apollo/apollo.config.json and this test must not see it.
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "apollo-noxdg-"));
    try {
      expect(loadConfig(dir)).toEqual({ config: {} });
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });

  it("loads, and finds the file from a nested start directory", () => {
    const dir = tempConfig({ policy: { maxCostPerTask: 0.5 } });
    const { config, path } = loadConfig(dir);
    expect(config.policy?.maxCostPerTask).toBe(0.5);
    expect(path).toContain("apollo.config.json");
  });

  it("rejects registered models missing required fields", () => {
    const dir = tempConfig({ models: { register: [{ id: "x/y" }] } });
    expect(() => loadConfig(dir)).toThrowError(/register entries need/);
  });
});

describe("buildRegistry", () => {
  it("applies registrations and updates on top of the defaults", () => {
    const registry = buildRegistry({
      models: {
        register: [
          {
            id: "ollama/dolphin-mistral-7b",
            nativeId: "dolphin-mistral:7b",
            provider: "ollama",
            displayName: "Dolphin Mistral 7B",
            contextWindow: 32_768,
            maxOutputTokens: 8_000,
            capabilities: { writing: 0.4, reasoning: 0.35, code: 0.3 },
            cost: { inputPerMTok: 0, outputPerMTok: 0 },
            latency: { ttftMs: 300, tokensPerSec: 40 },
          },
        ],
        update: { "openai/gpt-5.6-sol": { enabled: false } },
      },
    });
    expect(registry.get("ollama/dolphin-mistral-7b")?.nativeId).toBe("dolphin-mistral:7b");
    expect(registry.list().some((m) => m.id === "openai/gpt-5.6-sol")).toBe(false);
  });

  it("throws loudly on updates to unknown model ids", () => {
    expect(() => buildRegistry({ models: { update: { "nope/nothing": { enabled: false } } } })).toThrowError(
      /Unknown model/,
    );
  });
});

describe("resolveCredentials", () => {
  it("reads the API key from the referenced environment variable", () => {
    process.env.APOLLO_TEST_KEY = "sk-test-123";
    const creds = resolveCredentials(
      { providers: { anthropic: { apiKeyEnv: "APOLLO_TEST_KEY", baseUrl: "http://x" } } },
      "anthropic",
    );
    expect(creds).toEqual({ apiKey: "sk-test-123", baseUrl: "http://x" });
    delete process.env.APOLLO_TEST_KEY;
  });

  it("returns empty credentials for unconfigured providers", () => {
    expect(resolveCredentials({}, "openai")).toEqual({ apiKey: undefined, baseUrl: undefined });
  });
});

describe("user-level config fallback", () => {
  it("falls back to XDG_CONFIG_HOME/apollo when no project config exists upward", async () => {
    const { mkdirSync } = await import("node:fs");
    const { findConfigPath, userConfigPath } = await import("../src/index");
    const xdg = mkdtempSync(join(tmpdir(), "apollo-xdg-"));
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      mkdirSync(join(xdg, "apollo"), { recursive: true });
      writeFileSync(join(xdg, "apollo", "apollo.config.json"), "{}");
      const emptyDir = mkdtempSync(join(tmpdir(), "apollo-empty-"));
      expect(userConfigPath()).toBe(join(xdg, "apollo", "apollo.config.json"));
      expect(findConfigPath(emptyDir)).toBe(join(xdg, "apollo", "apollo.config.json"));
      // A project config upward still wins over the user-level fallback.
      const projectDir = tempConfig({});
      expect(findConfigPath(projectDir)).toBe(join(projectDir, "apollo.config.json"));
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

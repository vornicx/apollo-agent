import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jwtExpiryMs, resolveAnthropicAuth, resolveCodexAuth, resolveGeminiAuth } from "../src/index";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "apollo-home-"));
}

function fakeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `header.${payload}.sig`;
}

describe("resolveAnthropicAuth", () => {
  it("prefers explicit env credentials", () => {
    const auth = resolveAnthropicAuth({ env: { ANTHROPIC_API_KEY: "sk-x" } as NodeJS.ProcessEnv, home: fakeHome() });
    expect(auth).toMatchObject({ mode: "api-key", apiKey: "sk-x", ok: true });
  });

  it("detects a valid Claude Code subscription session", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "sub-token", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" },
      }),
    );
    const auth = resolveAnthropicAuth({ env: {} as NodeJS.ProcessEnv, home });
    expect(auth).toMatchObject({ mode: "claude-code", authToken: "sub-token", ok: true });
    expect(auth.detail).toContain("max");
  });

  it("flags an expired Claude Code session instead of using it", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: Date.now() - 1000 } }),
    );
    const auth = resolveAnthropicAuth({ env: {} as NodeJS.ProcessEnv, home });
    expect(auth.ok).toBe(false);
    expect(auth.mode).toBe("claude-code");
  });

  it("falls back to ant profiles, then none", () => {
    const home = fakeHome();
    expect(resolveAnthropicAuth({ env: {} as NodeJS.ProcessEnv, home }).mode).toBe("none");
    mkdirSync(join(home, ".config", "anthropic", "credentials"), { recursive: true });
    writeFileSync(join(home, ".config", "anthropic", "credentials", "default.json"), "{}");
    expect(resolveAnthropicAuth({ env: {} as NodeJS.ProcessEnv, home }).mode).toBe("ant-profile");
  });
});

describe("resolveCodexAuth", () => {
  it("reads the ChatGPT subscription session from ~/.codex/auth.json", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600), account_id: "acc-1" } }),
    );
    const auth = resolveCodexAuth({ home });
    expect(auth).toMatchObject({ mode: "chatgpt-subscription", accountId: "acc-1", ok: true });
  });

  it("reports expiry and missing logins", () => {
    const home = fakeHome();
    expect(resolveCodexAuth({ home }).ok).toBe(false);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) - 10) } }),
    );
    const auth = resolveCodexAuth({ home });
    expect(auth.ok).toBe(false);
    expect(auth.detail).toContain("refresh");
  });

  it("decodes JWT expiry", () => {
    expect(jwtExpiryMs(fakeJwt(1_000))).toBe(1_000_000);
    expect(jwtExpiryMs("not-a-jwt")).toBeUndefined();
  });
});

describe("resolveGeminiAuth", () => {
  it("uses a fresh token without refreshing", async () => {
    const home = fakeHome();
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "oauth_creds.json"),
      JSON.stringify({ access_token: "g-token", refresh_token: "r", expiry_date: Date.now() + 3_600_000 }),
    );
    const auth = await resolveGeminiAuth({ home, fetchFn: () => Promise.reject(new Error("should not refresh")) });
    expect(auth).toMatchObject({ mode: "google-account", accessToken: "g-token", ok: true });
  });

  it("refreshes an expired token in memory", async () => {
    const home = fakeHome();
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "oauth_creds.json"),
      JSON.stringify({ access_token: "stale", refresh_token: "r-1", expiry_date: Date.now() - 1000 }),
    );
    const bodies: string[] = [];
    const auth = await resolveGeminiAuth({
      home,
      clientId: "test-client",
      clientSecret: "test-secret",
      fetchFn: async (_url, init) => {
        bodies.push(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "fresh" }) };
      },
    });
    expect(bodies[0]).toContain("grant_type=refresh_token");
    expect(bodies[0]).toContain("refresh_token=r-1");
    expect(auth).toMatchObject({ mode: "google-account", accessToken: "fresh", ok: true });
  });

  it("does not embed refresh credentials and asks the official CLI to refresh", async () => {
    const home = fakeHome();
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "oauth_creds.json"),
      JSON.stringify({ access_token: "stale", refresh_token: "r-1", expiry_date: Date.now() - 1000 }),
    );
    const auth = await resolveGeminiAuth({ home });
    expect(auth).toMatchObject({ mode: "none", ok: false });
    expect(auth.detail).toContain("run `gemini`");
  });
});

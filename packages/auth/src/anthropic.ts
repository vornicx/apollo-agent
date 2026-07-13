import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AnthropicAuthMode = "api-key" | "auth-token" | "claude-code" | "ant-profile" | "none";

export interface AnthropicAuth {
  mode: AnthropicAuthMode;
  apiKey?: string;
  /** Bearer token (needs the `anthropic-beta: oauth-2025-04-20` header). */
  authToken?: string;
  detail: string;
  ok: boolean;
}

export interface AnthropicAuthOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

interface ClaudeCodeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
  };
}

/**
 * Resolution order: explicit env key → explicit env bearer → Claude Code
 * subscription session (`claude` /login) → `ant auth login` platform profile
 * (the official SDK resolves the profile itself; we only detect it).
 *
 * Subscription note: reusing the Claude Code session token calls the API on
 * your claude.ai plan. Anthropic may restrict subscription tokens to official
 * surfaces — if the API rejects it, Apollo falls back down this chain.
 */
export function resolveAnthropicAuth(options: AnthropicAuthOptions = {}): AnthropicAuth {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  if (env.ANTHROPIC_API_KEY) {
    return { mode: "api-key", apiKey: env.ANTHROPIC_API_KEY, detail: "ANTHROPIC_API_KEY (metered API)", ok: true };
  }
  if (env.ANTHROPIC_AUTH_TOKEN) {
    return { mode: "auth-token", authToken: env.ANTHROPIC_AUTH_TOKEN, detail: "ANTHROPIC_AUTH_TOKEN (bearer)", ok: true };
  }

  const claudeCreds = readClaudeCodeCredentials(join(home, ".claude", ".credentials.json"));
  if (claudeCreds?.accessToken) {
    if (claudeCreds.expiresAt !== undefined && claudeCreds.expiresAt <= Date.now()) {
      return {
        mode: "claude-code",
        detail: `Claude Code session expired — open \`claude\` once to refresh it`,
        ok: false,
      };
    }
    const plan = claudeCreds.subscriptionType ? ` (${claudeCreds.subscriptionType})` : "";
    return {
      mode: "claude-code",
      authToken: claudeCreds.accessToken,
      detail: `Claude subscription via Claude Code login${plan}`,
      ok: true,
    };
  }

  const configDir = env.ANTHROPIC_CONFIG_DIR ?? join(home, ".config", "anthropic");
  const credentialsDir = join(configDir, "credentials");
  if (existsSync(credentialsDir)) {
    try {
      if (readdirSync(credentialsDir).some((f) => f.endsWith(".json"))) {
        return { mode: "ant-profile", detail: "ant auth login profile (SDK resolves it)", ok: true };
      }
    } catch {
      // unreadable dir → treat as absent
    }
  }

  return { mode: "none", detail: "no credentials — set ANTHROPIC_API_KEY, or log in via `claude` or `ant auth login`", ok: false };
}

function readClaudeCodeCredentials(path: string): ClaudeCodeCredentials["claudeAiOauth"] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ClaudeCodeCredentials;
    return parsed.claudeAiOauth;
  } catch {
    return undefined;
  }
}

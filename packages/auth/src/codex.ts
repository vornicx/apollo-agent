import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexAuth {
  mode: "chatgpt-subscription" | "api-key" | "none";
  accessToken?: string;
  accountId?: string;
  apiKey?: string;
  /** Unix ms when the access token expires (from the JWT), if decodable. */
  expiresAt?: number;
  detail: string;
  ok: boolean;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

/**
 * Reuse the official Codex CLI login (`codex login`) stored at
 * ~/.codex/auth.json. The access token rides the user's ChatGPT plan against
 * the Codex backend; the Codex CLI owns refresh — when the token expires,
 * running any `codex` command renews it. Apollo never writes this file.
 */
export function resolveCodexAuth(options: { home?: string; now?: number } = {}): CodexAuth {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now();
  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(readFileSync(join(home, ".codex", "auth.json"), "utf8")) as CodexAuthFile;
  } catch {
    return { mode: "none", detail: "no Codex login — run `codex login`", ok: false };
  }

  const accessToken = parsed.tokens?.access_token;
  if (accessToken) {
    const expiresAt = jwtExpiryMs(accessToken);
    if (expiresAt !== undefined && expiresAt <= now) {
      return {
        mode: "chatgpt-subscription",
        detail: "Codex session expired — run any `codex` command to refresh it",
        ok: false,
        expiresAt,
      };
    }
    return {
      mode: "chatgpt-subscription",
      accessToken,
      accountId: parsed.tokens?.account_id,
      expiresAt,
      detail: "ChatGPT subscription via Codex login",
      ok: true,
    };
  }
  if (parsed.OPENAI_API_KEY) {
    return { mode: "api-key", apiKey: parsed.OPENAI_API_KEY, detail: "API key stored by Codex CLI", ok: true };
  }
  return { mode: "none", detail: "Codex auth file has no usable credentials — run `codex login`", ok: false };
}

/** Decode the `exp` claim of a JWT without verifying it (status display only). */
export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

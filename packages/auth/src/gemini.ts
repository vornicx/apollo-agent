import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GeminiAuth {
  mode: "google-account" | "none";
  accessToken?: string;
  detail: string;
  ok: boolean;
}

interface GeminiOauthCreds {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
}

type FetchJson = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GeminiAuthOptions {
  home?: string;
  now?: number;
  fetchFn?: FetchJson;
  /** Optional refresh credentials. Prefer letting the official Gemini CLI refresh its own session. */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Reuse the official Gemini CLI "Login with Google" session stored at
 * ~/.gemini/oauth_creds.json. When the access token is expired we refresh it
 * in memory (Google refresh tokens do not rotate); the file is never written,
 * so the Gemini CLI's own state stays untouched.
 */
export async function resolveGeminiAuth(options: GeminiAuthOptions = {}): Promise<GeminiAuth> {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now();
  const fetchFn = options.fetchFn ?? (fetch as unknown as FetchJson);

  let creds: GeminiOauthCreds;
  try {
    creds = JSON.parse(readFileSync(join(home, ".gemini", "oauth_creds.json"), "utf8")) as GeminiOauthCreds;
  } catch {
    return { mode: "none", detail: "no Gemini CLI login — run `gemini` and choose “Login with Google”", ok: false };
  }

  if (creds.access_token && creds.expiry_date !== undefined && creds.expiry_date > now + 60_000) {
    return { mode: "google-account", accessToken: creds.access_token, detail: "Google account via Gemini CLI login", ok: true };
  }
  if (!creds.refresh_token) {
    return { mode: "none", detail: "Gemini CLI credentials lack a refresh token — log in again with `gemini`", ok: false };
  }
  const clientId = options.clientId ?? process.env.GEMINI_CLI_OAUTH_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      mode: "none",
      detail: "Gemini CLI token expired — run `gemini` to refresh the official session, then retry",
      ok: false,
    };
  }

  const response = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!response.ok) {
    return {
      mode: "none",
      detail: `Gemini token refresh failed (HTTP ${response.status}) — log in again with \`gemini\``,
      ok: false,
    };
  }
  const refreshed = JSON.parse(await response.text()) as { access_token?: string };
  if (!refreshed.access_token) {
    return { mode: "none", detail: "Gemini token refresh returned no access token", ok: false };
  }
  return { mode: "google-account", accessToken: refreshed.access_token, detail: "Google account via Gemini CLI login (refreshed)", ok: true };
}

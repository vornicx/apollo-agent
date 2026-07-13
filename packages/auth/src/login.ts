import { spawnSync } from "node:child_process";

export interface LoginOutcome {
  launched: boolean;
  instructions: string;
}

/**
 * Apollo does not reimplement vendor OAuth flows: it launches each vendor's
 * official login and then reuses the stored session. Keeps Apollo out of the
 * secrets business and the flows exactly as each vendor ships them.
 */
export function loginWith(provider: string): LoginOutcome {
  switch (provider) {
    case "anthropic":
      return launch("ant", ["auth", "login"], [
        "Options for Anthropic:",
        "  1. `claude` → /login          (Claude subscription — Pro/Max quota)",
        "  2. `ant auth login`           (platform account, metered API, no static key)",
        "  3. export ANTHROPIC_API_KEY   (classic API key)",
        "Install ant: https://platform.claude.com/docs/en/api/sdks/cli",
      ]);
    case "openai":
      return launch("codex", ["login"], [
        "Options for OpenAI:",
        "  1. `codex login`              (ChatGPT subscription — Plus/Pro quota)",
        "  2. export OPENAI_API_KEY      (classic API key)",
        "Install Codex CLI: npm i -g @openai/codex",
      ]);
    case "gemini":
    case "google":
      return launch("gemini", [], [
        "Options for Google:",
        "  1. `gemini` → choose “Login with Google”  (free-tier quota on your account)",
        "  2. export GEMINI_API_KEY                   (AI Studio API key)",
        "Install Gemini CLI: npm i -g @google/gemini-cli",
      ]);
    case "cursor":
      return {
        launched: false,
        instructions:
          "Cursor has no public programmatic API — its backend is a proprietary, closed protocol tied to the editor. " +
          "Apollo cannot reuse a Cursor subscription today. Use Anthropic/OpenAI/Google logins instead.",
      };
    default:
      return { launched: false, instructions: `Unknown provider "${provider}". Try: anthropic, openai, gemini.` };
  }
}

function launch(command: string, args: string[], fallback: string[]): LoginOutcome {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    return { launched: false, instructions: [`\`${command}\` is not installed.`, ...fallback].join("\n") };
  }
  return { launched: true, instructions: fallback.join("\n") };
}

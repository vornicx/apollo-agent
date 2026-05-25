// Catalog of supported AI providers and models.
export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "groq"
  | "mistral"
  | "openrouter"
  | "cursor"
  | "opencode";

export type Provider = {
  id: ProviderId;
  name: string;
  // chat = can be used in unified chat; link = config card only
  kind: "chat" | "link";
  keyHint: string;
  keyUrl: string;
  models: string[];
  docsUrl: string;
};

export const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    kind: "chat",
    keyHint: "sk-ant-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://docs.anthropic.com/",
    models: [
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-20250514",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
  },
  {
    id: "openai",
    name: "OpenAI (GPT / Codex)",
    kind: "chat",
    keyHint: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://platform.openai.com/docs",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3-mini"],
  },
  {
    id: "google",
    name: "Google Gemini",
    kind: "chat",
    keyHint: "AIza...",
    keyUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/",
    models: [
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
  },
  {
    id: "groq",
    name: "Groq",
    kind: "chat",
    keyHint: "gsk_...",
    keyUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "chat",
    keyHint: "...",
    keyUrl: "https://console.mistral.ai/api-keys",
    docsUrl: "https://docs.mistral.ai/",
    models: ["mistral-large-latest", "mistral-small-latest", "open-mistral-nemo"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "chat",
    keyHint: "sk-or-...",
    keyUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4o",
      "google/gemini-2.0-flash-001",
      "meta-llama/llama-3.3-70b-instruct",
    ],
  },
  {
    id: "cursor",
    name: "Cursor AI",
    kind: "link",
    keyHint: "Configure in Cursor app",
    keyUrl: "https://cursor.com/",
    docsUrl: "https://docs.cursor.com/",
    models: [],
  },
  {
    id: "opencode",
    name: "OpenCode",
    kind: "link",
    keyHint: "Install CLI",
    keyUrl: "https://opencode.ai/",
    docsUrl: "https://opencode.ai/docs",
    models: [],
  },
];

export const CHAT_PROVIDERS = PROVIDERS.filter((p) => p.kind === "chat");

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

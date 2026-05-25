import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./constants.mjs";

export const PROVIDER_ENV = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

export function getProviderKey(provider) {
  return process.env[PROVIDER_ENV[provider] ?? ""];
}

export function checkKeys() {
  return Object.entries(PROVIDER_ENV).map(([provider, env]) => ({
    provider,
    env,
    present: Boolean(process.env[env]),
  }));
}

export async function callModel({ provider = DEFAULT_PROVIDER, model = DEFAULT_MODEL, messages }) {
  if (provider !== "openrouter") {
    throw new Error(`Apollo CLI v1 supports OpenRouter execution first. Unsupported: ${provider}`);
  }
  const apiKey = getProviderKey(provider);
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured. Add it to your shell environment or run in --mode plan.",
    );
  }
  const started = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/vornicx/apollo-agent",
      "X-Title": "Apollo Agent CLI",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter error ${response.status}: ${text.slice(0, 500)}`);
  }
  const body = JSON.parse(text);
  return {
    content: body.choices?.[0]?.message?.content ?? "",
    latencyMs: Date.now() - started,
    usage: body.usage ?? {},
  };
}

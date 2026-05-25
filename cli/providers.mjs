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

export async function callModel({
  provider = DEFAULT_PROVIDER,
  model = DEFAULT_MODEL,
  messages,
  onToken = null,
}) {
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
  const useStream = typeof onToken === "function";

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
      stream: useStream,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${errText.slice(0, 500)}`);
  }

  if (!useStream) {
    const body = JSON.parse(await response.text());
    return {
      content: body.choices?.[0]?.message?.content ?? "",
      latencyMs: Date.now() - started,
      usage: body.usage ?? {},
    };
  }

  return readSSEStream(response.body, onToken, started);
}

async function readSSEStream(body, onToken, started) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const token = chunk.choices?.[0]?.delta?.content ?? "";
          if (token) {
            content += token;
            onToken(token);
          }
        } catch { /* malformed chunk — skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content, latencyMs: Date.now() - started, usage: {} };
}

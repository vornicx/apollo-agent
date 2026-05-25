export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type SupportedProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "groq"
  | "mistral"
  | "openrouter";

const SERVER_KEY_ENV: Record<SupportedProvider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

export function getServerProviderKey(provider: string): string | null {
  const keys = SERVER_KEY_ENV[provider as SupportedProvider];
  if (!keys) return null;
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return null;
}

export async function callProviderText(
  provider: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
): Promise<string> {
  const res = await callProvider(provider, model, apiKey, messages, false);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Provider error (${res.status}): ${text.slice(0, 500)}`);
  }
  return parseProviderText(provider, await res.json());
}

export async function callProviderStream(
  provider: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
): Promise<Response> {
  return callProvider(provider, model, apiKey, messages, true);
}

export function makeSSEParser(provider: string): (line: string) => string {
  return (line: string) => {
    if (!line || line.startsWith(":") || !line.startsWith("data:")) return "";
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return "";
    try {
      const obj = JSON.parse(payload);
      if (provider === "anthropic") {
        if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
          return obj.delta.text ?? "";
        }
        return "";
      }
      if (provider === "google") {
        const parts = obj?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts))
          return parts.map((part: { text?: string }) => part.text ?? "").join("");
        return "";
      }
      return obj?.choices?.[0]?.delta?.content ?? "";
    } catch {
      return "";
    }
  };
}

async function callProvider(
  provider: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  stream: boolean,
): Promise<Response> {
  switch (provider) {
    case "anthropic":
      return callAnthropic(model, apiKey, messages, stream);
    case "openai":
    case "groq":
    case "openrouter":
    case "mistral":
      return callOpenAICompatible(provider, model, apiKey, messages, stream);
    case "google":
      return callGoogle(model, apiKey, messages, stream);
    default:
      return new Response(`Unsupported provider: ${provider}`, { status: 400 });
  }
}

function callAnthropic(
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  stream: boolean,
): Promise<Response> {
  const system = messages.find((message) => message.role === "system")?.content;
  const anthropicMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream,
      ...(system ? { system } : {}),
      messages: anthropicMessages,
    }),
  });
}

function callOpenAICompatible(
  provider: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  stream: boolean,
): Promise<Response> {
  const baseUrl =
    provider === "openai"
      ? "https://api.openai.com/v1"
      : provider === "groq"
        ? "https://api.groq.com/openai/v1"
        : provider === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : "https://api.mistral.ai/v1";

  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(provider === "openrouter"
        ? {
            "HTTP-Referer": process.env.APP_URL ?? "https://github.com/vornicx/apollo-agent",
            "X-Title": "Apollo Agent",
          }
        : {}),
    },
    body: JSON.stringify({ model, messages, stream }),
  });
}

function callGoogle(
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  stream: boolean,
): Promise<Response> {
  const system = messages.find((message) => message.role === "system")?.content;
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const separator = stream ? "&" : "?";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:${method}${separator}key=${encodeURIComponent(apiKey)}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    }),
  });
}

function parseProviderText(provider: string, body: unknown): string {
  const obj = body as {
    choices?: { message?: { content?: string } }[];
    content?: { text?: string }[];
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  if (provider === "anthropic") {
    return (
      obj.content
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? ""
    );
  }

  if (provider === "google") {
    return (
      obj.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? ""
    );
  }

  return obj.choices?.[0]?.message?.content?.trim() ?? "";
}

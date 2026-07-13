import { linesFrom, sseData, type ResponseLike } from "./http";
import { buildGeminiContents, geminiToolCalls, geminiToolMode, toGeminiTools, type GeminiPart } from "./messages";
import { type CompletionRequest, type CompletionResult, type DeltaHandler, type ToolCall } from "./types";

export interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * The inner Gemini `generateContent` request body — shared by the API-key path
 * (GoogleAdapter) and the Code Assist path (GeminiCliAdapter, which nests it
 * under { model, project, request }).
 */
export function buildGeminiInner(request: CompletionRequest): Record<string, unknown> {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = buildGeminiContents(request.messages);

  const generationConfig: Record<string, unknown> = {};
  if (request.maxTokens) generationConfig.maxOutputTokens = request.maxTokens;
  if (request.responseFormat) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = request.responseFormat.schema;
  }

  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(request.tools?.length
      ? {
          tools: toGeminiTools(request.tools),
          toolConfig: { functionCallingConfig: { mode: geminiToolMode(request.toolChoice) } },
        }
      : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

/**
 * Read a Gemini SSE stream (text deltas + accumulated functionCall parts).
 * `unwrap` normalizes the payload — identity for the API path, `.response` for
 * the Code Assist path that nests the chunk.
 */
export async function consumeGeminiStream(
  body: AsyncIterable<Uint8Array>,
  onDelta: DeltaHandler | undefined,
  unwrap: (parsed: unknown) => GeminiChunk,
): Promise<CompletionResult> {
  let text = "";
  let stopReason: string | undefined;
  let usage: CompletionResult["usage"];
  const toolCalls: ToolCall[] = [];

  for await (const line of linesFrom(body)) {
    const payload = sseData(line);
    if (!payload) continue;
    const chunk = unwrap(JSON.parse(payload));
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text) {
        text += part.text;
        onDelta?.(part.text);
      }
    }
    for (const call of geminiToolCalls(parts)) toolCalls.push({ ...call, id: `${call.id}_${toolCalls.length}` });
    if (candidate?.finishReason) stopReason = candidate.finishReason.toLowerCase();
    const meta = chunk.usageMetadata;
    if (meta) usage = { inputTokens: meta.promptTokenCount, outputTokens: meta.candidatesTokenCount };
  }

  return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage, stopReason };
}

/** Guard a fetch response and return its stream body or throw a descriptive error. */
export async function geminiBodyOrThrow(response: ResponseLike, provider: string): Promise<AsyncIterable<Uint8Array>> {
  if (!response.ok || !response.body) {
    const { ProviderError } = await import("./types");
    throw new ProviderError(provider, `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.body;
}

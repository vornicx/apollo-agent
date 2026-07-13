import type { ModelProfile } from "@archic/apollo-router";
import type { ChatMessage, ProviderHub, ToolCall } from "@archic/apollo-providers";
import type { ToolRegistry } from "./registry";

export interface AgentStep {
  step: number;
  /** Assistant text produced this step (may be empty on a pure tool-call turn). */
  text: string;
  toolCalls: ToolCall[];
  toolResults: Array<{ id: string; name: string; result: string }>;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentResult {
  text: string;
  steps: AgentStep[];
  /** Full transcript including tool calls and results — replayable/auditable. */
  messages: ChatMessage[];
  totalCostUsd: number;
  stoppedReason: "completed" | "max-steps";
}

export interface RunAgentOptions {
  hub: ProviderHub;
  model: ModelProfile;
  messages: ChatMessage[];
  tools: ToolRegistry;
  /** Hard cap on complete→tools cycles. Default 8. */
  maxSteps?: number;
  maxTokens?: number;
  onStep?: (step: AgentStep) => void;
  onToolCall?: (call: ToolCall) => void;
  onDelta?: (text: string) => void;
  /**
   * Gate for destructive tools (write, shell). Called only for tools the
   * registry marks destructive; returning false denies the call and the model
   * is told CONFIRMATION_REQUIRED (it can adapt) rather than the tool running.
   * Absent → everything runs (back-compatible).
   */
  onConfirm?: (call: ToolCall) => boolean | Promise<boolean>;
}

/**
 * The agentic loop: ask the model, run any tools it calls, feed the results
 * back, repeat until it answers without calling a tool (or the step budget is
 * spent). This is what turns "generate text" into "do the task" — and because
 * every tool result is appended to the transcript, the whole run stays
 * auditable.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { hub, model, tools } = options;
  const maxSteps = Math.max(1, options.maxSteps ?? 8);
  const messages: ChatMessage[] = [...options.messages];
  const steps: AgentStep[] = [];
  let totalCostUsd = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const completion = await hub.completeForModel(
      model,
      { messages, tools: tools.definitions(), toolChoice: "auto", maxTokens: options.maxTokens },
      options.onDelta,
    );
    totalCostUsd += completion.costUsd ?? 0;

    const toolCalls = completion.toolCalls ?? [];
    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: completion.text });
      const record: AgentStep = {
        step,
        text: completion.text,
        toolCalls: [],
        toolResults: [],
        costUsd: completion.costUsd,
        inputTokens: completion.usage?.inputTokens,
        outputTokens: completion.usage?.outputTokens,
      };
      steps.push(record);
      options.onStep?.(record);
      return { text: completion.text, steps, messages, totalCostUsd, stoppedReason: "completed" };
    }

    messages.push({ role: "assistant", content: completion.text, toolCalls });
    // Independent tool calls in one turn run concurrently; results keep call order.
    const toolResults = await Promise.all(
      toolCalls.map(async (call): Promise<AgentStep["toolResults"][number]> => {
        options.onToolCall?.(call);
        if (options.onConfirm && tools.isDestructive(call.name) && !(await options.onConfirm(call))) {
          return { id: call.id, name: call.name, result: `CONFIRMATION_REQUIRED: "${call.name}" was not approved; do not retry it — find another way or ask the user.` };
        }
        return { id: call.id, name: call.name, result: await tools.execute(call) };
      }),
    );
    for (const r of toolResults) messages.push({ role: "tool", toolCallId: r.id, name: r.name, content: r.result });
    const record: AgentStep = {
      step,
      text: completion.text,
      toolCalls,
      toolResults,
      costUsd: completion.costUsd,
      inputTokens: completion.usage?.inputTokens,
      outputTokens: completion.usage?.outputTokens,
    };
    steps.push(record);
    options.onStep?.(record);
  }

  const lastText = [...steps].reverse().find((s) => s.text)?.text ?? "";
  return { text: lastText, steps, messages, totalCostUsd, stoppedReason: "max-steps" };
}

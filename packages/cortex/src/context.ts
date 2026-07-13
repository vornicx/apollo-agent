import type { EventBus } from "@archic/apollo-core";
import { runStructured } from "@archic/apollo-agent";
import type { ProviderHub, ChatMessage } from "@archic/apollo-providers";
import {
  candidateForAttempt,
  ModelRegistry,
  Router,
  type Capability,
  type Complexity,
  type ModelProfile,
  type RoutingDecision,
  type TaskKind,
} from "@archic/apollo-router";
import type { MetaController } from "./meta";

export interface CortexContextOptions {
  hub: ProviderHub;
  registry: ModelRegistry;
  bus: EventBus;
  meta: MetaController;
  taskId: string;
}

/**
 * Shared plumbing for the cognitive phases. The point of Apollo-cortex: every
 * phase routes its own task kind through the autorouter, so the strongest
 * reasoning model plans/criticizes/verifies while cheaper models act — instead
 * of cortex-harness's fixed orchestrator/worker split. Routing, cost, and
 * turns all flow onto the one Apollo event stream.
 */
export class CortexContext {
  readonly hub: ProviderHub;
  readonly registry: ModelRegistry;
  readonly bus: EventBus;
  readonly meta: MetaController;
  readonly taskId: string;
  private readonly router: Router;
  private executions = 0;
  /** Attempt number of the most recent ACT execution — verification verdicts reference it. */
  lastActAttempt = 0;

  constructor(options: CortexContextOptions) {
    this.hub = options.hub;
    this.registry = options.registry;
    this.bus = options.bus;
    this.meta = options.meta;
    this.taskId = options.taskId;
    this.router = new Router(options.registry);
  }

  /** Route a phase and announce the decision on the stream. */
  route(kind: TaskKind, complexity: Complexity, require?: Capability[]): RoutingDecision {
    const decision = this.router.route({ kind, complexity, require });
    this.bus.emit({
      type: "routing.decided",
      taskId: this.taskId,
      modelId: decision.chosen.model.id,
      reason: `${kind} phase — ${decision.explanation}`,
      kind,
    });
    return decision;
  }

  /**
   * Every phase call is an execution on the stream: started/completed pairs
   * carry the model, real cost, tokens, and wall time — the raw material of the
   * routing telemetry loop (`apollo stats` / `calibrate`).
   */
  beginExecution(): number {
    const attempt = ++this.executions;
    this.bus.emit({ type: "execution.started", taskId: this.taskId, attempt });
    return attempt;
  }

  endExecution(
    attempt: number,
    modelId: string,
    costUsd?: number,
    usage?: { inputTokens?: number; outputTokens?: number },
  ): void {
    this.bus.emit({
      type: "execution.completed",
      taskId: this.taskId,
      attempt,
      modelId,
      costUsd,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
  }

  /** The escalation candidate for an attempt on a decision (for stuck steps). */
  candidate(decision: RoutingDecision, attempt: number): ModelProfile {
    return candidateForAttempt(decision, attempt).model;
  }

  /** Fold an agent loop's spend and step-count into the meta guards. */
  recordAgent(costUsd: number, steps: number): void {
    for (let i = 0; i < Math.max(1, steps); i++) this.meta.recordTurn(i === 0 ? costUsd : 0);
  }

  /** Route a phase and make a plain text completion (e.g. the final synthesis). */
  async complete(kind: TaskKind, complexity: Complexity, messages: ChatMessage[], maxTokens = 4000): Promise<string> {
    const decision = this.route(kind, complexity);
    const attempt = this.beginExecution();
    const out = await this.hub.completeForModel(decision.chosen.model, { messages, maxTokens });
    this.endExecution(attempt, decision.chosen.model.id, out.costUsd, out.usage);
    this.meta.recordTurn(out.costUsd ?? 0);
    return out.text;
  }

  /**
   * Route + structured JSON call for a cognitive phase. Records the spend/turn
   * into the meta-controller so the budget and turn guards see every call.
   */
  async structured<T>(
    kind: TaskKind,
    complexity: Complexity,
    messages: ChatMessage[],
    schema: Record<string, unknown>,
    name: string,
  ): Promise<{ value: T; model: ModelProfile }> {
    const decision = this.route(kind, complexity, ["tool-use"]);
    const model = decision.chosen.model;
    const attempt = this.beginExecution();
    const out = await runStructured<T>({ hub: this.hub, model, messages, schema, name, maxTokens: 4000 });
    this.endExecution(attempt, model.id, out.costUsd, out.usage);
    this.meta.recordTurn(out.costUsd);
    return { value: out.value, model };
  }
}

/**
 * Every observable thing Apollo does is one of these events. Surfaces (CLI,
 * desktop) render the stream; audits and benchmarks replay it. Keep the union
 * closed and typed — "know what happens at every moment" depends on it.
 */
export type ApolloEvent =
  | { type: "task.started"; taskId: string; title: string }
  | { type: "task.planned"; taskId: string; summary: string }
  | { type: "routing.decided"; taskId: string; modelId: string; reason: string; kind?: string }
  | { type: "execution.started"; taskId: string; attempt: number }
  | {
      type: "execution.completed";
      taskId: string;
      attempt: number;
      modelId?: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | { type: "execution.failed"; taskId: string; attempt: number; error: string }
  | { type: "verification.passed"; taskId: string; attempt: number }
  | { type: "verification.failed"; taskId: string; attempt: number; issues: string[] }
  | { type: "task.completed"; taskId: string; attempts: number }
  | { type: "task.failed"; taskId: string; attempts: number; reason: string }
  // Cognitive-cycle events (apollo-cortex). Optional in any run; the dashboard
  // and CLI renderers handle them, and they keep the whole cycle on one stream.
  | { type: "plan.produced"; taskId: string; steps: number; confidence: number; replan: boolean }
  | { type: "step.started"; taskId: string; stepId: string; description: string }
  | { type: "step.finished"; taskId: string; stepId: string; status: "done" | "failed"; note: string }
  | { type: "belief.recorded"; taskId: string; key: string; value: string }
  | { type: "critic.reviewed"; taskId: string; stepId: string; verdict: "pass" | "fail"; forceReplan: boolean; note: string }
  | { type: "permission.decided"; taskId: string; tool: string; risk: string; decision: "allow" | "deny"; reason: string }
  | { type: "meta.stop"; taskId: string; reason: string; status: string };

export type StampedEvent = ApolloEvent & { at: number; seq: number };

export type EventListener = (event: StampedEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly log: StampedEvent[] = [];
  private seq = 0;

  emit(event: ApolloEvent): StampedEvent {
    const stamped: StampedEvent = { ...event, at: Date.now(), seq: ++this.seq };
    this.log.push(stamped);
    for (const key of [event.type, "*"]) {
      const set = this.listeners.get(key);
      if (set) for (const listener of set) listener(stamped);
    }
    return stamped;
  }

  /** Subscribe to one event type, or "*" for everything. Returns an unsubscribe function. */
  on(type: ApolloEvent["type"] | "*", listener: EventListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Ordered, append-only record of everything emitted — the audit trail. */
  history(): readonly StampedEvent[] {
    return this.log;
  }
}

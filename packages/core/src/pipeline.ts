import { EventBus } from "./events";

export interface Task {
  id: string;
  title: string;
}

export interface ExecutionResult {
  output: string;
  modelId?: string;
  meta?: Record<string, unknown>;
}

export interface Verification {
  passed: boolean;
  issues: string[];
}

/**
 * The wiring layer (CLI, desktop, tests) supplies these hooks and composes the
 * router, providers, and memory into them. The engine stays agnostic: it owns
 * the lifecycle, the verification gate, retries, and event emission.
 *
 * `attempt` is 1-based and increases on every failed verification or thrown
 * execution — the hook is expected to escalate (e.g. via the router's ranked
 * candidate list) rather than blindly retry the same model.
 */
export interface PipelineHooks<Plan> {
  plan(task: Task): Promise<{ plan: Plan; summary: string }>;
  execute(task: Task, plan: Plan, attempt: number): Promise<ExecutionResult>;
  verify(task: Task, plan: Plan, result: ExecutionResult, attempt: number): Promise<Verification>;
}

export interface PipelineOptions {
  /** Max execute+verify attempts before the task is failed. Default 3, minimum 1. */
  maxAttempts?: number;
}

export type TaskOutcome =
  | { status: "succeeded"; task: Task; attempts: number; result: ExecutionResult }
  | { status: "failed"; task: Task; attempts: number; reason: string };

/**
 * Apollo's robustness contract in one loop: nothing is reported done unless
 * verification passed, and a failed verification escalates instead of shrugging.
 */
export class Pipeline<Plan> {
  private readonly maxAttempts: number;

  constructor(
    private readonly hooks: PipelineHooks<Plan>,
    readonly bus: EventBus = new EventBus(),
    options: PipelineOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  }

  async run(task: Task): Promise<TaskOutcome> {
    const { bus, hooks } = this;
    bus.emit({ type: "task.started", taskId: task.id, title: task.title });

    const { plan, summary } = await hooks.plan(task);
    bus.emit({ type: "task.planned", taskId: task.id, summary });

    let lastIssues: string[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      bus.emit({ type: "execution.started", taskId: task.id, attempt });

      let result: ExecutionResult;
      try {
        result = await hooks.execute(task, plan, attempt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bus.emit({ type: "execution.failed", taskId: task.id, attempt, error: message });
        lastIssues = [message];
        continue;
      }
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      bus.emit({
        type: "execution.completed",
        taskId: task.id,
        attempt,
        modelId: result.modelId,
        costUsd: num(result.meta?.costUsd),
        inputTokens: num(result.meta?.inputTokens),
        outputTokens: num(result.meta?.outputTokens),
      });

      const verdict = await hooks.verify(task, plan, result, attempt);
      if (verdict.passed) {
        bus.emit({ type: "verification.passed", taskId: task.id, attempt });
        bus.emit({ type: "task.completed", taskId: task.id, attempts: attempt });
        return { status: "succeeded", task, attempts: attempt, result };
      }

      lastIssues = verdict.issues;
      bus.emit({ type: "verification.failed", taskId: task.id, attempt, issues: verdict.issues });
    }

    const reason =
      lastIssues.length > 0
        ? `exhausted ${this.maxAttempts} attempts; last issues: ${lastIssues.join("; ")}`
        : `exhausted ${this.maxAttempts} attempts`;
    bus.emit({ type: "task.failed", taskId: task.id, attempts: this.maxAttempts, reason });
    return { status: "failed", task, attempts: this.maxAttempts, reason };
  }
}

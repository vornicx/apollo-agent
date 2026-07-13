import { describe, expect, it } from "vitest";
import { EventBus, Pipeline, type PipelineHooks } from "../src/index";

const task = { id: "t1", title: "test task" };

function hooks(overrides: Partial<PipelineHooks<string>> = {}): PipelineHooks<string> {
  return {
    plan: async () => ({ plan: "the-plan", summary: "one step" }),
    execute: async (_t, _p, attempt) => ({ output: `attempt-${attempt}` }),
    verify: async () => ({ passed: true, issues: [] }),
    ...overrides,
  };
}

describe("Pipeline", () => {
  it("runs plan → execute → verify and emits the full event sequence", async () => {
    const bus = new EventBus();
    const outcome = await new Pipeline(hooks(), bus).run(task);

    expect(outcome.status).toBe("succeeded");
    expect(bus.history().map((e) => e.type)).toEqual([
      "task.started",
      "task.planned",
      "execution.started",
      "execution.completed",
      "verification.passed",
      "task.completed",
    ]);
  });

  it("escalates on failed verification: attempt number reaches execute", async () => {
    const attempts: number[] = [];
    const bus = new EventBus();
    const outcome = await new Pipeline(
      hooks({
        execute: async (_t, _p, attempt) => {
          attempts.push(attempt);
          return { output: `attempt-${attempt}` };
        },
        verify: async (_t, _p, _r, attempt) => ({
          passed: attempt >= 2,
          issues: attempt >= 2 ? [] : ["tests failed"],
        }),
      }),
      bus,
    ).run(task);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.attempts).toBe(2);
    expect(attempts).toEqual([1, 2]);
    expect(bus.history().map((e) => e.type)).toContain("verification.failed");
  });

  it("fails after exhausting maxAttempts and reports the last issues", async () => {
    const outcome = await new Pipeline(
      hooks({ verify: async () => ({ passed: false, issues: ["still broken"] }) }),
      new EventBus(),
      { maxAttempts: 2 },
    ).run(task);

    expect(outcome.status).toBe("failed");
    expect(outcome.attempts).toBe(2);
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("still broken");
    }
  });

  it("treats a thrown execution as a failed attempt and keeps going", async () => {
    const bus = new EventBus();
    const outcome = await new Pipeline(
      hooks({
        execute: async (_t, _p, attempt) => {
          if (attempt === 1) throw new Error("provider timeout");
          return { output: "recovered" };
        },
      }),
      bus,
    ).run(task);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.attempts).toBe(2);
    expect(bus.history().some((e) => e.type === "execution.failed")).toBe(true);
  });
});

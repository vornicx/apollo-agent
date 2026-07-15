import { describe, expect, it } from "vitest";
import { CORE_BENCHMARK_TASKS, runBenchmark } from "../src/index";

describe("benchmark suite", () => {
  it("contains reproducible tasks spanning full files, patches, success, and honest stops", () => {
    expect(CORE_BENCHMARK_TASKS).toHaveLength(11);
    expect(CORE_BENCHMARK_TASKS.some((task) => task.id === "large-file-patch")).toBe(true);
    expect(new Set(CORE_BENCHMARK_TASKS.map((task) => task.category)).size).toBeGreaterThanOrEqual(5);
    expect(CORE_BENCHMARK_TASKS.some((task) => task.expected === "honest-stop")).toBe(true);
  });

  it("reports comparable correctness, false success, cost, and median duration", async () => {
    const report = await runBenchmark(CORE_BENCHMARK_TASKS.slice(0, 2), ["model-only", "apollo-routed"], async (_task, variant) => ({
      status: variant === "apollo-routed" ? "verified-success" : "false-success",
      durationMs: variant === "apollo-routed" ? 20 : 10,
      costUsd: variant === "apollo-routed" ? 0.02 : 0.01,
      models: ["test/model"],
      attempts: 1,
    }));
    expect(report.aggregates[0]).toMatchObject({ variant: "model-only", correct: 0, falseSuccesses: 2 });
    expect(report.aggregates[1]).toMatchObject({ variant: "apollo-routed", correct: 2, verifiedSuccessRate: 1 });
    expect(report.schemaVersion).toBe(5);
    expect(report.aggregates[1].successRate95Ci).toHaveLength(2);
  });

  it("repeats every task and reports dispersion and total turns", async () => {
    const report = await runBenchmark(CORE_BENCHMARK_TASKS.slice(0, 1), ["apollo-routed"], async () => ({
      status: "verified-success",
      durationMs: 10,
      costUsd: 0,
      models: ["test/model"],
      attempts: 3,
    }), "ci", 3);
    expect(report.attempts.map((attempt) => attempt.repetition)).toEqual([1, 2, 3]);
    expect(report.aggregates[0]).toMatchObject({ uniqueTasks: 1, repetitions: 3, tasks: 3, totalTurns: 9, totalModelCalls: 9, meanModelCalls: 3 });
  });

  it("runs with bounded concurrency while preserving report order", async () => {
    let active = 0;
    let peak = 0;
    const report = await runBenchmark(CORE_BENCHMARK_TASKS.slice(0, 2), ["model-only", "model-tools"], async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: "verified-success", durationMs: 10, costUsd: 0, models: ["test/model"], attempts: 1 };
    }, "parallel", 1, 2);
    expect(peak).toBe(2);
    expect(report.attempts.map((attempt) => `${attempt.taskId}:${attempt.variant}`)).toEqual([
      "repair-node-test:model-only",
      "repair-node-test:model-tools",
      "implement-slug:model-only",
      "implement-slug:model-tools",
    ]);
  });

  it("excludes infrastructure errors from correctness and stops scheduling after quota exhaustion", async () => {
    let calls = 0;
    const report = await runBenchmark(CORE_BENCHMARK_TASKS.slice(0, 3), ["model-only"], async () => {
      calls += 1;
      if (calls === 2) throw new Error("HTTP 429: usage_limit_reached");
      return { status: "verified-success", durationMs: 10, costUsd: 0, models: ["test/model"], attempts: 1 };
    });
    expect(calls).toBe(2);
    expect(report.attempts.map((attempt) => attempt.status)).toEqual(["verified-success", "invalid", "invalid"]);
    expect(report.aggregates[0]).toMatchObject({ tasks: 3, validAttempts: 1, infrastructureFailures: 2, correct: 1, verifiedSuccessRate: 1 });
  });
});

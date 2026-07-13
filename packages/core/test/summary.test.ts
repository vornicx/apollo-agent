import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, JsonlEventSink, listRunSummaries, summarizeRun } from "../src/index";

function record(dir: string, id: string, emit: (bus: EventBus) => void): void {
  const bus = new EventBus();
  new JsonlEventSink(join(dir, `${id}.jsonl`)).attach(bus);
  emit(bus);
}

describe("summarizeRun", () => {
  it("captures outcome, cost, and the escalation path", () => {
    const bus = new EventBus();
    const events: Parameters<EventBus["emit"]>[0][] = [
      { type: "task.started", taskId: "t", title: "do the thing" },
      { type: "execution.completed", taskId: "t", attempt: 1, modelId: "codex/gpt-5.1-codex", costUsd: 0 },
      { type: "verification.failed", taskId: "t", attempt: 1, issues: ["tests failed"] },
      { type: "execution.completed", taskId: "t", attempt: 2, modelId: "openai/gpt-5.1", costUsd: 0.02 },
      { type: "task.completed", taskId: "t", attempts: 2 },
    ];
    for (const e of events) bus.emit(e);

    const summary = summarizeRun(bus.history());
    expect(summary).toMatchObject({
      title: "do the thing",
      status: "succeeded",
      attempts: 2,
      costUsd: 0.02,
      finalModel: "openai/gpt-5.1",
      models: ["codex/gpt-5.1-codex", "openai/gpt-5.1"],
    });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks a failed run", () => {
    const bus = new EventBus();
    bus.emit({ type: "task.started", taskId: "t", title: "x" });
    bus.emit({ type: "task.failed", taskId: "t", attempts: 3, reason: "exhausted" });
    expect(summarizeRun(bus.history()).status).toBe("failed");
  });
});

describe("listRunSummaries", () => {
  it("lists recorded runs newest-first with summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "apollo-runs-"));
    record(dir, "run-1", (bus) => {
      bus.emit({ type: "task.started", taskId: "a", title: "first" });
      bus.emit({ type: "task.completed", taskId: "a", attempts: 1 });
    });
    record(dir, "run-2", (bus) => {
      bus.emit({ type: "task.started", taskId: "b", title: "second" });
      bus.emit({ type: "task.failed", taskId: "b", attempts: 2, reason: "nope" });
    });

    const summaries = listRunSummaries(dir);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => typeof s.id === "string")).toBe(true);
    expect(new Set(summaries.map((s) => s.status))).toEqual(new Set(["succeeded", "failed"]));
  });

  it("returns empty for a missing directory", () => {
    expect(listRunSummaries(join(tmpdir(), "apollo-does-not-exist-xyz"))).toEqual([]);
  });
});

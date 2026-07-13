import { describe, expect, it } from "vitest";
import {
  aggregateTelemetry,
  collectSamples,
  proposeCalibration,
  type ApolloEvent,
  type StampedEvent,
} from "../src/index";

/** Hand-stamped events so durations are deterministic. */
function ev(at: number, seq: number, event: ApolloEvent): StampedEvent {
  return { ...event, at, seq };
}

function runEvents(): StampedEvent[] {
  return [
    ev(0, 1, { type: "task.started", taskId: "t", title: "x" }),
    ev(10, 2, { type: "routing.decided", taskId: "t", modelId: "a/one", reason: "r", kind: "code-generation" }),
    ev(20, 3, { type: "execution.started", taskId: "t", attempt: 1 }),
    ev(1_020, 4, { type: "execution.completed", taskId: "t", attempt: 1, modelId: "a/one", costUsd: 0.01, outputTokens: 500 }),
    ev(1_030, 5, { type: "verification.failed", taskId: "t", attempt: 1, issues: ["tests failed"] }),
    ev(1_040, 6, { type: "routing.decided", taskId: "t", modelId: "b/two", reason: "escalated", kind: "code-generation" }),
    ev(1_050, 7, { type: "execution.started", taskId: "t", attempt: 2 }),
    ev(3_050, 8, { type: "execution.completed", taskId: "t", attempt: 2, modelId: "b/two", costUsd: 0.05, outputTokens: 1_000 }),
    ev(3_060, 9, { type: "verification.passed", taskId: "t", attempt: 2 }),
    ev(3_070, 10, { type: "task.completed", taskId: "t", attempts: 2 }),
  ];
}

describe("collectSamples", () => {
  it("attributes attempts to model, kind, duration, and verification verdict", () => {
    const samples = collectSamples(runEvents(), "run-1");
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      runId: "run-1",
      modelId: "a/one",
      kind: "code-generation",
      durationMs: 1_000,
      costUsd: 0.01,
      outputTokens: 500,
      verified: false,
    });
    expect(samples[1]).toMatchObject({ modelId: "b/two", durationMs: 2_000, verified: true });
  });

  it("handles old logs without kind and without verification", () => {
    const samples = collectSamples([
      ev(0, 1, { type: "routing.decided", taskId: "t", modelId: "a/one", reason: "r" }),
      ev(5, 2, { type: "execution.completed", taskId: "t", attempt: 1, modelId: "a/one", costUsd: 0.02 }),
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0].kind).toBe("unknown");
    expect(samples[0].verified).toBeUndefined();
    expect(samples[0].durationMs).toBeUndefined(); // no execution.started recorded
  });
});

describe("aggregateTelemetry", () => {
  it("aggregates per model with verify rate, cost, and measured throughput", () => {
    const stats = aggregateTelemetry(collectSamples(runEvents()));
    const a = stats.find((m) => m.modelId === "a/one")!;
    const b = stats.find((m) => m.modelId === "b/two")!;

    expect(a.samples).toBe(1);
    expect(a.verifyRate).toBe(0);
    expect(a.totalCostUsd).toBeCloseTo(0.01);
    expect(a.measuredTokensPerSec).toBe(500); // 500 tok / 1s
    expect(a.byKind[0]).toMatchObject({ kind: "code-generation", samples: 1, failed: 1 });

    expect(b.verifyRate).toBe(1);
    expect(b.measuredTokensPerSec).toBe(500); // 1000 tok / 2s
  });

  it("leaves verifyRate undefined when nothing was verified", () => {
    const stats = aggregateTelemetry([{ modelId: "a/one", kind: "research" }]);
    expect(stats[0].verifyRate).toBeUndefined();
    expect(stats[0].measuredTokensPerSec).toBeUndefined();
  });
});

describe("proposeCalibration", () => {
  const profile = { id: "a/one", latency: { tokensPerSec: 100 } };

  function telemetryWith(measured: number, throughputSamples: number) {
    return [
      {
        modelId: "a/one",
        samples: throughputSamples,
        verified: 0,
        failed: 0,
        totalCostUsd: 0,
        measuredTokensPerSec: measured,
        throughputSamples,
        byKind: [],
      },
    ];
  }

  it("proposes a measured tokensPerSec override when deviation is large enough", () => {
    const proposals = proposeCalibration(telemetryWith(50, 6), [profile]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      modelId: "a/one",
      current: 100,
      measured: 50,
      patch: { latency: { tokensPerSec: 50 } },
    });
  });

  it("stays quiet under the sample floor or under the deviation floor", () => {
    expect(proposeCalibration(telemetryWith(50, 4), [profile])).toHaveLength(0); // < 5 samples
    expect(proposeCalibration(telemetryWith(95, 10), [profile])).toHaveLength(0); // 5% deviation
  });

  it("ignores models without a profile", () => {
    const proposals = proposeCalibration(telemetryWith(50, 10), [{ id: "other", latency: { tokensPerSec: 10 } }]);
    expect(proposals).toHaveLength(0);
  });
});

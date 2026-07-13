import type { StampedEvent } from "./events";
import { listRunFiles } from "./summary";
import { readEventLog } from "./sink";

/**
 * M3: the routing telemetry loop. Model profiles start as seed estimates; this
 * module measures what actually happened — latency, throughput, cost, and
 * verification outcomes per model and per task kind — from the recorded event
 * streams, so profiles can be calibrated from Apollo's own runs instead of
 * guesses. Pure derivation over the JSONL audit trail: no new state, no model.
 */

/** One executed attempt, attributed to the model (and task kind) that ran it. */
export interface TelemetrySample {
  runId?: string;
  modelId: string;
  /** Task kind from the routing decision that led to this execution; "unknown" for old logs. */
  kind: string;
  /** Wall time of the attempt (execution.started → execution.completed), when both were recorded. */
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Verification verdict for this attempt: true/false when recorded, undefined when the run never verified it. */
  verified?: boolean;
}

export interface KindTelemetry {
  kind: string;
  samples: number;
  verified: number;
  failed: number;
  /** verified / (verified + failed); undefined when no attempt was ever verified. */
  verifyRate?: number;
}

export interface ModelTelemetry {
  modelId: string;
  samples: number;
  verified: number;
  failed: number;
  verifyRate?: number;
  totalCostUsd: number;
  /** Mean attempt wall time over samples that have one. */
  avgDurationMs?: number;
  /** Median measured output throughput over samples with tokens + duration. */
  measuredTokensPerSec?: number;
  /** How many samples carried tokens + duration and back the throughput figure. */
  throughputSamples: number;
  byKind: KindTelemetry[];
}

/**
 * Walk one run's event stream and attribute every executed attempt to its
 * model, task kind, wall time, and verification verdict. Kind comes from the
 * last routing.decided before the attempt started (old logs → "unknown").
 */
export function collectSamples(events: readonly StampedEvent[], runId?: string): TelemetrySample[] {
  const samples: TelemetrySample[] = [];
  const byAttempt = new Map<number, TelemetrySample>();
  const startedAt = new Map<number, number>();
  let lastKind = "unknown";

  for (const event of events) {
    if (event.type === "routing.decided") {
      lastKind = event.kind ?? "unknown";
    } else if (event.type === "execution.started") {
      startedAt.set(event.attempt, event.at);
    } else if (event.type === "execution.completed") {
      if (!event.modelId) continue;
      const t0 = startedAt.get(event.attempt);
      const sample: TelemetrySample = {
        runId,
        modelId: event.modelId,
        kind: lastKind,
        durationMs: t0 !== undefined && event.at >= t0 ? event.at - t0 : undefined,
        costUsd: event.costUsd,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
      samples.push(sample);
      byAttempt.set(event.attempt, sample);
    } else if (event.type === "verification.passed" || event.type === "verification.failed") {
      const sample = byAttempt.get(event.attempt);
      if (sample) sample.verified = event.type === "verification.passed";
    }
  }
  return samples;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Aggregate samples into per-model (and per-kind) measured telemetry. */
export function aggregateTelemetry(samples: TelemetrySample[]): ModelTelemetry[] {
  const byModel = new Map<string, TelemetrySample[]>();
  for (const sample of samples) {
    const list = byModel.get(sample.modelId) ?? [];
    list.push(sample);
    byModel.set(sample.modelId, list);
  }

  const out: ModelTelemetry[] = [];
  for (const [modelId, list] of byModel) {
    const verified = list.filter((s) => s.verified === true).length;
    const failed = list.filter((s) => s.verified === false).length;
    const durations = list.map((s) => s.durationMs).filter((d): d is number => d !== undefined && d > 0);
    const throughputs = list
      .filter((s) => s.outputTokens !== undefined && s.durationMs !== undefined && s.durationMs > 0)
      .map((s) => (s.outputTokens! / s.durationMs!) * 1000);

    const kinds = new Map<string, TelemetrySample[]>();
    for (const sample of list) {
      const kl = kinds.get(sample.kind) ?? [];
      kl.push(sample);
      kinds.set(sample.kind, kl);
    }
    const byKind: KindTelemetry[] = [...kinds.entries()]
      .map(([kind, kl]) => {
        const kVerified = kl.filter((s) => s.verified === true).length;
        const kFailed = kl.filter((s) => s.verified === false).length;
        return {
          kind,
          samples: kl.length,
          verified: kVerified,
          failed: kFailed,
          verifyRate: kVerified + kFailed > 0 ? kVerified / (kVerified + kFailed) : undefined,
        };
      })
      .sort((a, b) => b.samples - a.samples);

    out.push({
      modelId,
      samples: list.length,
      verified,
      failed,
      verifyRate: verified + failed > 0 ? verified / (verified + failed) : undefined,
      totalCostUsd: list.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
      avgDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : undefined,
      measuredTokensPerSec: median(throughputs),
      throughputSamples: throughputs.length,
      byKind,
    });
  }
  return out.sort((a, b) => b.samples - a.samples);
}

/** Measure every recorded run in a directory. Unreadable runs are skipped. */
export function telemetryFromDir(dir: string): ModelTelemetry[] {
  const samples: TelemetrySample[] = [];
  for (const { id, path } of listRunFiles(dir)) {
    try {
      samples.push(...collectSamples(readEventLog(path), id));
    } catch {
      // unreadable/partial run file — telemetry is best-effort over the rest
    }
  }
  return aggregateTelemetry(samples);
}

// ── calibration ──────────────────────────────────────────────────────────────

/** The slice of a model profile calibration reads — structural, so core stays router-free. */
export interface CalibratableProfile {
  id: string;
  latency: { tokensPerSec: number };
}

export interface CalibrationProposal {
  modelId: string;
  field: "latency.tokensPerSec";
  current: number;
  measured: number;
  samples: number;
  /** Ready to merge into apollo.config.json `models.update[modelId]`. */
  patch: { latency: { tokensPerSec: number } };
}

export interface CalibrationOptions {
  /** Minimum measured samples before proposing an override. Default 5. */
  minSamples?: number;
  /** Minimum relative deviation from the profile before proposing. Default 0.2 (20%). */
  minDeviation?: number;
}

/**
 * Propose profile overrides backed purely by measurement. Only throughput is
 * proposed — it is directly measured; quality/capability numbers stay human- or
 * benchmark-owned (verify rates are reported by `aggregateTelemetry` for that
 * judgment call). Honest scaffolding: no heuristic dressed up as data.
 */
export function proposeCalibration(
  telemetry: ModelTelemetry[],
  profiles: CalibratableProfile[],
  options: CalibrationOptions = {},
): CalibrationProposal[] {
  const minSamples = options.minSamples ?? 5;
  const minDeviation = options.minDeviation ?? 0.2;
  const byId = new Map(profiles.map((p) => [p.id, p]));

  const proposals: CalibrationProposal[] = [];
  for (const t of telemetry) {
    const profile = byId.get(t.modelId);
    if (!profile || t.measuredTokensPerSec === undefined) continue;
    if (t.throughputSamples < minSamples) continue;
    const current = profile.latency.tokensPerSec;
    const measured = Math.round(t.measuredTokensPerSec);
    if (current > 0 && Math.abs(measured - current) / current < minDeviation) continue;
    proposals.push({
      modelId: t.modelId,
      field: "latency.tokensPerSec",
      current,
      measured,
      samples: t.samples,
      patch: { latency: { tokensPerSec: measured } },
    });
  }
  return proposals;
}

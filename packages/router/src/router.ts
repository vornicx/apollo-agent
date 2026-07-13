import type { ModelRegistry } from "./registry";
import {
  COMPLEXITY_WEIGHTS,
  INTERACTIVE_SPEED_BOOST,
  KIND_CAPABILITY_MIX,
  QUALITY_FLOOR,
  REQUIRED_CAPABILITY_FLOOR,
} from "./taxonomy";
import type {
  Capability,
  Elimination,
  ModelProfile,
  ResolvedTaskSpec,
  RoutingDecision,
  RoutingPolicy,
  RoutingWeights,
  ScoredCandidate,
  TaskKind,
  TaskSpec,
} from "./types";

const DEFAULT_CONTEXT_TOKENS = 8_000;
const DEFAULT_OUTPUT_TOKENS = 1_000;

export class RoutingError extends Error {
  constructor(
    message: string,
    readonly eliminated: Elimination[] = [],
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

/** Task-fit quality: the model's capabilities weighted by the task kind's mix. */
export function taskQuality(model: ModelProfile, kind: TaskKind): number {
  const mix = KIND_CAPABILITY_MIX[kind];
  let quality = 0;
  let total = 0;
  for (const [capability, weight] of Object.entries(mix) as [Capability, number][]) {
    total += weight;
    quality += weight * (model.capabilities[capability] ?? 0);
  }
  return total > 0 ? quality / total : 0;
}

export function estimateCostUsd(model: ModelProfile, task: ResolvedTaskSpec): number {
  return (
    (task.contextTokens / 1_000_000) * model.cost.inputPerMTok +
    (task.expectedOutputTokens / 1_000_000) * model.cost.outputPerMTok
  );
}

export function estimateSeconds(model: ModelProfile, task: ResolvedTaskSpec): number {
  return model.latency.ttftMs / 1000 + task.expectedOutputTokens / model.latency.tokensPerSec;
}

function resolveTask(task: TaskSpec): ResolvedTaskSpec {
  return {
    ...task,
    complexity: task.complexity ?? "standard",
    latency: task.latency ?? "background",
    contextTokens: task.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    expectedOutputTokens: task.expectedOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
  };
}

function resolveWeights(task: ResolvedTaskSpec, policy: RoutingPolicy): RoutingWeights {
  const base = { ...COMPLEXITY_WEIGHTS[task.complexity] };
  if (task.latency === "interactive") base.speed += INTERACTIVE_SPEED_BOOST;
  const merged: RoutingWeights = { ...base, ...policy.weights };
  const sum = merged.quality + merged.cost + merged.speed;
  if (sum <= 0) return { ...COMPLEXITY_WEIGHTS.standard };
  return { quality: merged.quality / sum, cost: merged.cost / sum, speed: merged.speed / sum };
}

/** Min-max normalize to 0..1. invert=true makes the smallest raw value score 1 (cheapest/fastest wins). */
function normalize(values: number[], invert: boolean): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  return values.map((v) => (invert ? (max - v) / (max - min) : (v - min) / (max - min)));
}

function hardEliminationReason(
  model: ModelProfile,
  task: ResolvedTaskSpec,
  denied: Set<string>,
  policy: RoutingPolicy,
): string | undefined {
  if (denied.has(model.id)) return "denied by policy";
  for (const capability of task.require ?? []) {
    const level = model.capabilities[capability] ?? 0;
    if (level < REQUIRED_CAPABILITY_FLOOR) {
      return `missing required capability "${capability}" (${level.toFixed(2)} < ${REQUIRED_CAPABILITY_FLOOR})`;
    }
  }
  const needed = task.contextTokens + task.expectedOutputTokens;
  if (model.contextWindow < needed) {
    return `context window too small (needs ~${needed} tokens, has ${model.contextWindow})`;
  }
  if (task.expectedOutputTokens > model.maxOutputTokens) {
    return `output cap too small (needs ${task.expectedOutputTokens} tokens, caps at ${model.maxOutputTokens})`;
  }
  if (policy.maxCostPerTask !== undefined) {
    const cost = estimateCostUsd(model, task);
    if (cost > policy.maxCostPerTask) {
      return `estimated cost $${cost.toFixed(4)} exceeds budget $${policy.maxCostPerTask.toFixed(4)}`;
    }
  }
  return undefined;
}

export class Router {
  constructor(private readonly registry: ModelRegistry) {}

  /**
   * Deterministic: same registry, task, and policy always produce the same
   * decision (ties break on cost, then id). The returned ranking is also the
   * escalation chain for the pipeline.
   */
  route(spec: TaskSpec, policy: RoutingPolicy = {}): RoutingDecision {
    const task = resolveTask(spec);
    const weights = resolveWeights(task, policy);
    const eliminated: Elimination[] = [];
    let floorRelaxed = false;

    let pool: ModelProfile[];
    if (policy.pin) {
      const pinned = this.registry.get(policy.pin);
      if (!pinned || pinned.enabled === false) {
        throw new RoutingError(`Pinned model is not available: ${policy.pin}`);
      }
      pool = [pinned];
    } else {
      const denied = new Set(policy.deny ?? []);
      pool = [];
      for (const model of this.registry.list()) {
        const reason = hardEliminationReason(model, task, denied, policy);
        if (reason) eliminated.push({ modelId: model.id, reason });
        else pool.push(model);
      }
      if (pool.length === 0) {
        throw new RoutingError("Every enabled model was eliminated by hard constraints", eliminated);
      }

      const floor = QUALITY_FLOOR[task.complexity];
      const passing = pool.filter((model) => taskQuality(model, task.kind) >= floor);
      if (passing.length > 0) {
        for (const model of pool) {
          if (!passing.includes(model)) {
            eliminated.push({
              modelId: model.id,
              reason: `task-fit quality ${taskQuality(model, task.kind).toFixed(2)} below the ${task.complexity} floor ${floor.toFixed(2)}`,
            });
          }
        }
        pool = passing;
      } else {
        floorRelaxed = true;
      }
    }

    const costs = pool.map((model) => estimateCostUsd(model, task));
    const seconds = pool.map((model) => estimateSeconds(model, task));
    const costScores = normalize(costs, true);
    const speedScores = normalize(seconds, true);

    const ranked: ScoredCandidate[] = pool.map((model, i) => {
      const quality = taskQuality(model, task.kind);
      return {
        model,
        quality,
        costScore: costScores[i],
        speedScore: speedScores[i],
        estimatedCostUsd: costs[i],
        estimatedSeconds: seconds[i],
        score: weights.quality * quality + weights.cost * costScores[i] + weights.speed * speedScores[i],
      };
    });

    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        a.estimatedCostUsd - b.estimatedCostUsd ||
        a.model.id.localeCompare(b.model.id),
    );

    const chosen = ranked[0];
    const explanation = buildExplanation(chosen, task, weights, {
      eliminatedCount: eliminated.length,
      floorRelaxed,
      pinned: Boolean(policy.pin),
    });
    return { chosen, ranked, eliminated, weights, task, explanation };
  }
}

/**
 * Escalation helper for the pipeline: attempt 1 gets the winner, attempt 2 the
 * runner-up, and so on; past the end of the ranking it clamps to the last
 * candidate so the pipeline never runs out of models mid-task.
 */
export function candidateForAttempt(decision: RoutingDecision, attempt: number): ScoredCandidate {
  const index = Math.min(Math.max(attempt, 1), decision.ranked.length) - 1;
  return decision.ranked[index];
}

function buildExplanation(
  chosen: ScoredCandidate,
  task: ResolvedTaskSpec,
  weights: RoutingWeights,
  flags: { eliminatedCount: number; floorRelaxed: boolean; pinned: boolean },
): string {
  const parts = [
    `${chosen.model.id} scores ${chosen.score.toFixed(3)} for ${task.complexity} ${task.kind}`,
    `quality ${chosen.quality.toFixed(2)}×${weights.quality.toFixed(2)} + cost ${chosen.costScore.toFixed(2)}×${weights.cost.toFixed(2)} + speed ${chosen.speedScore.toFixed(2)}×${weights.speed.toFixed(2)}`,
    `~$${chosen.estimatedCostUsd.toFixed(4)} · ~${chosen.estimatedSeconds.toFixed(1)}s`,
  ];
  if (flags.pinned) parts.push("pinned by policy");
  if (flags.floorRelaxed) parts.push("quality floor relaxed: no candidate met it");
  if (flags.eliminatedCount > 0) parts.push(`${flags.eliminatedCount} model(s) eliminated`);
  return parts.join(" — ");
}

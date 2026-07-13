import type { Capability, Complexity, RoutingWeights, TaskKind } from "./types";

/**
 * How much each capability contributes to task-fit quality, per task kind.
 * Tunable data, not gospel — M3 feeds measured outcomes back into these.
 */
export const KIND_CAPABILITY_MIX: Record<TaskKind, Partial<Record<Capability, number>>> = {
  planning: { reasoning: 0.7, writing: 0.15, "long-context": 0.15 },
  "code-generation": { code: 0.7, reasoning: 0.25, "tool-use": 0.05 },
  "code-review": { code: 0.5, reasoning: 0.4, "long-context": 0.1 },
  debugging: { code: 0.5, reasoning: 0.4, "tool-use": 0.1 },
  refactoring: { code: 0.6, reasoning: 0.25, "long-context": 0.15 },
  research: { reasoning: 0.5, "tool-use": 0.3, "long-context": 0.2 },
  writing: { writing: 0.7, reasoning: 0.3 },
  summarization: { writing: 0.4, reasoning: 0.2, "long-context": 0.4 },
  extraction: { reasoning: 0.45, "tool-use": 0.25, "long-context": 0.3 },
  "vision-analysis": { vision: 0.7, reasoning: 0.3 },
  conversation: { writing: 0.45, reasoning: 0.45, "tool-use": 0.1 },
};

/**
 * Base scoring weights per complexity. The gradient is the point: trivial work
 * optimizes spend so subscriptions and local models get squeezed; frontier work
 * optimizes quality so the hardest tasks always get the strongest model.
 */
export const COMPLEXITY_WEIGHTS: Record<Complexity, RoutingWeights> = {
  trivial: { quality: 0.15, cost: 0.55, speed: 0.3 },
  standard: { quality: 0.45, cost: 0.35, speed: 0.2 },
  hard: { quality: 0.7, cost: 0.2, speed: 0.1 },
  frontier: { quality: 0.95, cost: 0.03, speed: 0.02 },
};

/**
 * Soft task-fit quality floor per complexity. Candidates below it are dropped —
 * unless nothing passes, in which case the floor relaxes and the decision says so
 * (the router must always return the best available option).
 */
export const QUALITY_FLOOR: Record<Complexity, number> = {
  trivial: 0,
  standard: 0.35,
  hard: 0.55,
  frontier: 0.7,
};

/** Extra weight shifted to speed when the task is interactive (renormalized afterwards). */
export const INTERACTIVE_SPEED_BOOST = 0.15;

/** A required capability below this level counts as missing → hard elimination. */
export const REQUIRED_CAPABILITY_FLOOR = 0.35;

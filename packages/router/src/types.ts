export type Capability =
  | "code"
  | "reasoning"
  | "writing"
  | "vision"
  | "tool-use"
  | "long-context";

export type TaskKind =
  | "planning"
  | "code-generation"
  | "code-review"
  | "debugging"
  | "refactoring"
  | "research"
  | "writing"
  | "summarization"
  | "extraction"
  | "vision-analysis"
  | "conversation";

export type Complexity = "trivial" | "standard" | "hard" | "frontier";

export type LatencyMode = "interactive" | "background";

export interface ModelCost {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface ModelLatency {
  /** Typical time to first token, milliseconds. */
  ttftMs: number;
  /** Typical sustained output throughput. */
  tokensPerSec: number;
}

/**
 * A model is data, not code. Capabilities are 0..1 per dimension; everything
 * here is overridable by the user and, eventually, learned from Apollo's own
 * routing telemetry.
 */
export interface ModelProfile {
  id: string;
  /** Provider-native model name when it differs from the id suffix (e.g. Ollama tags). */
  nativeId?: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: Partial<Record<Capability, number>>;
  cost: ModelCost;
  latency: ModelLatency;
  /** Defaults to true. Disabled models never route. */
  enabled?: boolean;
  notes?: string;
}

export interface TaskSpec {
  kind: TaskKind;
  /** Defaults to "standard". */
  complexity?: Complexity;
  /** Hard requirements — candidates below the capability floor are eliminated. */
  require?: Capability[];
  /** Estimated input size. Defaults to 8,000. */
  contextTokens?: number;
  /** Estimated output size. Defaults to 1,000. */
  expectedOutputTokens?: number;
  /** Defaults to "background". Interactive shifts weight toward speed. */
  latency?: LatencyMode;
}

export interface ResolvedTaskSpec extends TaskSpec {
  complexity: Complexity;
  latency: LatencyMode;
  contextTokens: number;
  expectedOutputTokens: number;
}

export interface RoutingWeights {
  quality: number;
  cost: number;
  speed: number;
}

export interface RoutingPolicy {
  /** Overrides the complexity-derived weights per key; renormalized to sum 1. */
  weights?: Partial<RoutingWeights>;
  /** Candidates whose estimated task cost exceeds this (USD) are eliminated. */
  maxCostPerTask?: number;
  /** Model ids that must not route. */
  deny?: string[];
  /** Force a specific model; skips scoring competition but still reports estimates. */
  pin?: string;
}

export interface Elimination {
  modelId: string;
  reason: string;
}

export interface ScoredCandidate {
  model: ModelProfile;
  /** Weighted total, 0..1. */
  score: number;
  /** Task-fit quality from the capability mix, 0..1. */
  quality: number;
  /** Normalized cost score across candidates (1 = cheapest). */
  costScore: number;
  /** Normalized speed score across candidates (1 = fastest). */
  speedScore: number;
  estimatedCostUsd: number;
  estimatedSeconds: number;
}

/**
 * A decision is only trustworthy if it can explain itself: who won, the full
 * ranking (which doubles as the escalation chain), who was eliminated and why,
 * and the exact weights used.
 */
export interface RoutingDecision {
  chosen: ScoredCandidate;
  ranked: ScoredCandidate[];
  eliminated: Elimination[];
  weights: RoutingWeights;
  task: ResolvedTaskSpec;
  explanation: string;
}

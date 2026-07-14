import type { TaskKind } from "@archic/apollo-router";
import type { Check } from "./checks";

export interface PlanStep {
  id: string;
  description: string;
  expectedOutcome: string;
  /** Ids of steps that must finish first. */
  dependsOn: string[];
  /** How to run this step — routed as its own task kind. Defaults to code-generation. */
  kind?: TaskKind;
  status: "pending" | "active" | "done" | "failed";
  note: string;
}

export interface Plan {
  analysis: string;
  steps: PlanStep[];
  /** Read-only criteria the verifier must confirm before finalizing (prose). */
  doneCriteria: string[];
  /** Machine-checkable criteria the harness verifies itself (no model). */
  checks: Check[];
  /** 0..1, the planner's justified confidence. */
  confidence: number;
  /** Trivial goals skip the multi-step machinery (direct answer + one critic). */
  trivial: boolean;
  /** Blocking clarification required before any safe execution can continue. */
  needsInput?: string;
}

export interface CriticVerdict {
  verdict: "pass" | "fail";
  issues: string[];
  /** 0..1 estimate that the step's claimed success is hallucinated. */
  hallucinationRisk: number;
  forceReplan: boolean;
  feedback: string;
}

export interface VerifyVerdict {
  passed: boolean;
  perCriterion: Array<{ criterion: string; met: boolean; evidence: string }>;
  missing: string[];
  feedback: string;
}

export type CortexStatus = "ok" | "needs_input" | "budget_stop" | "turns_stop" | "loop_stop" | "failed";

export interface CortexResult {
  status: CortexStatus;
  answer: string;
  plan: Plan | null;
  beliefs: Record<string, string>;
  costUsd: number;
  turns: number;
  replans: number;
  depth: "instant" | "agent" | "deep";
}

export interface CortexLimits {
  /** Hard USD budget for the whole task. Default 1.0. */
  budgetUsd: number;
  /** Max LLM calls before an honest turns_stop. Default 40. */
  maxTurns: number;
  /** Replans before an honest stop. Default 5. */
  maxReplans: number;
  /** Deep-lane critic cadence (agent/instant lanes skip it). Default 1. */
  criticEvery: number;
}

export const DEFAULT_LIMITS: CortexLimits = {
  budgetUsd: 1.0,
  maxTurns: 40,
  maxReplans: 5,
  criticEvery: 1,
};

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StampedEvent } from "./events";
import { summarizeRun } from "./summary";

export const MISSION_SCHEMA_VERSION = 1 as const;

export interface Mission {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  id: string;
  goal: string;
  createdAt: string;
  workspace?: string;
  acceptance: MissionAcceptance[];
  constraints: string[];
  metadata?: Record<string, string>;
}

export interface MissionAcceptance {
  id: string;
  description: string;
  kind: "model" | "file_exists" | "file_contains" | "file_equals" | "command_succeeds";
  value?: string;
}

export interface EvidenceItem {
  kind: "execution" | "verification" | "artifact" | "memory" | "decision";
  status: "passed" | "failed" | "observed";
  summary: string;
  at?: number;
  source?: string;
}

export interface MissionEvidence {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  missionId: string;
  generatedAt: string;
  items: EvidenceItem[];
  verificationPassed: boolean;
}

export interface MissionOutcome {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  missionId: string;
  status: "succeeded" | "failed" | "incomplete";
  summary: string;
  attempts: number;
  models: string[];
  costUsd: number;
  durationMs: number;
  remainingRisks: string[];
  evidence: MissionEvidence;
}

export function createMission(input: Omit<Mission, "schemaVersion" | "createdAt"> & { createdAt?: string }): Mission {
  if (!input.id.trim()) throw new Error("mission id is required");
  if (!input.goal.trim()) throw new Error("mission goal is required");
  return {
    ...input,
    schemaVersion: MISSION_SCHEMA_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    acceptance: [...input.acceptance],
    constraints: [...input.constraints],
  };
}

export function outcomeFromEvents(mission: Mission, events: readonly StampedEvent[], answer?: string): MissionOutcome {
  const run = summarizeRun(events);
  const items: EvidenceItem[] = [];
  const remainingRisks: string[] = [];

  for (const event of events) {
    if (event.type === "routing.decided") {
      items.push({ kind: "decision", status: "observed", summary: `${event.modelId}: ${event.reason}`, at: event.at });
    } else if (event.type === "permission.decided") {
      items.push({
        kind: "decision",
        status: event.decision === "allow" ? "observed" : "failed",
        summary: `${event.decision} ${event.tool} (${event.risk}): ${event.reason}`,
        at: event.at,
        source: "execution-policy",
      });
    } else if (event.type === "execution.completed") {
      items.push({ kind: "execution", status: "observed", summary: `attempt ${event.attempt} completed${event.modelId ? ` with ${event.modelId}` : ""}`, at: event.at });
    } else if (event.type === "execution.failed") {
      items.push({ kind: "execution", status: "failed", summary: `attempt ${event.attempt}: ${event.error}`, at: event.at });
    } else if (event.type === "verification.passed") {
      items.push({ kind: "verification", status: "passed", summary: `verification passed on attempt ${event.attempt}`, at: event.at });
    } else if (event.type === "verification.failed") {
      const summary = event.issues.join("; ");
      items.push({ kind: "verification", status: "failed", summary, at: event.at });
      remainingRisks.push(summary);
    } else if (event.type === "belief.recorded" && event.key.startsWith("memory:")) {
      items.push({ kind: "memory", status: "observed", summary: event.value, source: event.key.slice(7), at: event.at });
    }
  }

  const verificationPassed = items.some((item) => item.kind === "verification" && item.status === "passed");
  if (run.status !== "succeeded" && remainingRisks.length === 0) remainingRisks.push("mission did not reach a verified completion");
  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    missionId: mission.id,
    status: run.status,
    summary: answer?.trim() || (run.status === "succeeded"
      ? `Verified completion in ${run.attempts} attempt${run.attempts === 1 ? "" : "s"}.`
      : run.status === "failed" ? `Mission failed after ${run.attempts} attempts.` : "Mission stopped without a terminal outcome."),
    attempts: run.attempts,
    models: run.models,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    remainingRisks: [...new Set(remainingRisks)],
    evidence: { schemaVersion: MISSION_SCHEMA_VERSION, missionId: mission.id, generatedAt: new Date().toISOString(), items, verificationPassed },
  };
}

/** Persist the stable, surface-independent mission contract beside a run. */
export function writeMissionBundle(root: string, mission: Mission, outcome: MissionOutcome): string {
  const dir = join(root, mission.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mission.json"), `${JSON.stringify(mission, null, 2)}\n`);
  writeFileSync(join(dir, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
  writeFileSync(join(dir, "evidence.json"), `${JSON.stringify(outcome.evidence, null, 2)}\n`);
  return dir;
}

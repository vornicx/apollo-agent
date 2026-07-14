import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMission, outcomeFromEvents, writeMissionBundle, type StampedEvent } from "../src/index";

describe("mission contract", () => {
  it("derives a verified outcome and auditable evidence from the event stream", () => {
    const mission = createMission({ id: "m-1", goal: "create a verified file", acceptance: [], constraints: [] });
    const events = [
      { type: "task.started", taskId: "m-1", title: mission.goal, at: 1, seq: 1 },
      { type: "routing.decided", taskId: "m-1", modelId: "local/coder", reason: "best code score", at: 2, seq: 2 },
      { type: "permission.decided", taskId: "m-1", tool: "write_file", risk: "write", decision: "allow", reason: "approved", at: 2, seq: 3 },
      { type: "execution.completed", taskId: "m-1", attempt: 1, modelId: "local/coder", costUsd: 0, at: 3, seq: 4 },
      { type: "verification.passed", taskId: "m-1", attempt: 1, at: 4, seq: 5 },
      { type: "task.completed", taskId: "m-1", attempts: 1, at: 5, seq: 6 },
    ] as StampedEvent[];

    const outcome = outcomeFromEvents(mission, events);

    expect(outcome).toMatchObject({ status: "succeeded", attempts: 1, models: ["local/coder"] });
    expect(outcome.evidence.verificationPassed).toBe(true);
    expect(outcome.evidence.items).toContainEqual(expect.objectContaining({ kind: "decision", status: "observed" }));
    expect(outcome.evidence.items).toContainEqual(expect.objectContaining({ source: "execution-policy", summary: expect.stringContaining("write_file") }));
  });

  it("retains failed verification as a remaining risk", () => {
    const mission = createMission({ id: "m-2", goal: "fix tests", acceptance: [], constraints: [] });
    const events = [
      { type: "task.started", taskId: "m-2", title: mission.goal, at: 1, seq: 1 },
      { type: "verification.failed", taskId: "m-2", attempt: 1, issues: ["tests still fail"], at: 2, seq: 2 },
      { type: "task.failed", taskId: "m-2", attempts: 1, reason: "failed", at: 3, seq: 3 },
    ] as StampedEvent[];
    const outcome = outcomeFromEvents(mission, events);
    expect(outcome.status).toBe("failed");
    expect(outcome.remainingRisks).toEqual(["tests still fail"]);
    expect(outcome.evidence.verificationPassed).toBe(false);
  });

  it("persists the final user-facing answer as the mission summary", () => {
    const mission = createMission({ id: "m-answer", goal: "say hello", acceptance: [], constraints: [] });
    const events = [
      { type: "task.started", taskId: mission.id, title: mission.goal, at: 1, seq: 1 },
      { type: "verification.passed", taskId: mission.id, attempt: 1, at: 2, seq: 2 },
      { type: "task.completed", taskId: mission.id, attempts: 1, at: 3, seq: 3 },
    ] as StampedEvent[];
    expect(outcomeFromEvents(mission, events, "¡Hola! ¿En qué puedo ayudarte?").summary).toBe("¡Hola! ¿En qué puedo ayudarte?");
  });

  it("writes the versioned mission, outcome, and evidence bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "apollo-mission-"));
    try {
      const mission = createMission({ id: "m-3", goal: "inspect", acceptance: [], constraints: [] });
      const outcome = outcomeFromEvents(mission, []);
      const dir = writeMissionBundle(root, mission, outcome);
      expect(JSON.parse(readFileSync(join(dir, "mission.json"), "utf8"))).toMatchObject({ schemaVersion: 1, id: "m-3" });
      expect(JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"))).toMatchObject({ missionId: "m-3" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

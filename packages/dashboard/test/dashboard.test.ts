import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, JsonlEventSink } from "@archic/apollo-core";
import { DEFAULT_MODELS } from "@archic/apollo-router";
import { MissionController, renderHtml, resolveApiRoute, startDashboard, type DashboardContext } from "../src/index";

function seedRuns(): string {
  const dir = mkdtempSync(join(tmpdir(), "apollo-dash-"));
  const bus = new EventBus();
  new JsonlEventSink(join(dir, "run-ok.jsonl")).attach(bus);
  bus.emit({ type: "task.started", taskId: "a", title: "generate a function" });
  bus.emit({ type: "execution.completed", taskId: "a", attempt: 1, modelId: "openai/gpt-5.1", costUsd: 0.02 });
  bus.emit({ type: "task.completed", taskId: "a", attempts: 1 });
  return dir;
}

const ctx = (dir: string): DashboardContext => ({ runsDir: dir, models: DEFAULT_MODELS });

describe("resolveApiRoute", () => {
  it("serves the model fleet", () => {
    const res = resolveApiRoute("/api/models", ctx(seedRuns()));
    expect(res?.status).toBe(200);
    expect((res?.body as { models: unknown[] }).models.length).toBe(DEFAULT_MODELS.length);
  });

  it("lists recorded runs with summaries", () => {
    const res = resolveApiRoute("/api/runs", ctx(seedRuns()));
    const runs = (res?.body as { runs: Array<{ id: string; status: string; costUsd: number }> }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: "run-ok", status: "succeeded", costUsd: 0.02 });
  });

  it("aggregates stats", () => {
    const res = resolveApiRoute("/api/stats", ctx(seedRuns()));
    expect(res?.body).toMatchObject({ runs: 1, succeeded: 1, failed: 0, successRate: 1 });
  });

  it("returns a single run with its events", () => {
    const res = resolveApiRoute("/api/runs/run-ok", ctx(seedRuns()));
    const body = res?.body as { events: unknown[]; summary: { status: string } };
    expect(res?.status).toBe(200);
    expect(body.events).toHaveLength(3);
    expect(body.summary.status).toBe("succeeded");
  });

  it("attaches the versioned mission outcome and evidence to a run", () => {
    const runsDir = seedRuns();
    const missionsDir = mkdtempSync(join(tmpdir(), "apollo-missions-"));
    const dir = join(missionsDir, "run-ok");
    mkdirSync(dir);
    writeFileSync(join(dir, "mission.json"), JSON.stringify({ schemaVersion: 1, id: "run-ok", goal: "generate" }));
    writeFileSync(join(dir, "outcome.json"), JSON.stringify({ schemaVersion: 1, missionId: "run-ok", status: "succeeded", remainingRisks: [] }));
    writeFileSync(join(dir, "evidence.json"), JSON.stringify({ schemaVersion: 1, missionId: "run-ok", verificationPassed: true, items: [] }));
    const res = resolveApiRoute("/api/runs/run-ok", { runsDir, missionsDir, models: DEFAULT_MODELS });
    expect(res?.body).toMatchObject({ mission: { outcome: { status: "succeeded" }, evidence: { verificationPassed: true } } });
  });

  it("rejects traversal ids and missing runs", () => {
    const c = ctx(seedRuns());
    expect(resolveApiRoute("/api/runs/..%2f..%2fetc", c)?.status).toBe(400);
    expect(resolveApiRoute("/api/runs/nope", c)?.status).toBe(404);
  });

  it("returns null for non-API paths", () => {
    expect(resolveApiRoute("/", ctx(seedRuns()))).toBeNull();
  });
});

describe("renderHtml", () => {
  it("produces a self-contained document", () => {
    const html = renderHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("APOLLO");
    expect(html).toContain("/api/stream");
  });

  it("includes search input and diff panel hooks", () => {
    const html = renderHtml();
    // search input
    expect(html).toContain('id="runsearch"');
    expect(html).toContain("filterRuns");
    expect(html).toContain("renderRunsTable");
    // diff panel
    expect(html).toContain('id="diffpanel"');
    expect(html).toContain("openDiff");
    expect(html).toContain("toggleDiffSelect");
    expect(html).toContain("clearDiff");
    expect(html).toContain("diffIds");
    // gold accent for changed values
    expect(html).toContain("diff-changed");
    expect(html).toContain("missionEvidence");
  });

  it("ships syntactically valid mission-center client JavaScript", () => {
    const html = renderHtml();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(html).toContain('id="mission-form"');
    expect(html).toContain("/api/missions");
  });
});

describe("startDashboard", () => {
  it("binds a port and serves the SPA and API over HTTP", async () => {
    const dash = await startDashboard({ runsDir: seedRuns(), models: DEFAULT_MODELS, port: 0 });
    try {
      const html = await fetch(`${dash.url}/`).then((r) => r.text());
      expect(html).toContain("APOLLO");
      const runs = (await fetch(`${dash.url}/api/runs`).then((r) => r.json())) as { runs: unknown[] };
      expect(runs.runs).toHaveLength(1);
    } finally {
      await dash.close();
    }
  });

  it("launches and reports a controlled mission through the loopback API", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apollo-control-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "apollo-control-workspace-"));
    const dash = await startDashboard({
      runsDir: join(stateDir, "runs"),
      missionsDir: join(stateDir, "missions"),
      models: DEFAULT_MODELS,
      port: 0,
      version: "test",
      runtime: { command: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),25)"], stateDir },
    });
    try {
      const launched = await fetch(`${dash.url}/api/missions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "verify me", workspace }),
      }).then((response) => response.json()) as { mission: { id: string; status: string } };
      expect(launched.mission.id).toMatch(/^mission-/);
      expect(launched.mission.status).toBe("running");
      await new Promise((resolve) => setTimeout(resolve, 75));
      const control = await fetch(`${dash.url}/api/control`).then((response) => response.json()) as { missions: Array<{ id: string; status: string }> };
      expect(control.missions.find((mission) => mission.id === launched.mission.id)?.status).toBe("succeeded");
      const retried = await fetch(`${dash.url}/api/missions/${launched.mission.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clarification: "use the documented behavior" }),
      }).then((response) => response.json()) as { mission: { parentId: string; goal: string } };
      expect(retried.mission).toMatchObject({ parentId: launched.mission.id });
      expect(retried.mission.goal).toContain("Human clarification");
      const health = await fetch(`${dash.url}/api/health`).then((response) => response.json()) as { runtime: string; missionControl: boolean };
      expect(health).toMatchObject({ runtime: "embedded", missionControl: true });
    } finally {
      await dash.close();
    }
  });

  it("rejects cross-origin mission mutations", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apollo-control-origin-"));
    const dash = await startDashboard({
      runsDir: join(stateDir, "runs"),
      models: DEFAULT_MODELS,
      port: 0,
      runtime: { command: process.execPath, args: ["-e", "process.exit(0)"], stateDir },
    });
    try {
      const response = await fetch(`${dash.url}/api/missions`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ goal: "no", workspace: stateDir }),
      });
      expect(response.status).toBe(403);
    } finally {
      await dash.close();
    }
  });

  it("cancels a running mission", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apollo-control-cancel-"));
    const workspace = mkdtempSync(join(tmpdir(), "apollo-control-cancel-workspace-"));
    const dash = await startDashboard({
      runsDir: join(stateDir, "runs"),
      models: DEFAULT_MODELS,
      port: 0,
      runtime: { command: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),5000)"], stateDir },
    });
    try {
      const launched = await fetch(`${dash.url}/api/missions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "long mission", workspace }),
      }).then((response) => response.json()) as { mission: { id: string } };
      const canceled = await fetch(`${dash.url}/api/missions/${launched.mission.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then((response) => response.json()) as { mission: { status: string } };
      expect(canceled.mission.status).toBe("canceled");
    } finally {
      await dash.close();
    }
  });
});

describe("MissionController", () => {
  it("surfaces a runtime needs_input stop distinctly", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apollo-needs-input-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "apollo-needs-input-workspace-"));
    const script = [
      "const fs=require('node:fs'),p=require('node:path')",
      "const i=process.argv.indexOf('--task-id'),id=process.argv[i+1]",
      "const d=p.join(process.env.APOLLO_STATE_DIR,'runs');fs.mkdirSync(d,{recursive:true})",
      "fs.writeFileSync(p.join(d,id+'.jsonl'),JSON.stringify({type:'meta.stop',taskId:id,status:'needs_input',reason:'clarify',at:1,seq:1})+'\\n')",
      "process.exit(2)",
    ].join(";");
    const controller = new MissionController({ command: process.execPath, args: ["-e", script], stateDir });
    try {
      const mission = controller.launch({ goal: "ambiguous", workspace });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(controller.get(mission.id)?.status).toBe("needs_input");
    } finally {
      controller.close();
    }
  });
});

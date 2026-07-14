import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@archic/apollo-core";
import { ProviderHub, type CompletionResult, type ProviderAdapter } from "@archic/apollo-providers";
import { ModelRegistry, type ModelProfile } from "@archic/apollo-router";
import { ToolRegistry } from "@archic/apollo-agent";
import { runCortex } from "../src/index";

function model(costPerMTok = 0): ModelProfile {
  return {
    id: "test/brain",
    provider: "test",
    displayName: "Brain",
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    capabilities: { reasoning: 0.9, code: 0.9, writing: 0.9, "tool-use": 0.9, "long-context": 0.8, vision: 0.5 },
    cost: { inputPerMTok: costPerMTok, outputPerMTok: costPerMTok },
    latency: { ttftMs: 100, tokensPerSec: 100 },
  };
}

function registryWith(m: ModelProfile): ModelRegistry {
  return new ModelRegistry().register(m);
}

/** Scripted adapter dispatching by cognitive phase (responseFormat name / tools present). */
function scriptedHub(handlers: {
  plan: unknown;
  verdict?: unknown;
  verification?: unknown;
  executorText?: string;
  synthesis?: string;
  cost?: number;
}): ProviderHub {
  const adapter: ProviderAdapter = {
    provider: "test",
    supportsTools: true,
    supportsResponseFormat: true,
    async complete(request): Promise<CompletionResult> {
      const usage = { inputTokens: 100, outputTokens: 100 };
      const name = request.responseFormat?.name;
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      if (name === "plan") return { text: JSON.stringify(handlers.plan), usage };
      if (name === "verdict") return { text: JSON.stringify(handlers.verdict ?? { verdict: "pass", issues: [], hallucinationRisk: 0, forceReplan: false, feedback: "" }), usage };
      if (name === "verification") return { text: JSON.stringify(handlers.verification ?? { passed: true, perCriterion: [], missing: [], feedback: "ok" }), usage };
      if (system.includes("EXECUTOR")) return { text: handlers.executorText ?? "STEP_DONE[s1]: created the file", usage };
      return { text: handlers.synthesis ?? "All done — the file exists.", usage };
    },
  };
  return new ProviderHub().register(adapter);
}

describe("runCortex", () => {
  it("runs plan → act → critic → verify → finalize and emits the cognitive stream", async () => {
    const bus = new EventBus();
    const hub = scriptedHub({
      plan: {
        analysis: "make a file",
        trivial: false,
        confidence: 0.8,
        doneCriteria: ["sum.js exists"],
        steps: [{ id: "s1", description: "create sum.js", expectedOutcome: "file exists", dependsOn: [], kind: "code-generation" }],
      },
      executorText: "INTENT: create it\nBELIEF[file]: sum.js\nSTEP_DONE[s1]: created sum.js",
      synthesis: "Created sum.js.",
    });

    const result = await runCortex({
      hub,
      registry: registryWith(model()),
      goal: "create a sum.js file",
      tools: new ToolRegistry(),
      bus,
    });

    expect(result.status).toBe("ok");
    expect(result.answer).toBe("Created sum.js.");
    expect(result.beliefs.file).toBe("sum.js");
    const types = bus.history().map((e) => e.type);
    expect(types).toContain("plan.produced");
    expect(types).toContain("step.started");
    expect(types).toContain("step.finished");
    expect(types).toContain("critic.reviewed");
    expect(types).toContain("verification.passed");
    expect(types).toContain("task.completed");
  });

  it("takes the trivial fast path when the planner says so", async () => {
    const bus = new EventBus();
    const hub = scriptedHub({
      plan: { analysis: "trivial", trivial: true, confidence: 0.95, doneCriteria: [], steps: [] },
      synthesis: "42 is the answer.",
    });
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "what is 6 times 7?", tools: new ToolRegistry(), bus });
    expect(result.status).toBe("ok");
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0].id).toBe("s0");
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "verification.passed" }));
  });

  it("replans when verification fails, then finalizes", async () => {
    let verifyCalls = 0;
    const adapter: ProviderAdapter = {
      provider: "test",
      supportsTools: true,
      supportsResponseFormat: true,
      async complete(request) {
        const usage = { inputTokens: 50, outputTokens: 50 };
        const name = request.responseFormat?.name;
        if (name === "plan") {
          return { text: JSON.stringify({ analysis: "x", trivial: false, confidence: 0.7, doneCriteria: ["done"], steps: [{ id: "s1", description: "do", expectedOutcome: "done", dependsOn: [] }] }), usage };
        }
        if (name === "verdict") return { text: JSON.stringify({ verdict: "pass", issues: [], hallucinationRisk: 0, forceReplan: false, feedback: "" }), usage };
        if (name === "verification") {
          verifyCalls += 1;
          return { text: JSON.stringify({ passed: verifyCalls >= 2, perCriterion: [], missing: verifyCalls < 2 ? ["done"] : [], feedback: verifyCalls < 2 ? "not there yet" : "ok" }), usage };
        }
        const system = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("EXECUTOR")) return { text: "STEP_DONE[s1]: did it", usage };
        return { text: "Finished.", usage };
      },
    };
    const hub = new ProviderHub().register(adapter);
    const bus = new EventBus();
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "do the thing", tools: new ToolRegistry(), bus });

    expect(result.status).toBe("ok");
    expect(verifyCalls).toBe(2);
    expect(result.replans).toBeGreaterThanOrEqual(1);
    expect(bus.history().some((e) => e.type === "verification.failed")).toBe(true);
  });

  it("stops honestly when the budget is exhausted", async () => {
    const bus = new EventBus();
    const hub = scriptedHub({
      plan: { analysis: "x", trivial: false, confidence: 0.5, doneCriteria: ["c"], steps: [{ id: "s1", description: "d", expectedOutcome: "o", dependsOn: [] }] },
      cost: 1,
    });
    // model priced so one planning turn already blows a tiny budget
    const result = await runCortex({
      hub,
      registry: registryWith(model(100)),
      goal: "expensive goal",
      tools: new ToolRegistry(),
      limits: { budgetUsd: 0.0001 },
      bus,
    });
    expect(result.status).toBe("budget_stop");
    expect(bus.history().some((e) => e.type === "meta.stop")).toBe(true);
  });

  it("never treats a plain completed response as proof that a step finished", async () => {
    const bus = new EventBus();
    const hub = scriptedHub({
      plan: { analysis: "x", trivial: false, confidence: 0.5, doneCriteria: ["done"], steps: [{ id: "s1", description: "do work", expectedOutcome: "done", dependsOn: [] }] },
      executorText: "I think that should be complete now.",
      synthesis: "Stopped because completion was not proven.",
    });
    const result = await runCortex({
      hub,
      registry: registryWith(model()),
      goal: "do work",
      tools: new ToolRegistry(),
      limits: { maxReplans: 1, maxTurns: 12 },
      bus,
    });
    expect(result.status).not.toBe("ok");
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "step.finished", status: "failed" }));
    expect(bus.history().some((event) => event.type === "verification.passed")).toBe(false);
  });

  it("normalizes planner-invented task kinds instead of crashing the router", async () => {
    const hub = scriptedHub({
      plan: { analysis: "x", trivial: false, confidence: 0.8, doneCriteria: ["done"], checks: [], steps: [{ id: "s1", description: "run tests", expectedOutcome: "done", dependsOn: [], kind: "testing" }] },
      executorText: "STEP_DONE[s1]: verified",
      synthesis: "Done.",
    });
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "test it", tools: new ToolRegistry() });
    expect(result.status).toBe("ok");
    expect(result.plan?.steps[0].kind).toBe("code-generation");
  });

  it("stops with needs_input when the executor asks the human a blocking question", async () => {
    const hub = scriptedHub({
      plan: { analysis: "ambiguous", trivial: false, confidence: 0.4, doneCriteria: ["chosen"], checks: [], steps: [{ id: "s1", description: "choose target", expectedOutcome: "target chosen", dependsOn: [] }] },
      executorText: "QUESTION: Which files should be deleted?",
      synthesis: "Input is required.",
    });
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "delete old files", tools: new ToolRegistry() });
    expect(result.status).toBe("needs_input");
    expect(result.answer).toContain("Input is required");
  });

  it("finishes as soon as user-enforced ground truth passes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-ground-truth-"));
    writeFileSync(join(workspace, "done.txt"), "done");
    const hub = scriptedHub({
      plan: { analysis: "x", trivial: false, confidence: 0.8, doneCriteria: ["many speculative criteria"], checks: [], steps: [{ id: "s1", description: "inspect", expectedOutcome: "inspected", dependsOn: [] }, { id: "s2", description: "unnecessary", expectedOutcome: "extra", dependsOn: ["s1"] }] },
      executorText: "STEP_DONE[s1]: inspected",
      verification: { passed: false, perCriterion: [], missing: ["speculative"], feedback: "reject" },
      synthesis: "Ground truth passed.",
    });
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "finish", workspace, tools: new ToolRegistry(), extraChecks: [{ type: "file_equals", path: "done.txt", text: "done" }] });
    expect(result.status).toBe("ok");
    expect(result.answer).toBe("Ground truth passed.");
    expect(result.plan?.steps[1].status).toBe("pending");
  });

  it("honors a planner-level blocking clarification before executing tools", async () => {
    const bus = new EventBus();
    const hub = scriptedHub({
      plan: { analysis: "unsafe ambiguity", trivial: false, confidence: 0.2, needsInput: "Which files count as old?", doneCriteria: [], checks: [], steps: [] },
      synthesis: "Please define which files count as old.",
    });
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "delete old files", tools: new ToolRegistry(), bus });
    expect(result.status).toBe("needs_input");
    expect(bus.history().some((event) => event.type === "step.started")).toBe(false);
  });
});

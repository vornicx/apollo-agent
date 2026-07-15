import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@archic/apollo-core";
import { ProviderHub, type CompletionResult, type ProviderAdapter } from "@archic/apollo-providers";
import { ModelRegistry, type ModelProfile } from "@archic/apollo-router";
import { ToolRegistry, workspaceTools } from "@archic/apollo-agent";
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
      depth: "deep",
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
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "hola", tools: new ToolRegistry(), bus });
    expect(result.status).toBe("ok");
    expect(result.depth).toBe("instant");
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0].id).toBe("instant");
    expect(bus.history().some((event) => event.type === "routing.decided")).toBe(false);
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "execution.completed", modelId: "apollo/local-instant" }));
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "verification.passed" }));
    expect(bus.history().some((event) => event.type === "critic.reviewed")).toBe(false);
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
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "do the thing", tools: new ToolRegistry(), bus, depth: "deep" });

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
      depth: "deep",
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
      depth: "deep",
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
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "test it", tools: new ToolRegistry(), depth: "deep" });
    expect(result.status).toBe("ok");
    expect(result.plan?.steps[0].kind).toBe("code-generation");
  });

  it("stops with needs_input when the executor asks the human a blocking question", async () => {
    const hub = scriptedHub({
      plan: { analysis: "ambiguous", trivial: false, confidence: 0.4, doneCriteria: ["chosen"], checks: [], steps: [{ id: "s1", description: "choose target", expectedOutcome: "target chosen", dependsOn: [] }] },
      executorText: "QUESTION: Which files should be deleted?",
      synthesis: "Input is required.",
    });
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "delete old files", tools: new ToolRegistry(), depth: "deep" });
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
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "finish", workspace, tools: new ToolRegistry(), extraChecks: [{ type: "file_equals", path: "done.txt", text: "done" }], depth: "deep" });
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
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "delete old files", tools: new ToolRegistry(), bus, depth: "deep" });
    expect(result.status).toBe("needs_input");
    expect(bus.history().some((event) => event.type === "step.started")).toBe(false);
  });

  it("uses one agent execution for ordinary auto-depth work", async () => {
    const bus = new EventBus();
    const hub = scriptedHub({
      plan: { analysis: "unused", trivial: false, confidence: 1, doneCriteria: [], steps: [] },
      synthesis: "A concise answer.",
    });
    const result = await runCortex({ hub, registry: registryWith(model()), goal: "Explain this concept briefly", tools: new ToolRegistry(), bus });
    expect(result.status).toBe("ok");
    expect(result.depth).toBe("agent");
    expect(result.turns).toBe(1);
    expect(bus.history().filter((event) => event.type === "execution.started")).toHaveLength(1);
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "execution.completed", modelCalls: 1 }));
    expect(bus.history().some((event) => event.type === "critic.reviewed")).toBe(false);
  });

  it("repairs and verifies a workspace in one model call when context is sufficient", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-one-shot-"));
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    writeFileSync(join(workspace, "add.js"), "export const add=(a,b)=>a-b;\n");
    writeFileSync(join(workspace, "add.test.js"), "import test from 'node:test';import assert from 'node:assert/strict';import {add} from './add.js';test('add',()=>assert.equal(add(2,3),5));\n");
    let calls = 0;
    const adapter: ProviderAdapter = {
      provider: "test",
      supportsTools: true,
      supportsResponseFormat: true,
      async complete() {
        calls += 1;
        return {
          text: "Fixed the implementation.\n```file:add.js\nexport const add=(a,b)=>a+b;\n```",
          usage: { inputTokens: 500, outputTokens: 40 },
        };
      },
    };
    const bus = new EventBus();
    const result = await runCortex({
      hub: new ProviderHub().register(adapter),
      registry: registryWith(model()),
      goal: "Fix add.js so node --test passes",
      workspace,
      tools: workspaceTools(workspace),
      extraChecks: [{ type: "command_succeeds", command: "node --test" }],
      confirm: () => true,
      bus,
    });
    expect(result.status).toBe("ok");
    expect(result.turns).toBe(1);
    expect(calls).toBe(1);
    expect(readFileSync(join(workspace, "add.js"), "utf8")).toContain("a+b");
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "harness.context_prepared" }));
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "one_shot.completed", written: ["add.js"] }));
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "execution.completed", modelCalls: 1 }));
  });

  it("falls back to the tool loop without restarting when one-shot context is insufficient", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "apollo-one-shot-fallback-"));
    let calls = 0;
    const adapter: ProviderAdapter = {
      provider: "test",
      supportsTools: true,
      supportsResponseFormat: true,
      async complete() {
        calls += 1;
        const usage = { inputTokens: 100, outputTokens: 20 };
        if (calls === 1) return { text: "NEEDS_AGENT: inspect the workspace with tools", usage };
        if (calls === 2) {
          return {
            text: "",
            toolCalls: [{ id: "write-result", name: "write_file", arguments: { path: "result.txt", content: "ready\n" } }],
            usage,
          };
        }
        return { text: "Created and inspected result.txt.", usage };
      },
    };
    const bus = new EventBus();
    const result = await runCortex({
      hub: new ProviderHub().register(adapter),
      registry: registryWith(model()),
      goal: "Create result.txt",
      workspace,
      tools: workspaceTools(workspace),
      confirm: () => true,
      bus,
    });

    expect(result.status).toBe("ok");
    expect(calls).toBe(3);
    expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("ready\n");
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "one_shot.fallback", reason: expect.stringContaining("inspect") }));
    expect(bus.history()).toContainEqual(expect.objectContaining({ type: "verification.passed" }));
  });
});

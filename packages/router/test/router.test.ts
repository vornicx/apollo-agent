import { describe, expect, it } from "vitest";
import {
  candidateForAttempt,
  ModelRegistry,
  Router,
  RoutingError,
  type ModelProfile,
} from "../src/index";

const cheap: ModelProfile = {
  id: "test/cheap",
  provider: "test",
  displayName: "Cheap",
  contextWindow: 32_000,
  maxOutputTokens: 8_000,
  capabilities: { code: 0.55, reasoning: 0.5, writing: 0.6, "tool-use": 0.5 },
  cost: { inputPerMTok: 0.5, outputPerMTok: 2 },
  latency: { ttftMs: 300, tokensPerSec: 120 },
};

const balanced: ModelProfile = {
  id: "test/balanced",
  provider: "test",
  displayName: "Balanced",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  capabilities: { code: 0.8, reasoning: 0.78, writing: 0.8, "tool-use": 0.8, vision: 0.7 },
  cost: { inputPerMTok: 3, outputPerMTok: 15 },
  latency: { ttftMs: 600, tokensPerSec: 70 },
};

const premium: ModelProfile = {
  id: "test/premium",
  provider: "test",
  displayName: "Premium",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: { code: 0.97, reasoning: 0.98, writing: 0.95, "tool-use": 0.95, vision: 0.9, "long-context": 0.95 },
  cost: { inputPerMTok: 12, outputPerMTok: 60 },
  latency: { ttftMs: 1200, tokensPerSec: 40 },
};

function makeRouter(models: ModelProfile[] = [cheap, balanced, premium]): Router {
  const registry = new ModelRegistry();
  for (const model of models) registry.register(model);
  return new Router(registry);
}

describe("Router", () => {
  it("routes trivial work to the cheap model", () => {
    const decision = makeRouter().route({ kind: "code-generation", complexity: "trivial" });
    expect(decision.chosen.model.id).toBe("test/cheap");
  });

  it("routes frontier work to the premium model and records the floor elimination", () => {
    const decision = makeRouter().route({ kind: "code-generation", complexity: "frontier" });
    expect(decision.chosen.model.id).toBe("test/premium");
    expect(decision.eliminated.some((e) => e.modelId === "test/cheap" && e.reason.includes("floor"))).toBe(true);
  });

  it("eliminates models missing a required capability, with the reason", () => {
    const decision = makeRouter().route({ kind: "vision-analysis", require: ["vision"] });
    expect(decision.eliminated.some((e) => e.modelId === "test/cheap" && e.reason.includes("vision"))).toBe(true);
    expect(decision.ranked.every((c) => c.model.id !== "test/cheap")).toBe(true);
  });

  it("eliminates models whose context window is too small", () => {
    const decision = makeRouter().route({ kind: "summarization", contextTokens: 500_000 });
    expect(decision.chosen.model.id).toBe("test/premium");
    expect(decision.eliminated.map((e) => e.modelId).sort()).toEqual(["test/balanced", "test/cheap"]);
  });

  it("respects deny lists", () => {
    const decision = makeRouter().route(
      { kind: "code-generation", complexity: "frontier" },
      { deny: ["test/premium"] },
    );
    expect(decision.chosen.model.id).toBe("test/balanced");
    expect(decision.eliminated.some((e) => e.modelId === "test/premium" && e.reason.includes("denied"))).toBe(true);
  });

  it("respects a per-task budget", () => {
    const decision = makeRouter().route({ kind: "code-generation" }, { maxCostPerTask: 0.01 });
    expect(decision.chosen.model.id).toBe("test/cheap");
    expect(decision.eliminated.filter((e) => e.reason.includes("budget"))).toHaveLength(2);
  });

  it("pin forces a model and says so in the explanation", () => {
    const decision = makeRouter().route(
      { kind: "code-generation", complexity: "frontier" },
      { pin: "test/cheap" },
    );
    expect(decision.chosen.model.id).toBe("test/cheap");
    expect(decision.explanation).toContain("pinned");
  });

  it("relaxes the quality floor instead of failing when nothing passes it", () => {
    const decision = makeRouter([cheap]).route({ kind: "code-generation", complexity: "frontier" });
    expect(decision.chosen.model.id).toBe("test/cheap");
    expect(decision.explanation).toContain("floor relaxed");
  });

  it("shifts weight toward speed for interactive tasks", () => {
    const router = makeRouter();
    const background = router.route({ kind: "conversation", latency: "background" });
    const interactive = router.route({ kind: "conversation", latency: "interactive" });
    expect(interactive.weights.speed).toBeGreaterThan(background.weights.speed);
  });

  it("throws a RoutingError carrying the eliminations when everything is eliminated", () => {
    expect(() => makeRouter([cheap]).route({ kind: "planning", contextTokens: 100_000 })).toThrowError(
      RoutingError,
    );
    try {
      makeRouter([cheap]).route({ kind: "planning", contextTokens: 100_000 });
    } catch (error) {
      expect((error as RoutingError).eliminated).toHaveLength(1);
    }
  });

  it("never routes to disabled models", () => {
    const decision = makeRouter([{ ...premium, enabled: false }, balanced]).route({
      kind: "code-generation",
      complexity: "frontier",
    });
    expect(decision.chosen.model.id).toBe("test/balanced");
  });

  it("candidateForAttempt walks the ranking and clamps at the end", () => {
    const decision = makeRouter().route({ kind: "code-generation", complexity: "standard" });
    expect(candidateForAttempt(decision, 1)).toBe(decision.ranked[0]);
    expect(candidateForAttempt(decision, 2)).toBe(decision.ranked[1]);
    expect(candidateForAttempt(decision, 99)).toBe(decision.ranked[decision.ranked.length - 1]);
  });

  it("is deterministic for identical inputs", () => {
    const router = makeRouter();
    const a = router.route({ kind: "debugging", complexity: "hard" });
    const b = router.route({ kind: "debugging", complexity: "hard" });
    expect(a.ranked.map((c) => c.model.id)).toEqual(b.ranked.map((c) => c.model.id));
    expect(a.chosen.score).toBe(b.chosen.score);
  });
});

describe("ModelRegistry", () => {
  it("ships defaults and allows overrides", () => {
    const registry = ModelRegistry.withDefaults();
    expect(registry.list().length).toBeGreaterThanOrEqual(6);
    registry.update("anthropic/claude-haiku-4-5", { enabled: false });
    expect(registry.list().some((m) => m.id === "anthropic/claude-haiku-4-5")).toBe(false);
    expect(registry.list({ enabledOnly: false }).some((m) => m.id === "anthropic/claude-haiku-4-5")).toBe(true);
  });
});

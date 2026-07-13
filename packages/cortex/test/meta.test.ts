import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, MetaController } from "../src/index";

describe("MetaController loop detection", () => {
  it("detects three identical actions in a row", () => {
    const m = new MetaController(DEFAULT_LIMITS);
    m.recordAction("read_file", { path: "a.txt" });
    m.recordAction("read_file", { path: "a.txt" });
    expect(m.loopDetected()).toBe(false);
    m.recordAction("read_file", { path: "a.txt" });
    expect(m.loopDetected()).toBe(true);
  });

  it("detects an A-B-A-B oscillation", () => {
    const m = new MetaController(DEFAULT_LIMITS);
    m.recordAction("a", {});
    m.recordAction("b", {});
    m.recordAction("a", {});
    m.recordAction("b", {});
    expect(m.loopDetected()).toBe(true);
  });

  it("treats different arguments as different actions", () => {
    const m = new MetaController(DEFAULT_LIMITS);
    m.recordAction("read_file", { path: "a" });
    m.recordAction("read_file", { path: "b" });
    m.recordAction("read_file", { path: "c" });
    expect(m.loopDetected()).toBe(false);
  });

  it("accepts tool calls with undefined argument values without crashing", () => {
    const m = new MetaController(DEFAULT_LIMITS);
    expect(() => m.recordAction("run_command", { command: undefined })).not.toThrow();
    expect(m.loopDetected()).toBe(false);
  });

  it("first loop replans, second stops, and resets its window", () => {
    const m = new MetaController(DEFAULT_LIMITS);
    m.recordAction("x", {});
    m.recordAction("x", {});
    m.recordAction("x", {});
    expect(m.loopDetected()).toBe(true);
    expect(m.onLoop()).toBe("replan");
    expect(m.loopDetected()).toBe(false); // window cleared
    m.recordAction("y", {});
    m.recordAction("y", {});
    m.recordAction("y", {});
    expect(m.onLoop()).toBe("stop");
  });
});

describe("MetaController budget and turns", () => {
  it("guards budget and warns once at 80%", () => {
    const m = new MetaController({ ...DEFAULT_LIMITS, budgetUsd: 1 });
    m.recordTurn(0.8);
    expect(m.shouldWarnBudget()).toBe(true);
    expect(m.shouldWarnBudget()).toBe(false); // only once
    expect(m.budgetExceeded()).toBe(false);
    m.recordTurn(0.3);
    expect(m.budgetExceeded()).toBe(true);
  });

  it("guards turns", () => {
    const m = new MetaController({ ...DEFAULT_LIMITS, maxTurns: 2 });
    m.recordTurn(0);
    expect(m.turnsExceeded()).toBe(false);
    m.recordTurn(0);
    expect(m.turnsExceeded()).toBe(true);
  });
});

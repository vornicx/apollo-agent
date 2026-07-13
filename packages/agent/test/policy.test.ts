import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_POLICY, classifyToolCall, decideToolCall } from "../src/index";

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "1", name, arguments: args });

describe("execution policy", () => {
  it("classifies writes, normal shell, and critical shell separately", () => {
    expect(classifyToolCall(call("write_file"))).toBe("write");
    expect(classifyToolCall(call("run_command", { command: "npm test" }))).toBe("shell");
    expect(classifyToolCall(call("run_command", { command: "git reset --hard" }))).toBe("critical");
  });

  it("lets explicit mission approval satisfy ask but not deny", () => {
    expect(decideToolCall(DEFAULT_EXECUTION_POLICY, call("write_file"), true).allowed).toBe(true);
    expect(decideToolCall(DEFAULT_EXECUTION_POLICY, call("run_command", { command: "git reset --hard" }), true).allowed).toBe(false);
  });
});

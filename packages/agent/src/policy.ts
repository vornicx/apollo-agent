import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolCall } from "@archic/apollo-providers";

export type ToolRisk = "read" | "write" | "shell" | "critical";
export type PolicyAction = "allow" | "ask" | "deny";

export interface ExecutionPolicy {
  schemaVersion: 1;
  write: PolicyAction;
  shell: PolicyAction;
  critical: PolicyAction;
}

export interface PolicyDecision {
  allowed: boolean;
  action: PolicyAction;
  risk: ToolRisk;
  reason: string;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  schemaVersion: 1,
  write: "ask",
  shell: "ask",
  critical: "deny",
};

const CRITICAL_COMMAND = /(^|[;&|]\s*)(sudo\b|rm\s+-[^\n]*r|git\s+(reset\s+--hard|clean\s+-)|(?:npm|cargo)\s+publish\b|(?:vercel|wrangler)\s+deploy\b|curl\b[^\n]*\|\s*(?:sh|bash)\b)/i;

export function classifyToolCall(call: ToolCall, declaredRisk?: ToolRisk): ToolRisk {
  if (call.name === "run_command") {
    return CRITICAL_COMMAND.test(String(call.arguments.command ?? "")) ? "critical" : "shell";
  }
  if (call.name === "write_file" || call.name === "edit_file") return "write";
  return declaredRisk ?? "read";
}

export function loadExecutionPolicy(workspace: string): ExecutionPolicy {
  const path = join(resolve(workspace), ".apollo", "policy.json");
  if (!existsSync(path)) return { ...DEFAULT_EXECUTION_POLICY };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExecutionPolicy>;
  const action = (value: unknown, fallback: PolicyAction): PolicyAction =>
    value === "allow" || value === "ask" || value === "deny" ? value : fallback;
  return {
    schemaVersion: 1,
    write: action(parsed.write, DEFAULT_EXECUTION_POLICY.write),
    shell: action(parsed.shell, DEFAULT_EXECUTION_POLICY.shell),
    critical: action(parsed.critical, DEFAULT_EXECUTION_POLICY.critical),
  };
}

export function decideToolCall(policy: ExecutionPolicy, call: ToolCall, approveAsked = false, declaredRisk?: ToolRisk): PolicyDecision {
  const risk = classifyToolCall(call, declaredRisk);
  if (risk === "read") return { allowed: true, action: "allow", risk, reason: "read-only tool" };
  const action = policy[risk];
  if (action === "allow") return { allowed: true, action, risk, reason: `workspace policy allows ${risk}` };
  if (action === "ask" && approveAsked) return { allowed: true, action, risk, reason: `approved by the user for this mission` };
  return {
    allowed: false,
    action,
    risk,
    reason: action === "deny" ? `workspace policy denies ${risk}` : `explicit approval required for ${risk}`,
  };
}

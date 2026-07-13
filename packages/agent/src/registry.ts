import type { ToolCall, ToolDefinition } from "@archic/apollo-providers";
import type { ToolRisk } from "./policy";

export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string;

export interface AgentTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** Side-effecting tools (write, shell) — gated by the confirm policy. */
  destructive?: boolean;
  /** More precise policy category. Omitted legacy destructive tools are write-risk. */
  risk?: ToolRisk;
}

/**
 * The tools an agent may call, and the code behind them. Handlers return a
 * string the model reads back; a thrown handler becomes an error string the
 * model sees (so it can recover) rather than crashing the loop.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  registerAll(tools: Iterable<AgentTool>): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  /** Convenience registration without hand-building the definition object. */
  define(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    handler: ToolHandler,
    destructive = false,
  ): this {
    return this.register({ definition: { name, description, parameters }, handler, destructive });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  isDestructive(name: string): boolean {
    const tool = this.tools.get(name);
    return Boolean(tool?.destructive || (tool?.risk && tool.risk !== "read"));
  }

  risk(name: string): ToolRisk {
    const tool = this.tools.get(name);
    return tool?.risk ?? (tool?.destructive ? "write" : "read");
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async execute(call: ToolCall): Promise<string> {
    const tool = this.tools.get(call.name);
    if (!tool) return `error: unknown tool "${call.name}"`;
    try {
      return await tool.handler(call.arguments);
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

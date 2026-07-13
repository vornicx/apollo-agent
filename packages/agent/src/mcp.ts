import type { AgentTool } from "./registry";
import { ToolRegistry } from "./registry";

/**
 * The slice of an MCP client the bridge needs — structural, so `@archic/apollo-agent`
 * stays decoupled from `@archic/apollo-mcp`; any client with these two methods
 * (StdioMcpClient does) works, including the one wired to Midas.
 */
export interface McpToolSource {
  listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Render an MCP tool result into the string the model reads back. */
function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Turn every tool an MCP server exposes into an AgentTool — the bridge that
 * lets the agentic loop use Midas memory (recall/build_context/remember) and
 * any other MCP server as native tools. `prefix` namespaces the names (e.g.
 * "midas") to avoid collisions with built-ins or other servers.
 */
export async function mcpTools(source: McpToolSource, prefix?: string): Promise<AgentTool[]> {
  const infos = await source.listTools();
  return infos.map((info) => {
    const exposedName = prefix ? `${prefix}__${info.name}` : info.name;
    return {
      definition: {
        name: exposedName,
        description: info.description,
        parameters: info.inputSchema,
      },
      handler: async (args: Record<string, unknown>) => stringifyResult(await source.callTool(info.name, args)),
    };
  });
}

/** Convenience: build a registry from an MCP server's tools (optionally namespaced). */
export async function mcpToolRegistry(source: McpToolSource, prefix?: string): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  for (const tool of await mcpTools(source, prefix)) registry.register(tool);
  return registry;
}

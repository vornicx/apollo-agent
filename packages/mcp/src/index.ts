import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpToolClient } from "@archic/apollo-memory";

/**
 * MCP tool results wrap their payload as content blocks; servers like Midas
 * put JSON inside the first text block. Unwrap it so ports (MidasMemory)
 * receive the actual object.
 */
export function parseToolResult(result: unknown): unknown {
  const record = result as { content?: Array<{ type?: string; text?: string }> } | null | undefined;
  const text = record?.content?.find((block) => block?.type === "text")?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StdioMcpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Spawns an MCP server (e.g. Midas) over stdio and exposes the McpToolClient
 * transport that @archic/apollo-memory expects. Connects lazily on first call.
 */
export class StdioMcpClient implements McpToolClient {
  private client?: Client;

  constructor(private readonly options: StdioMcpClientOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args ?? [],
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    const client = new Client({ name: "apollo", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  /** List the tools the connected MCP server exposes (for use as agent tools). */
  async listTools(): Promise<McpToolInfo[]> {
    await this.connect();
    const result = (await this.client!.listTools()) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const result = await this.client!.callTool({ name, arguments: args });
    return parseToolResult(result);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}

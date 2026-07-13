import type { MemoryEntry, MemoryKind, MemoryPort, RecallOptions, RememberInput } from "./port";

/**
 * Minimal transport for talking to an MCP server. Apollo's runtime provides a
 * real client when it runs as an MCP host (M1); tests inject a fake. Keeping
 * the transport injected keeps this package dependency-free.
 */
export interface McpToolClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * MemoryPort backed by the Midas MCP server. Tool names and argument shapes
 * match Midas v0.1.x:
 *
 *   remember(content, kind, importance, provenance, session)
 *   recall(query, limit, hybrid)
 *   build_context(query, token_budget)
 *   forget(id)
 */
export class MidasMemory implements MemoryPort {
  constructor(private readonly client: McpToolClient) {}

  async remember(input: RememberInput): Promise<MemoryEntry> {
    const result = await this.client.callTool("remember", {
      content: input.content,
      kind: input.kind ?? "note",
      importance: input.importance ?? 0,
      provenance: input.provenance ?? "observation",
      session: input.session ?? "default",
    });
    const record = asRecord(result);
    return {
      id: str(record.id) ?? `midas-${Date.now()}`,
      kind: (str(record.kind) as MemoryKind) ?? input.kind ?? "note",
      content: input.content,
      importance: num(record.importance) ?? input.importance ?? 0,
      createdAt: Date.now(),
      provenance: input.provenance,
    };
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryEntry[]> {
    const result = await this.client.callTool("recall", {
      query,
      limit: options.limit ?? 5,
      hybrid: options.hybrid ?? false,
    });
    const rows = asRows(result);
    return rows.map((row) => ({
      id: str(row.id) ?? "unknown",
      kind: (str(row.kind) as MemoryKind) ?? "note",
      content: str(row.content) ?? "",
      importance: num(row.importance) ?? 0,
      createdAt: (num(row.created_at) ?? 0) * 1000,
      provenance: provenance(row.provenance),
      source: str(row.source) ?? str(row.actor) ?? str(row.session),
    }));
  }

  async buildContext(query: string, tokenBudget = 512): Promise<string> {
    const result = await this.client.callTool("build_context", {
      query,
      token_budget: tokenBudget,
    });
    if (typeof result === "string") return result;
    const record = asRecord(result);
    return str(record.context) ?? str(record.result) ?? JSON.stringify(result);
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.client.callTool("forget", { id });
    return Boolean(result);
  }
}

// Midas responses arrive as JSON of loosely known shape; parse defensively.

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asRows(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  const rows = Array.isArray(value) ? value : record.result;
  return Array.isArray(rows) ? rows.map(asRecord) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function provenance(value: unknown): MemoryEntry["provenance"] {
  return value === "planning" || value === "action" || value === "observation" || value === "user_confirmation"
    ? value
    : undefined;
}

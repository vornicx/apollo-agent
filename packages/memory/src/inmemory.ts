import type { MemoryEntry, MemoryPort, RecallOptions, RememberInput } from "./port";

/**
 * Reference implementation for tests and offline fallback. Recall is naive
 * keyword overlap with a recency tiebreak — enough to exercise the port,
 * not a substitute for Midas.
 */
export class InMemoryMemory implements MemoryPort {
  private readonly entries = new Map<string, MemoryEntry>();
  private counter = 0;

  async remember(input: RememberInput): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: `mem-${++this.counter}`,
      kind: input.kind ?? "note",
      content: input.content,
      importance: input.importance && input.importance > 0 ? input.importance : 3,
      createdAt: Date.now(),
      provenance: input.provenance,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryEntry[]> {
    const limit = options.limit ?? 5;
    const terms = tokenize(query);
    const scored = [...this.entries.values()]
      .map((entry) => {
        const words = new Set(tokenize(entry.content));
        const overlap = terms.filter((term) => words.has(term)).length;
        return { entry, score: overlap + entry.importance / 10 };
      })
      .filter(({ score }) => score > 0.5)
      .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt);
    return scored.slice(0, limit).map(({ entry }) => entry);
  }

  async buildContext(query: string, tokenBudget = 512): Promise<string> {
    const budgetChars = tokenBudget * 4; // rough chars-per-token heuristic
    const lines = [`Relevant memory for: ${query}`];
    let used = lines[0].length;
    for (const entry of await this.recall(query, { limit: 20 })) {
      const line = `- [${entry.kind}] ${entry.content}`;
      if (used + line.length > budgetChars) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join("\n");
  }

  async forget(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .filter((word) => word.length > 2);
}

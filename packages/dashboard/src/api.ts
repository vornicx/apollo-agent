import { listRunSummaries, readEventLog, summarizeRun, type RunSummary } from "@archic/apollo-core";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import type { ModelProfile } from "@archic/apollo-router";

export interface DashboardContext {
  runsDir: string;
  models: ModelProfile[];
  missionsDir?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface StatsResponse {
  runs: number;
  succeeded: number;
  failed: number;
  incomplete: number;
  successRate: number;
  totalCostUsd: number;
  byProvider: { provider: string; runs: number; costUsd: number }[];
}

const VALID_ID = /^[A-Za-z0-9_-]+$/;

function aggregate(summaries: RunSummary[]): StatsResponse {
  const providerRuns = new Map<string, { runs: number; costUsd: number }>();
  let succeeded = 0;
  let failed = 0;
  let incomplete = 0;
  let totalCostUsd = 0;
  for (const summary of summaries) {
    if (summary.status === "succeeded") succeeded++;
    else if (summary.status === "failed") failed++;
    else incomplete++;
    totalCostUsd += summary.costUsd;
    const provider = summary.finalModel?.split("/")[0] ?? "unknown";
    const entry = providerRuns.get(provider) ?? { runs: 0, costUsd: 0 };
    entry.runs++;
    entry.costUsd += summary.costUsd;
    providerRuns.set(provider, entry);
  }
  const decided = succeeded + failed;
  return {
    runs: summaries.length,
    succeeded,
    failed,
    incomplete,
    successRate: decided > 0 ? succeeded / decided : 0,
    totalCostUsd,
    byProvider: [...providerRuns.entries()]
      .map(([provider, v]) => ({ provider, ...v }))
      .sort((a, b) => b.runs - a.runs),
  };
}

/**
 * Pure request routing for the JSON API — no I/O binding, so it's fully
 * testable. Returns null when the path isn't an API route (the server then
 * serves the SPA or 404s).
 */
export function resolveApiRoute(pathname: string, ctx: DashboardContext): ApiResponse | null {
  if (pathname === "/api/models") {
    return { status: 200, body: { models: ctx.models } };
  }
  if (pathname === "/api/runs") {
    return { status: 200, body: { runs: listRunSummaries(ctx.runsDir) } };
  }
  if (pathname === "/api/stats") {
    return { status: 200, body: aggregate(listRunSummaries(ctx.runsDir)) };
  }
  if (pathname.startsWith("/api/runs/")) {
    const id = decodeURIComponent(pathname.slice("/api/runs/".length));
    if (!VALID_ID.test(id)) return { status: 400, body: { error: "invalid run id" } };
    try {
      const events = readEventLog(join(ctx.runsDir, `${id}.jsonl`));
      return { status: 200, body: { id, summary: { ...summarizeRun(events), id }, events, mission: readMission(ctx.missionsDir, id) } };
    } catch {
      return { status: 404, body: { error: `no such run: ${id}` } };
    }
  }
  if (pathname === "/api/missions") {
    return { status: 200, body: { missions: listMissions(ctx.missionsDir) } };
  }
  return null;
}

function readMission(dir: string | undefined, id: string): unknown {
  if (!dir) return undefined;
  try {
    return {
      mission: JSON.parse(readFileSync(join(dir, id, "mission.json"), "utf8")),
      outcome: JSON.parse(readFileSync(join(dir, id, "outcome.json"), "utf8")),
      evidence: JSON.parse(readFileSync(join(dir, id, "evidence.json"), "utf8")),
    };
  } catch {
    return undefined;
  }
}

function listMissions(dir: string | undefined): unknown[] {
  if (!dir) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && VALID_ID.test(entry.name))
      .map((entry) => readMission(dir, entry.name))
      .filter((mission): mission is NonNullable<typeof mission> => Boolean(mission));
  } catch {
    return [];
  }
}

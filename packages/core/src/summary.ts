import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StampedEvent } from "./events";
import { readEventLog } from "./sink";

export interface RunSummary {
  /** Run id (filename without .jsonl); set by the caller listing a directory. */
  id?: string;
  title: string;
  status: "succeeded" | "failed" | "incomplete";
  attempts: number;
  events: number;
  costUsd: number;
  finalModel?: string;
  /** Models that actually executed, in order — the escalation path taken. */
  models: string[];
  startedAt?: number;
  endedAt?: number;
  durationMs: number;
}

/**
 * Derive a run's outcome from its recorded event stream. Shared by the CLI
 * (`runs`/`replay`) and the dashboard so the summary means the same thing
 * everywhere.
 */
export function summarizeRun(events: readonly StampedEvent[]): RunSummary {
  let title = "(unknown)";
  let status: RunSummary["status"] = "incomplete";
  let attempts = 0;
  let costUsd = 0;
  let finalModel: string | undefined;
  const models: string[] = [];

  for (const event of events) {
    if (event.type === "task.started") title = event.title;
    else if (event.type === "execution.completed") {
      costUsd += event.costUsd ?? 0;
      if (event.modelId) {
        finalModel = event.modelId;
        if (models[models.length - 1] !== event.modelId) models.push(event.modelId);
      }
    } else if (event.type === "task.completed") {
      status = "succeeded";
      attempts = event.attempts;
    } else if (event.type === "task.failed") {
      status = "failed";
      attempts = event.attempts;
    }
  }

  const startedAt = events[0]?.at;
  const endedAt = events[events.length - 1]?.at;
  return {
    title,
    status,
    attempts,
    events: events.length,
    costUsd,
    finalModel,
    models,
    startedAt,
    endedAt,
    durationMs: startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : 0,
  };
}

export interface RunFile {
  id: string;
  path: string;
  mtimeMs: number;
}

/** List recorded run files in a directory, newest first. Missing dir → empty. */
export function listRunFiles(dir: string): RunFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({
      id: name.replace(/\.jsonl$/, ""),
      path: join(dir, name),
      mtimeMs: statSync(join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** List + summarize every recorded run in a directory. Unreadable runs are marked. */
export function listRunSummaries(dir: string): RunSummary[] {
  return listRunFiles(dir).map(({ id, path }) => {
    try {
      return { ...summarizeRun(readEventLog(path)), id };
    } catch {
      return {
        id,
        title: "(unreadable)",
        status: "incomplete" as const,
        attempts: 0,
        events: 0,
        costUsd: 0,
        models: [],
        durationMs: 0,
      };
    }
  });
}

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { readEventLog, redactText } from "@archic/apollo-core";

export interface RuntimeCommand {
  command: string;
  args?: string[];
  stateDir: string;
}

export interface MissionLaunchRequest {
  goal: string;
  workspace: string;
  approve?: boolean;
  noMemory?: boolean;
  check?: string;
  parentId?: string;
}

export interface ControlledMission extends MissionLaunchRequest {
  id: string;
  status: "running" | "succeeded" | "needs_input" | "stopped" | "failed" | "canceled";
  createdAt: string;
  updatedAt: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  answer?: string;
  verificationPassed?: boolean;
}

const VALID_ID = /^[A-Za-z0-9_-]+$/;

export class MissionController {
  private readonly children = new Map<string, ChildProcess>();
  private readonly records = new Map<string, ControlledMission>();
  private readonly controlDir: string;

  constructor(readonly runtime: RuntimeCommand) {
    this.controlDir = join(resolve(runtime.stateDir), "control");
    mkdirSync(this.controlDir, { recursive: true });
    this.loadExisting();
  }

  list(): ControlledMission[] {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ControlledMission | undefined {
    return this.records.get(id);
  }

  launch(input: MissionLaunchRequest): ControlledMission {
    const goal = String(input.goal ?? "").trim();
    const workspace = resolve(String(input.workspace ?? ""));
    if (!goal || goal.length > 20_000) throw new Error("goal is required and must be at most 20,000 characters");
    if (!input.workspace || !existsSync(workspace)) throw new Error("workspace must be an existing path");
    if (input.parentId && !VALID_ID.test(input.parentId)) throw new Error("invalid parent mission id");

    const id = `mission-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const now = new Date().toISOString();
    const record: ControlledMission = {
      id,
      goal,
      workspace,
      approve: Boolean(input.approve),
      noMemory: Boolean(input.noMemory),
      check: input.check?.trim() || undefined,
      parentId: input.parentId,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    const args = [
      ...(this.runtime.args ?? []),
      "cortex",
      goal,
      "--workspace",
      workspace,
      "--task-id",
      id,
      "--record",
      join(resolve(this.runtime.stateDir), "runs", `${id}.jsonl`),
    ];
    if (record.approve) args.push("--yes");
    if (record.noMemory) args.push("--no-memory");
    if (record.check) args.push("--check", record.check);

    let child: ChildProcess;
    try {
      child = spawn(this.runtime.command, args, {
        cwd: workspace,
        env: { ...process.env, APOLLO_STATE_DIR: resolve(this.runtime.stateDir), APOLLO_DESKTOP: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      record.status = "failed";
      record.error = redactText(error instanceof Error ? error.message : String(error));
      this.save(record);
      return record;
    }
    record.pid = child.pid;
    this.children.set(id, child);
    this.save(record);

    let diagnosticTail = "";
    const collect = (chunk: Buffer) => { diagnosticTail = (diagnosticTail + chunk.toString("utf8")).slice(-8_000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      const current = this.records.get(id);
      if (!current) return;
      current.error = redactText(error.message);
      current.status = "failed";
      current.updatedAt = new Date().toISOString();
      this.save(current);
    });
    child.on("close", (code, signal) => {
      this.children.delete(id);
      const current = this.records.get(id);
      if (!current) return;
      current.exitCode = code;
      current.signal = signal;
      current.updatedAt = new Date().toISOString();
      if (current.status === "running") {
        current.status = code === 0 ? "succeeded" : code === 2 && this.needsInput(id) ? "needs_input" : code === 2 ? "stopped" : "failed";
      }
      this.loadOutcome(current);
      if (current.status === "failed" && diagnosticTail.trim()) current.error = redactText(diagnosticTail.trim().slice(-2_000));
      this.save(current);
    });
    return record;
  }

  cancel(id: string): ControlledMission {
    if (!VALID_ID.test(id)) throw new Error("invalid mission id");
    const record = this.records.get(id);
    if (!record) throw new Error("mission not found");
    const child = this.children.get(id);
    if (!child || record.status !== "running") throw new Error("mission is not running");
    record.status = "canceled";
    record.updatedAt = new Date().toISOString();
    this.save(record);
    child.kill("SIGTERM");
    return record;
  }

  retry(id: string, clarification?: string): ControlledMission {
    if (!VALID_ID.test(id)) throw new Error("invalid mission id");
    const previous = this.records.get(id);
    if (!previous) throw new Error("mission not found");
    const extra = String(clarification ?? "").trim();
    return this.launch({
      goal: extra ? `${previous.goal}\n\nHuman clarification for the retry:\n${extra}` : previous.goal,
      workspace: previous.workspace,
      approve: previous.approve,
      noMemory: previous.noMemory,
      check: previous.check,
      parentId: id,
    });
  }

  close(): void {
    for (const [id, child] of this.children) {
      const record = this.records.get(id);
      if (record?.status === "running") {
        record.status = "stopped";
        record.error = "dashboard runtime shut down while mission was running";
        record.updatedAt = new Date().toISOString();
        this.save(record);
      }
      child.kill("SIGTERM");
    }
    this.children.clear();
  }

  private save(record: ControlledMission): void {
    this.records.set(record.id, record);
    writeFileSync(join(this.controlDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }

  private loadExisting(): void {
    let names: string[] = [];
    try { names = readdirSync(this.controlDir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(this.controlDir, name), "utf8")) as ControlledMission;
        if (VALID_ID.test(record.id)) {
          if (record.status === "running") {
            record.status = "stopped";
            record.error = "runtime exited before mission state was finalized";
            record.updatedAt = new Date().toISOString();
            this.save(record);
          } else {
            this.loadOutcome(record);
            this.records.set(record.id, record);
          }
        }
      } catch { /* ignore malformed control records */ }
    }
  }

  private needsInput(id: string): boolean {
    try {
      const events = readEventLog(join(resolve(this.runtime.stateDir), "runs", `${id}.jsonl`));
      return events.some((event) => event.type === "meta.stop" && event.status === "needs_input");
    } catch {
      return false;
    }
  }

  private loadOutcome(record: ControlledMission): void {
    try {
      const outcome = JSON.parse(readFileSync(join(resolve(this.runtime.stateDir), "missions", record.id, "outcome.json"), "utf8")) as {
        summary?: string;
        evidence?: { verificationPassed?: boolean };
      };
      if (outcome.summary?.trim()) record.answer = outcome.summary.trim();
      if (typeof outcome.evidence?.verificationPassed === "boolean") record.verificationPassed = outcome.evidence.verificationPassed;
    } catch { /* mission bundle may not exist for a process-level failure */ }
  }
}

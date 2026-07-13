import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, JsonlEventSink, readEventLog } from "../src/index";

describe("JsonlEventSink", () => {
  it("records every emitted event and reads it back in order", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apollo-sink-")), "run.jsonl");
    const bus = new EventBus();
    const sink = new JsonlEventSink(path).attach(bus);

    bus.emit({ type: "task.started", taskId: "t1", title: "demo" });
    bus.emit({ type: "routing.decided", taskId: "t1", modelId: "anthropic/claude-opus-4-8", reason: "best fit" });
    bus.emit({ type: "task.completed", taskId: "t1", attempts: 1 });

    const log = readEventLog(path);
    expect(log.map((e) => e.type)).toEqual(["task.started", "routing.decided", "task.completed"]);
    expect(log[0].seq).toBe(1);
    expect(log[2].seq).toBe(3);
    expect(typeof log[0].at).toBe("number");
  });

  it("stops recording after close()", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apollo-sink-")), "run.jsonl");
    const bus = new EventBus();
    const sink = new JsonlEventSink(path).attach(bus);
    bus.emit({ type: "task.started", taskId: "t1", title: "demo" });
    sink.close();
    bus.emit({ type: "task.completed", taskId: "t1", attempts: 1 });

    expect(readEventLog(path).map((e) => e.type)).toEqual(["task.started"]);
  });

  it("creates the parent directory when it does not exist", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apollo-sink-")), "nested", "deeper", "run.jsonl");
    const bus = new EventBus();
    new JsonlEventSink(path).attach(bus);
    bus.emit({ type: "task.started", taskId: "t1", title: "demo" });
    expect(readEventLog(path)).toHaveLength(1);
  });

  it("redacts credentials before appending the audit event", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apollo-sink-")), "run.jsonl");
    const bus = new EventBus();
    new JsonlEventSink(path).attach(bus);
    bus.emit({ type: "task.started", taskId: "t1", title: "use sk-abcdefghijklmnopqrstuvwxyz123456" });
    expect(readEventLog(path)[0]).toMatchObject({ title: "use [REDACTED]" });
  });
});

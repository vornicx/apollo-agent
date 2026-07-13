import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventBus, StampedEvent } from "./events";
import { redactSecrets } from "./redaction";

/**
 * Persists the event stream as JSON Lines — one stamped event per line, in
 * order. This is the audit trail on disk: every run is replayable and
 * inspectable after the fact, and the future desktop UI reads the same format
 * the live bus emits. One writer per run; append-only.
 */
export class JsonlEventSink {
  private unsubscribe?: () => void;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Mirror every event the bus emits into the file until close(). */
  attach(bus: EventBus): this {
    this.unsubscribe = bus.on("*", (event) => {
      appendFileSync(this.path, `${JSON.stringify(redactSecrets(event))}\n`);
    });
    return this;
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

/** Read a recorded run back into the ordered event list the bus produced. */
export function readEventLog(path: string): StampedEvent[] {
  const events: StampedEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) events.push(JSON.parse(trimmed) as StampedEvent);
  }
  return events;
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelProfile } from "@archic/apollo-router";
import { resolveApiRoute, type DashboardContext } from "./api";
import { renderHtml } from "./ui";
import { MissionController, type MissionLaunchRequest, type RuntimeCommand } from "./control";

export interface DashboardOptions {
  runsDir: string;
  models: ModelProfile[];
  missionsDir?: string;
  port?: number;
  host?: string;
  /** Poll interval for the live event stream, ms. Default 1000. */
  pollMs?: number;
  /** Enables the write-side mission API used by Apollo Desktop. */
  runtime?: RuntimeCommand;
  version?: string;
  diagnostics?: {
    providers: string[];
    providerNotes: string[];
    memoryConfigured: boolean;
    configPath?: string;
    workspace: string;
  };
}

export interface RunningDashboard {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * The dashboard is a projection of the event stream — nothing more. It serves
 * the SPA, exposes the recorded runs + model fleet as JSON, and tails the
 * append-only run logs over SSE so an in-flight run streams in live. Node
 * built-ins only; no runtime dependencies.
 */
export function startDashboard(options: DashboardOptions): Promise<RunningDashboard> {
  const ctx: DashboardContext = { runsDir: options.runsDir, models: options.models, missionsDir: options.missionsDir };
  const host = options.host ?? "127.0.0.1";
  const pollMs = options.pollMs ?? 1000;
  const html = renderHtml();
  const controller = options.runtime ? new MissionController(options.runtime) : undefined;

  const server = createServer((req, res) => { void handle(req, res, ctx, html, options.runsDir, pollMs, controller, options.version, options.diagnostics); });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 4317, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 4317);
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () =>
          new Promise((done) => {
            controller?.close();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DashboardContext,
  html: string,
  runsDir: string,
  pollMs: number,
  controller?: MissionController,
  version?: string,
  diagnostics?: DashboardOptions["diagnostics"],
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "POST") {
    await handleControlPost(req, res, pathname, controller);
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    return;
  }
  if (pathname === "/api/stream") {
    streamEvents(res, runsDir, pollMs);
    return;
  }
  if (pathname === "/api/control") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ missions: controller?.list() ?? [], enabled: Boolean(controller) }));
    return;
  }
  if (pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      runtime: controller ? "embedded" : "read-only",
      version: version ?? "development",
      node: process.version,
      platform: process.platform,
      stateDir: controller?.runtime.stateDir,
      missionControl: Boolean(controller),
      models: ctx.models.length,
      diagnostics,
    }));
    return;
  }
  const api = resolveApiRoute(pathname, ctx);
  if (api) {
    res.writeHead(api.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(api.body));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
}

async function handleControlPost(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  controller?: MissionController,
): Promise<void> {
  if (!controller) {
    json(res, 503, { error: "mission control is not enabled" });
    return;
  }
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    json(res, 403, { error: "cross-origin mission control is forbidden" });
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (pathname === "/api/missions") {
      json(res, 202, { mission: controller.launch(body as unknown as MissionLaunchRequest) });
      return;
    }
    const match = pathname.match(/^\/api\/missions\/([A-Za-z0-9_-]+)\/(cancel|retry)$/);
    if (match?.[2] === "cancel") {
      json(res, 200, { mission: controller.cancel(match[1]) });
      return;
    }
    if (match?.[2] === "retry") {
      json(res, 202, { mission: controller.retry(match[1], typeof body.clarification === "string" ? body.clarification : undefined) });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 64_000) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      try {
        const parsed = text ? JSON.parse(text) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
        resolve(parsed as Record<string, unknown>);
      } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

/**
 * Server-Sent Events over the run directory. Run logs are append-only JSONL, so
 * polling line counts and emitting the new lines gives a real live feed of an
 * in-flight run without any shared channel between the run process and here.
 */
function streamEvents(res: ServerResponse, runsDir: string, pollMs: number): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

  const seenLines = new Map<string, number>();
  // Prime with current line counts so we only stream genuinely new events.
  for (const [id, lines] of readRunLines(runsDir)) seenLines.set(id, lines.length);

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tick = () => {
    let changed = false;
    for (const [id, lines] of readRunLines(runsDir)) {
      const seen = seenLines.get(id) ?? 0;
      if (lines.length > seen) {
        for (let i = seen; i < lines.length; i++) {
          try {
            send("run-event", { runId: id, event: JSON.parse(lines[i]) });
          } catch {
            // partial write mid-append; it'll be re-read complete next tick
            seenLines.set(id, i);
            changed = true;
            break;
          }
        }
        if (seenLines.get(id) !== lines.length) seenLines.set(id, lines.length);
        changed = true;
      }
    }
    if (changed) send("runs-changed", { at: Date.now() });
  };

  const interval = setInterval(tick, pollMs);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  const stop = () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  };
  res.on("close", stop);
  res.on("error", stop);
}

function readRunLines(runsDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const lines = readFileSync(join(runsDir, name), "utf8").split("\n").filter((l) => l.trim());
      out.set(name.replace(/\.jsonl$/, ""), lines);
    } catch {
      // skip unreadable file this tick
    }
  }
  return out;
}

export type { Server };

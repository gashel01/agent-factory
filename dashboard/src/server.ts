/**
 * agent-factory dashboard server — zero runtime dependencies (node:http + node:fs).
 *
 * Reads the append-only events.jsonl written by the Python dispatcher and streams
 * it to browsers over SSE. Control commands go the other way through their own
 * file: the dashboard appends to control.jsonl, the dispatcher polls it. One
 * writer per file, in each direction — never a shared one.
 *
 * Cross-platform by construction: file growth is detected by polling size+offset
 * (fs.watch is unreliable for appends on Windows network/temp paths).
 */

import {
  appendFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Options {
  runs: string;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { runs: "runs", port: 8765, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runs" && argv[i + 1]) opts.runs = argv[++i]!;
    else if (arg === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg === "--host" && argv[i + 1]) opts.host = argv[++i]!; // non-local = your call
  }
  opts.runs = resolve(opts.runs);
  return opts;
}

function latestRun(runsDir: string): string | null {
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir)
    .filter((name) => existsSync(join(runsDir, name, "events.jsonl")))
    .sort();
  return runs.length ? runs[runs.length - 1]! : null;
}

/** Tails one run's events.jsonl and fans lines out to SSE clients. */
class RunTailer {
  private offset = 0;
  private buffer = "";
  readonly clients = new Set<ServerResponse>();

  constructor(
    readonly runsDir: string,
    public run: string,
  ) {}

  private get file(): string {
    return join(this.runsDir, this.run, "events.jsonl");
  }

  /** Switch to a new run: notify clients, replay its log from the top. */
  switchTo(run: string): void {
    this.run = run;
    this.offset = 0;
    this.buffer = "";
    for (const client of this.clients) {
      client.write(`event: run\ndata: ${JSON.stringify({ run })}\n\n`);
    }
  }

  attach(client: ServerResponse): void {
    client.write(`event: run\ndata: ${JSON.stringify({ run: this.run })}\n\n`);
    // Full replay on connect: the client rebuilds state from event zero,
    // so attaching mid-run and opening a finished run are the same code path.
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf-8").split("\n")) {
        if (line.trim()) client.write(`data: ${line}\n\n`);
      }
    }
    this.clients.add(client);
  }

  /** Poll for appended bytes; emit any complete new lines. */
  poll(): void {
    if (!existsSync(this.file)) return;
    const size = statSync(this.file).size;
    if (size <= this.offset) return;
    const stream = createReadStream(this.file, { start: this.offset, encoding: "utf-8" });
    stream.on("data", (chunk) => {
      this.buffer += chunk;
    });
    stream.on("end", () => {
      this.offset = size;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? ""; // keep a torn tail for the next poll
      for (const line of lines) {
        if (!line.trim()) continue;
        for (const client of this.clients) client.write(`data: ${line}\n\n`);
      }
    });
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = resolve(here, "..", "public");

  const initial = latestRun(opts.runs);
  if (!initial) {
    console.error(`no runs with events.jsonl under ${opts.runs}`);
    process.exit(1);
  }
  const tailer = new RunTailer(opts.runs, initial);

  setInterval(() => {
    const newest = latestRun(opts.runs);
    if (newest && newest !== tailer.run) tailer.switchTo(newest); // a new `factory run` started
    tailer.poll();
  }, 500);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(publicDir, "index.html")));
      return;
    }
    if (url.pathname === "/client.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(join(here, "client.js")));
      return;
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      tailer.attach(res);
      req.on("close", () => tailer.clients.delete(res));
      return;
    }
    if (url.pathname === "/api/control" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { op, task } = JSON.parse(body) as { op?: string; task?: string };
          const ops = ["pause", "resume", "stop", "kill", "retry"];
          if (!op || !ops.includes(op)) throw new Error(`op must be one of ${ops.join(", ")}`);
          if (task !== undefined && !/^[\w.-]+$/.test(task)) throw new Error("bad task id");
          const line = JSON.stringify({ ts: new Date().toISOString(), op, task });
          appendFileSync(join(opts.runs, tailer.run, "control.jsonl"), line + "\n", "utf-8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }
    if (url.pathname === "/api/log") {
      const task = url.searchParams.get("task") ?? "";
      if (!/^[\w.-]+$/.test(task)) {
        res.writeHead(400).end("bad task id");
        return;
      }
      const file = join(opts.runs, tailer.run, "agents", `${task}.stdout.jsonl`);
      if (!existsSync(file)) {
        res.writeHead(404).end("no log for this task (yet)");
        return;
      }
      const size = statSync(file).size;
      const tail = readFileSync(file, "utf-8").slice(Math.max(0, size - 64_000));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(tail);
      return;
    }
    res.writeHead(404).end("not found");
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`dashboard: http://${opts.host}:${opts.port}  (runs: ${opts.runs})`);
  });
}

main();

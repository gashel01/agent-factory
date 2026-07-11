/**
 * agent-factory dashboard server — zero runtime dependencies (node:http + node:fs).
 *
 * Three responsibilities, cleanly separated:
 *  - READ the append-only events.jsonl written by the dispatcher, stream it over SSE;
 *  - WRITE operator commands to control.jsonl (the dispatcher polls it) — one
 *    writer per file, in each direction, never a shared one;
 *  - LAUNCH `factory plan` / `factory run` as child processes on request, so the
 *    whole workflow (goal → tickets → run → watch) works from the browser.
 *
 * Cross-platform by construction: file growth is detected by polling size+offset
 * (fs.watch is unreliable for appends on Windows network/temp paths).
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Options {
  workdir: string; // where backlog/, factory.yaml and runs/ live
  runs: string;
  port: number;
  host: string;
  factory: string[]; // how to invoke the CLI, e.g. ["uv","run","factory"]
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    workdir: ".",
    runs: "",
    port: 8765,
    host: "127.0.0.1",
    factory: ["uv", "run", "factory"],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workdir" && argv[i + 1]) opts.workdir = argv[++i]!;
    else if (arg === "--runs" && argv[i + 1]) opts.runs = argv[++i]!;
    else if (arg === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg === "--host" && argv[i + 1]) opts.host = argv[++i]!; // non-local = your call
    else if (arg === "--factory" && argv[i + 1]) opts.factory = argv[++i]!.split(" ");
  }
  opts.workdir = resolve(opts.workdir);
  opts.runs = resolve(opts.runs || join(opts.workdir, "runs"));
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
    public run: string | null,
  ) {}

  private get file(): string | null {
    return this.run ? join(this.runsDir, this.run, "events.jsonl") : null;
  }

  /** Switch to a new run: notify clients, replay its log from the top. */
  switchTo(run: string): void {
    this.run = run;
    this.offset = 0;
    this.buffer = "";
    for (const client of this.clients) {
      client.write(`event: run\ndata: ${JSON.stringify({ run })}\n\n`);
      this.replayTo(client);
    }
  }

  private replayTo(client: ServerResponse): void {
    if (this.file && existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf-8").split("\n")) {
        if (line.trim()) client.write(`data: ${line}\n\n`);
      }
    }
  }

  attach(client: ServerResponse): void {
    client.write(`event: run\ndata: ${JSON.stringify({ run: this.run })}\n\n`);
    // Full replay on connect: the client rebuilds state from event zero,
    // so attaching mid-run and opening a finished run are the same code path.
    this.replayTo(client);
    this.clients.add(client);
  }

  /** Poll for appended bytes; emit any complete new lines. */
  poll(): void {
    if (!this.file || !existsSync(this.file)) return;
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

/* ------------------------------- CLI jobs ------------------------------- */

interface Job {
  state: "idle" | "running" | "done" | "error";
  output: string;
}

const jobs: Record<"plan" | "run", Job> = {
  plan: { state: "idle", output: "" },
  run: { state: "idle", output: "" },
};

function spawnJob(kind: "plan" | "run", opts: Options, args: string[]): void {
  jobs[kind] = { state: "running", output: "" };
  // NEVER shell:true — goals are user text (spaces, parentheses, quotes) and
  // must reach the CLI as one argv entry, not be re-parsed by cmd.exe.
  // Windows note: the command must resolve to an .exe (uv, python, a full
  // path); .cmd shims need an explicit path in --factory.
  const [cmd, ...prefix] = opts.factory;
  const child = spawn(cmd!, [...prefix, ...args], {
    cwd: opts.workdir,
    shell: false,
    windowsHide: true,
  });
  const append = (chunk: Buffer) => {
    jobs[kind].output = (jobs[kind].output + chunk.toString("utf-8")).slice(-20_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (err) => {
    jobs[kind].state = "error";
    jobs[kind].output += `\n${String(err)}`;
  });
  child.on("exit", (code) => {
    jobs[kind].state = code === 0 ? "done" : "error";
  });
}

/* --------------------------------- http --------------------------------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolvePromise(body));
  });
}

function json(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const SAFE_NAME = /^[\w.-]+\.md$/;

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = resolve(here, "..", "public");
  const backlogDir = join(opts.workdir, "backlog");

  // No run yet is a normal state now: the browser is where work gets created.
  const tailer = new RunTailer(opts.runs, latestRun(opts.runs));

  setInterval(() => {
    const newest = latestRun(opts.runs);
    if (newest && newest !== tailer.run) tailer.switchTo(newest); // a new run started
    tailer.poll();
  }, 500);

  const server = createServer(async (req, res) => {
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
      try {
        const { op, task } = JSON.parse(await readBody(req)) as { op?: string; task?: string };
        const ops = ["pause", "resume", "stop", "kill", "retry"];
        if (!op || !ops.includes(op)) throw new Error(`op must be one of ${ops.join(", ")}`);
        if (task !== undefined && !/^[\w.-]+$/.test(task)) throw new Error("bad task id");
        if (!tailer.run) throw new Error("no active run");
        const line = JSON.stringify({ ts: new Date().toISOString(), op, task });
        appendFileSync(join(opts.runs, tailer.run, "control.jsonl"), line + "\n", "utf-8");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/log") {
      const task = url.searchParams.get("task") ?? "";
      if (!/^[\w.-]+$/.test(task) || !tailer.run) {
        res.writeHead(400).end("bad task id or no run");
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

    /* ---------- workflow: plan / backlog / run, all from the browser ---------- */

    if (url.pathname === "/api/status") {
      const backlog = existsSync(backlogDir)
        ? readdirSync(backlogDir).filter((f) => f.endsWith(".md")).length
        : 0;
      json(res, 200, { plan: jobs.plan, run: jobs.run, backlogCount: backlog, currentRun: tailer.run });
      return;
    }

    if (url.pathname === "/api/plan" && req.method === "POST") {
      try {
        const { goal, repo } = JSON.parse(await readBody(req)) as { goal?: string; repo?: string };
        if (!goal?.trim()) throw new Error("goal is required");
        if (!repo?.trim()) throw new Error("repo path is required");
        if (jobs.plan.state === "running" || jobs.run.state === "running") {
          throw new Error("a job is already running");
        }
        spawnJob("plan", opts, ["plan", goal.trim(), "--repo", repo.trim()]);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      try {
        const { slots } = JSON.parse(await readBody(req)) as { slots?: number };
        if (jobs.run.state === "running") throw new Error("a run is already in progress");
        const args = ["run"];
        if (slots && Number.isFinite(slots) && slots > 0) args.push("--slots", String(slots));
        spawnJob("run", opts, args);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/backlog" && req.method === "GET") {
      const tickets = existsSync(backlogDir)
        ? readdirSync(backlogDir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f) => ({
              file: f,
              content: readFileSync(join(backlogDir, f), "utf-8"),
            }))
        : [];
      json(res, 200, { tickets });
      return;
    }

    if (url.pathname.startsWith("/api/backlog/")) {
      const file = basename(decodeURIComponent(url.pathname.slice("/api/backlog/".length)));
      if (!SAFE_NAME.test(file)) {
        json(res, 400, { ok: false, error: "bad ticket filename" });
        return;
      }
      const path = join(backlogDir, file);
      if (req.method === "PUT") {
        const { content } = JSON.parse(await readBody(req)) as { content?: string };
        if (typeof content !== "string" || !content.startsWith("---")) {
          json(res, 400, { ok: false, error: "ticket must start with YAML front matter" });
          return;
        }
        mkdirSync(backlogDir, { recursive: true });
        writeFileSync(path, content, "utf-8");
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "DELETE") {
        if (existsSync(path)) unlinkSync(path);
        json(res, 200, { ok: true });
        return;
      }
    }

    res.writeHead(404).end("not found");
  });

  server.listen(opts.port, opts.host, () => {
    console.log(
      `dashboard: http://${opts.host}:${opts.port}  (workdir: ${opts.workdir}, runs: ${opts.runs})`,
    );
  });
}

main();

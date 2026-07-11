/**
 * agent-factory dashboard server — zero runtime dependencies (node:http + node:fs).
 *
 * Manages one or more WORKSPACES (a directory holding factory.yaml, backlog/ and
 * runs/). Per workspace it: reads the dispatcher's append-only events.jsonl and
 * streams it over SSE; writes operator commands to control.jsonl (the dispatcher
 * polls it) — one writer per file, in each direction; and launches `factory plan`
 * / `factory run` as child processes so the whole workflow runs from the browser.
 *
 * The workspace registry lives in workspaces.json next to the server's initial
 * --workdir. Cross-platform by construction: file growth is detected by polling
 * size+offset (fs.watch is unreliable for appends on Windows network/temp paths).
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
  workdir: string;
  port: number;
  host: string;
  factory: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    workdir: ".",
    port: 8765,
    host: "127.0.0.1",
    factory: ["uv", "run", "factory"],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workdir" && argv[i + 1]) opts.workdir = argv[++i]!;
    else if (arg === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg === "--host" && argv[i + 1]) opts.host = argv[++i]!; // non-local = your call
    else if (arg === "--factory" && argv[i + 1]) opts.factory = argv[++i]!.split(" ");
  }
  opts.workdir = resolve(opts.workdir);
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

/* ------------------------------ workspaces ------------------------------ */

interface Job {
  state: "idle" | "running" | "done" | "error";
  output: string;
}

interface Workspace {
  name: string;
  workdir: string;
  tailer: RunTailer;
  jobs: { plan: Job; run: Job; chat: Job };
}

const SAFE_WS = /^[\w][\w .-]{0,40}$/;

class Registry {
  readonly workspaces = new Map<string, Workspace>();

  constructor(readonly file: string) {}

  load(defaultWorkdir: string): void {
    let entries: Array<{ name: string; workdir: string }> = [];
    if (existsSync(this.file)) {
      try {
        entries = (JSON.parse(readFileSync(this.file, "utf-8")) as { workspaces?: [] })
          .workspaces ?? [];
      } catch {
        entries = [];
      }
    }
    if (!entries.some((e) => resolve(e.workdir) === defaultWorkdir)) {
      entries.unshift({ name: basename(defaultWorkdir) || "default", workdir: defaultWorkdir });
    }
    for (const entry of entries) this.register(entry.name, entry.workdir);
    this.save();
  }

  register(name: string, workdir: string): Workspace {
    const dir = resolve(workdir);
    const runs = join(dir, "runs");
    const ws: Workspace = {
      name,
      workdir: dir,
      tailer: new RunTailer(runs, latestRun(runs)),
      jobs: {
        plan: { state: "idle", output: "" },
        run: { state: "idle", output: "" },
        chat: { state: "idle", output: "" },
      },
    };
    this.workspaces.set(name, ws);
    return ws;
  }

  save(): void {
    const entries = [...this.workspaces.values()].map(({ name, workdir }) => ({ name, workdir }));
    writeFileSync(this.file, JSON.stringify({ workspaces: entries }, null, 2), "utf-8");
  }

  resolve(url: URL): Workspace | null {
    const name = url.searchParams.get("ws");
    if (name) return this.workspaces.get(name) ?? null;
    return this.workspaces.values().next().value ?? null;
  }
}

function spawnJob(
  ws: Workspace,
  kind: "plan" | "run" | "chat",
  factory: string[],
  args: string[],
): void {
  ws.jobs[kind] = { state: "running", output: "" };
  // NEVER shell:true — goals are user text (spaces, parentheses, quotes) and
  // must reach the CLI as one argv entry. Windows: the command must resolve
  // to an .exe (uv, python, a full path); .cmd shims need an explicit path.
  const [cmd, ...prefix] = factory;
  const child = spawn(cmd!, [...prefix, ...args], {
    cwd: ws.workdir,
    shell: false,
    windowsHide: true,
  });
  const append = (chunk: Buffer) => {
    ws.jobs[kind].output = (ws.jobs[kind].output + chunk.toString("utf-8")).slice(-20_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (err) => {
    ws.jobs[kind].state = "error";
    ws.jobs[kind].output += `\n${String(err)}`;
  });
  child.on("exit", (code) => {
    ws.jobs[kind].state = code === 0 ? "done" : "error";
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

  const registry = new Registry(join(opts.workdir, "workspaces.json"));
  registry.load(opts.workdir);

  setInterval(() => {
    for (const ws of registry.workspaces.values()) {
      const newest = latestRun(ws.tailer.runsDir);
      if (newest && newest !== ws.tailer.run) ws.tailer.switchTo(newest);
      ws.tailer.poll();
    }
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

    /* ---------------- workspace management ---------------- */

    if (url.pathname === "/api/workspaces" && req.method === "GET") {
      json(res, 200, {
        workspaces: [...registry.workspaces.values()].map((ws) => ({
          name: ws.name,
          workdir: ws.workdir,
          currentRun: ws.tailer.run,
        })),
      });
      return;
    }
    if (url.pathname === "/api/workspaces" && req.method === "POST") {
      try {
        const { name, workdir } = JSON.parse(await readBody(req)) as {
          name?: string;
          workdir?: string;
        };
        if (!name || !SAFE_WS.test(name)) throw new Error("bad workspace name");
        if (registry.workspaces.has(name)) throw new Error("name already exists");
        if (!workdir || !existsSync(workdir)) throw new Error("workdir does not exist");
        mkdirSync(join(workdir, "backlog"), { recursive: true });
        registry.register(name, workdir);
        registry.save();
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname.startsWith("/api/workspaces/") && req.method === "DELETE") {
      const name = decodeURIComponent(url.pathname.slice("/api/workspaces/".length));
      if (registry.workspaces.size <= 1) {
        json(res, 400, { ok: false, error: "cannot remove the last workspace" });
        return;
      }
      registry.workspaces.delete(name); // registry entry only; files stay on disk
      registry.save();
      json(res, 200, { ok: true });
      return;
    }

    /* ---------------- everything below is per-workspace (?ws=) ---------------- */

    const ws = registry.resolve(url);
    if (!ws) {
      json(res, 404, { ok: false, error: "unknown workspace" });
      return;
    }
    const backlogDir = join(ws.workdir, "backlog");

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      ws.tailer.attach(res);
      req.on("close", () => ws.tailer.clients.delete(res));
      return;
    }

    if (url.pathname === "/api/control" && req.method === "POST") {
      try {
        const { op, task } = JSON.parse(await readBody(req)) as { op?: string; task?: string };
        const ops = ["pause", "resume", "stop", "kill", "retry"];
        if (!op || !ops.includes(op)) throw new Error(`op must be one of ${ops.join(", ")}`);
        if (task !== undefined && !/^[\w.-]+$/.test(task)) throw new Error("bad task id");
        if (!ws.tailer.run) throw new Error("no active run");
        const line = JSON.stringify({ ts: new Date().toISOString(), op, task });
        appendFileSync(join(ws.tailer.runsDir, ws.tailer.run, "control.jsonl"), line + "\n", "utf-8");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/log") {
      const task = url.searchParams.get("task") ?? "";
      if (!/^[\w.-]+$/.test(task) || !ws.tailer.run) {
        res.writeHead(400).end("bad task id or no run");
        return;
      }
      const file = join(ws.tailer.runsDir, ws.tailer.run, "agents", `${task}.stdout.jsonl`);
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

    if (url.pathname === "/api/status") {
      const backlog = existsSync(backlogDir)
        ? readdirSync(backlogDir).filter((f) => f.endsWith(".md")).length
        : 0;
      json(res, 200, {
        plan: ws.jobs.plan,
        run: ws.jobs.run,
        chat: ws.jobs.chat,
        backlogCount: backlog,
        currentRun: ws.tailer.run,
        workspace: ws.name,
      });
      return;
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const { message } = JSON.parse(await readBody(req)) as { message?: string };
        if (!message?.trim()) throw new Error("message is required");
        if (ws.jobs.chat.state === "running") throw new Error("the supervisor is still answering");
        spawnJob(ws, "chat", opts.factory, ["ask", message.trim()]);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/plan" && req.method === "POST") {
      try {
        const { goal, repo } = JSON.parse(await readBody(req)) as { goal?: string; repo?: string };
        if (!goal?.trim()) throw new Error("goal is required");
        if (!repo?.trim()) throw new Error("repo path is required");
        if (ws.jobs.plan.state === "running" || ws.jobs.run.state === "running") {
          throw new Error("a job is already running in this workspace");
        }
        spawnJob(ws, "plan", opts.factory, ["plan", goal.trim(), "--repo", repo.trim()]);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      try {
        const { slots } = JSON.parse(await readBody(req)) as { slots?: number };
        if (ws.jobs.run.state === "running") throw new Error("a run is already in progress");
        const args = ["run"];
        if (slots && Number.isFinite(slots) && slots > 0) args.push("--slots", String(slots));
        spawnJob(ws, "run", opts.factory, args);
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
            .map((f) => ({ file: f, content: readFileSync(join(backlogDir, f), "utf-8") }))
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
      `dashboard: http://${opts.host}:${opts.port}  ` +
        `(${registry.workspaces.size} workspace(s), registry: ${registry.file})`,
    );
  });
}

main();

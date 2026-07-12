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

import { spawn, type ChildProcess } from "node:child_process";
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
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
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

/**
 * A live preview of the built product. One per workspace: starting a new one
 * stops the old. `web` runs the repo's own dev server (npm run dev|start|…) and
 * scrapes the localhost URL it prints; `static` serves a plain index.html tree
 * ourselves on an ephemeral port. The browser tab is opened by the CLIENT (it
 * already runs in a browser) — the server only hands back the URL.
 */
interface Preview {
  kind: "web" | "static" | "none";
  state: "idle" | "starting" | "ready" | "error";
  url: string | null;
  output: string;
  repo: string | null;
  proc: ChildProcess | null;
  server: Server | null;
}

interface Workspace {
  name: string;
  workdir: string;
  tailer: RunTailer;
  jobs: { plan: Job; run: Job; chat: Job; doctor: Job };
  preview: Preview;
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
        doctor: { state: "idle", output: "" },
      },
      preview: { kind: "none", state: "idle", url: null, output: "", repo: null, proc: null, server: null },
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
  kind: "plan" | "run" | "chat" | "doctor",
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

/** Run one command to completion (no shell — args reach the exe as real argv). */
function runCmd(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => resolvePromise({ code: -1, output: String(err) }));
    child.on("exit", (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

/* ------------------------------ live preview ------------------------------ */

/** What can we open in a browser for this repo, and how? */
function detectPreview(repo: string): { kind: Preview["kind"]; script?: string } {
  const pkgPath = join(repo, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      // A dev server first (hot reload); a plain start/serve otherwise.
      for (const name of ["dev", "start", "serve", "preview"]) {
        if (typeof scripts[name] === "string") return { kind: "web", script: name };
      }
    } catch {
      // malformed package.json — fall through to the static check
    }
  }
  for (const idx of ["index.html", "public/index.html", "dist/index.html", "build/index.html"]) {
    if (existsSync(join(repo, idx))) return { kind: "static" };
  }
  return { kind: "none" };
}

/** Kill a child and everything it spawned (npm → node → …). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM"); // negative pid → the process group
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function stopPreview(ws: Workspace): void {
  if (ws.preview.proc) {
    killTree(ws.preview.proc);
    ws.preview.proc = null;
  }
  if (ws.preview.server) {
    try {
      ws.preview.server.close();
    } catch {
      /* already closing */
    }
    ws.preview.server = null;
  }
  ws.preview.state = "idle";
  ws.preview.url = null;
}

// First localhost URL a dev server prints — how we learn which port it chose.
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?\/?\S*/i;

// npm is npm.cmd on Windows; a .cmd needs a shell to launch. The commands are
// fixed and any script name is one of our four hard-coded values, so no user
// text reaches the shell.
function npmSpawn(repo: string, args: string[]): ChildProcess {
  const isWin = process.platform === "win32";
  return spawn(isWin ? "npm.cmd" : "npm", args, {
    cwd: repo,
    shell: isWin,
    windowsHide: true,
    detached: !isWin, // its own process group on POSIX, so killTree gets the tree
    // BROWSER=none stops CRA/others from opening a browser on the server host —
    // the operator's own browser opens the tab instead.
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1" },
  });
}

/**
 * A freshly-merged repo has no node_modules at its root (agents installed inside
 * their worktrees), so a dev server would fail with "vite: not found". Install
 * first when they're missing, then boot.
 */
function startWebPreview(ws: Workspace, repo: string, script: string): void {
  if (existsSync(join(repo, "node_modules"))) {
    spawnDevServer(ws, repo, script);
    return;
  }
  ws.preview.output = "Installing dependencies (first preview only)…\n";
  const install = npmSpawn(repo, ["install"]);
  ws.preview.proc = install;
  const onData = (chunk: Buffer): void => {
    ws.preview.output = (ws.preview.output + chunk.toString("utf-8")).slice(-8000);
  };
  install.stdout?.on("data", onData);
  install.stderr?.on("data", onData);
  install.on("error", (err) => {
    ws.preview.state = "error";
    ws.preview.output += `\n${String(err)}`;
  });
  install.on("exit", (code) => {
    ws.preview.proc = null;
    if (ws.preview.state !== "starting") return; // stopped by the operator
    if (code === 0) {
      spawnDevServer(ws, repo, script);
    } else {
      ws.preview.state = "error";
      ws.preview.output += `\n(dependency install failed with code ${code})`;
    }
  });
}

function spawnDevServer(ws: Workspace, repo: string, script: string): void {
  const child = npmSpawn(repo, ["run", script]);
  ws.preview.proc = child;
  const onData = (chunk: Buffer): void => {
    ws.preview.output = (ws.preview.output + chunk.toString("utf-8")).slice(-8000);
    if (ws.preview.state === "starting") {
      const match = ws.preview.output.match(LOCAL_URL);
      if (match) {
        ws.preview.url = match[0].replace("0.0.0.0", "localhost").replace(/\/$/, "");
        ws.preview.state = "ready";
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (err) => {
    ws.preview.state = "error";
    ws.preview.output += `\n${String(err)}`;
  });
  child.on("exit", (code) => {
    if (ws.preview.state === "starting") {
      ws.preview.state = "error";
      ws.preview.output += `\n(the dev server exited with code ${code} before serving a page)`;
    } else if (ws.preview.state === "ready") {
      ws.preview.state = "idle"; // it was killed (Stop) or crashed after serving
      ws.preview.url = null;
    }
    ws.preview.proc = null;
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".map": "application/json", ".txt": "text/plain", ".wasm": "application/wasm",
};

function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  try {
    let pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const filePath = resolve(join(root, pathname));
    if (filePath !== resolve(root) && !filePath.startsWith(resolve(root) + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const serveFile = (file: string): void => {
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    };
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      serveFile(filePath);
      return;
    }
    // SPA fallback: unknown paths render index.html so client routing works.
    const index = join(root, "index.html");
    if (existsSync(index)) {
      serveFile(index);
      return;
    }
    res.writeHead(404).end("not found");
  } catch {
    res.writeHead(500).end("error");
  }
}

function startStaticServer(ws: Workspace, repo: string): void {
  const root = existsSync(join(repo, "index.html")) ? repo
    : existsSync(join(repo, "public", "index.html")) ? join(repo, "public")
    : existsSync(join(repo, "dist", "index.html")) ? join(repo, "dist")
    : join(repo, "build");
  const srv = createServer((req, res) => serveStatic(root, req, res));
  srv.on("error", (err) => {
    ws.preview.state = "error";
    ws.preview.output += `\n${String(err)}`;
  });
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    ws.preview.url = `http://localhost:${port}`;
    ws.preview.state = "ready";
    ws.preview.output = `serving ${root}`;
  });
  ws.preview.server = srv;
}

function startPreview(ws: Workspace, repo: string): Preview["kind"] {
  stopPreview(ws); // one preview per workspace
  const detected = detectPreview(repo);
  ws.preview = {
    kind: detected.kind, state: "starting", url: null, output: "", repo, proc: null, server: null,
  };
  if (detected.kind === "web" && detected.script) {
    startWebPreview(ws, repo, detected.script);
  } else if (detected.kind === "static") {
    startStaticServer(ws, repo);
  } else {
    ws.preview.state = "error";
    ws.preview.output =
      "No web dev script (dev/start/serve/preview) and no index.html — nothing to open in a browser.";
  }
  return detected.kind;
}

const BOOTSTRAP_GITIGNORE = [
  "__pycache__/",
  "*.pyc",
  ".venv/",
  "node_modules/",
  "dist/",
  ".env",
  "",
].join("\n");

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
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store", // dev tool: a plain refresh must always be current
      });
      res.end(readFileSync(join(publicDir, "index.html")));
      return;
    }
    if (url.pathname === "/client.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
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

    /* ---------------- repo tools (path-based, workspace-independent) ---------------- */

    if (url.pathname === "/api/repo/init" && req.method === "POST") {
      try {
        const { path } = JSON.parse(await readBody(req)) as { path?: string };
        if (!path?.trim()) throw new Error("path is required");
        const dir = resolve(path.trim());
        if (existsSync(join(dir, ".git"))) throw new Error("already a git repository");
        mkdirSync(dir, { recursive: true });
        const init = await runCmd("git", ["init", "-b", "main"], dir);
        if (init.code !== 0) throw new Error(init.output.trim());
        if (!existsSync(join(dir, ".gitignore"))) {
          writeFileSync(join(dir, ".gitignore"), BOOTSTRAP_GITIGNORE, "utf-8");
        }
        await runCmd("git", ["add", "-A"], dir);
        const commit = await runCmd(
          "git",
          ["commit", "-m", "chore: initial commit (agent-factory bootstrap)"],
          dir,
        );
        if (commit.code !== 0) throw new Error(commit.output.trim());
        json(res, 200, { ok: true, output: `initialized ${dir} on branch main` });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/repo/publish" && req.method === "POST") {
      try {
        const { path, visibility } = JSON.parse(await readBody(req)) as {
          path?: string;
          visibility?: string;
        };
        if (!path?.trim() || !existsSync(join(resolve(path.trim()), ".git"))) {
          throw new Error("path must be an existing git repository");
        }
        if (visibility !== "private" && visibility !== "public") {
          throw new Error("visibility must be private or public");
        }
        const dir = resolve(path.trim());
        const result = await runCmd(
          "gh",
          ["repo", "create", basename(dir), `--${visibility}`, "--source=.", "--push"],
          dir,
        );
        if (result.code !== 0) throw new Error(result.output.trim() || "gh failed — is it installed and logged in?");
        json(res, 200, { ok: true, output: result.output.trim() });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/repo/visibility" && req.method === "POST") {
      try {
        const { path, visibility } = JSON.parse(await readBody(req)) as {
          path?: string;
          visibility?: string;
        };
        if (!path?.trim() || !existsSync(join(resolve(path.trim()), ".git"))) {
          throw new Error("path must be an existing git repository");
        }
        if (visibility !== "private" && visibility !== "public") {
          throw new Error("visibility must be private or public");
        }
        const dir = resolve(path.trim());
        // Newer gh requires an explicit consent flag for visibility changes;
        // older gh rejects it as unknown — try with, fall back without.
        let result = await runCmd(
          "gh",
          ["repo", "edit", "--visibility", visibility, "--accept-visibility-change-consequences"],
          dir,
        );
        if (result.code !== 0 && /unknown flag/i.test(result.output)) {
          result = await runCmd("gh", ["repo", "edit", "--visibility", visibility], dir);
        }
        if (result.code !== 0) throw new Error(result.output.trim() || "gh failed — is it installed and logged in?");
        json(res, 200, { ok: true, output: result.output.trim() || `repository is now ${visibility}` });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    /* ---------------- repo explorer (read-only git views + guarded switch) ---------------- */

    if (url.pathname.startsWith("/api/repo/") && req.method === "GET") {
      const repo = resolve(url.searchParams.get("repo") ?? "");
      if (!repo || !existsSync(join(repo, ".git"))) {
        json(res, 400, { ok: false, error: "repo must be an existing git repository" });
        return;
      }
      const ref = url.searchParams.get("ref") ?? "HEAD";
      if (!/^[\w./@^~-]+$/.test(ref)) {
        json(res, 400, { ok: false, error: "bad ref" });
        return;
      }

      if (url.pathname === "/api/repo/tree") {
        const result = await runCmd("git", ["ls-tree", "-r", "--name-only", ref], repo);
        if (result.code !== 0) {
          json(res, 400, { ok: false, error: result.output.trim() });
          return;
        }
        json(res, 200, { files: result.output.split("\n").filter(Boolean) });
        return;
      }
      if (url.pathname === "/api/repo/file") {
        const file = url.searchParams.get("path") ?? "";
        if (!file || file.includes("..")) {
          json(res, 400, { ok: false, error: "bad path" });
          return;
        }
        const result = await runCmd("git", ["show", `${ref}:${file}`], repo);
        if (result.code !== 0) {
          json(res, 404, { ok: false, error: result.output.trim() });
          return;
        }
        json(res, 200, { content: result.output.slice(0, 200_000), path: file });
        return;
      }
      if (url.pathname === "/api/repo/branches") {
        const branches = await runCmd("git", ["branch", "--format=%(refname:short)"], repo);
        const current = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo);
        json(res, 200, {
          branches: branches.output.split("\n").filter(Boolean),
          current: current.output.trim(),
        });
        return;
      }
      if (url.pathname === "/api/repo/log") {
        const result = await runCmd(
          "git",
          ["log", "--format=%h%x09%ad%x09%an%x09%s", "--date=relative", "-n", "60", ref],
          repo,
        );
        const commits = result.output
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [hash, date, author, ...subject] = line.split("\t");
            return { hash, date, author, subject: subject.join("\t") };
          });
        json(res, 200, { commits });
        return;
      }
      if (url.pathname === "/api/repo/diff") {
        // ?commit=<hash> shows one commit; ?from=&to= compares two refs
        const commit = url.searchParams.get("commit");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        let args: string[];
        if (commit && /^[\w^~]+$/.test(commit)) {
          args = ["show", commit, "--stat", "--patch"];
        } else if (from && to && /^[\w./@^~-]+$/.test(from) && /^[\w./@^~-]+$/.test(to)) {
          args = ["diff", `${from}..${to}`, "--stat", "--patch"];
        } else {
          json(res, 400, { ok: false, error: "pass ?commit= or ?from=&to=" });
          return;
        }
        const result = await runCmd("git", args, repo);
        json(res, 200, { diff: result.output.slice(0, 400_000) });
        return;
      }
    }

    if (url.pathname === "/api/repo/switch" && req.method === "POST") {
      try {
        const { path, branch } = JSON.parse(await readBody(req)) as {
          path?: string;
          branch?: string;
        };
        const repo = resolve(path ?? "");
        if (!repo || !existsSync(join(repo, ".git"))) {
          throw new Error("repo must be an existing git repository");
        }
        if (!branch || !/^[\w./-]+$/.test(branch)) throw new Error("bad branch name");
        // A run's merge queue targets the checked-out branch: never switch mid-run.
        const running = [...registry.workspaces.values()].some(
          (w) => w.jobs.run.state === "running",
        );
        if (running) throw new Error("refusing to switch branches while a run is in progress");
        const result = await runCmd("git", ["switch", branch], repo);
        if (result.code !== 0) throw new Error(result.output.trim());
        json(res, 200, { ok: true, output: `now on ${branch}` });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
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

    if (url.pathname === "/api/config" && req.method === "GET") {
      const file = join(ws.workdir, "factory.yaml");
      json(res, 200, {
        content: existsSync(file) ? readFileSync(file, "utf-8") : "",
        path: file,
      });
      return;
    }
    if (url.pathname === "/api/config" && req.method === "PUT") {
      try {
        const { content } = JSON.parse(await readBody(req)) as { content?: string };
        if (typeof content !== "string" || !content.trim()) {
          throw new Error("config cannot be empty");
        }
        writeFileSync(join(ws.workdir, "factory.yaml"), content, "utf-8");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
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
        doctor: ws.jobs.doctor,
        backlogCount: backlog,
        currentRun: ws.tailer.run,
        workspace: ws.name,
      });
      return;
    }

    if (url.pathname === "/api/doctor" && req.method === "POST") {
      try {
        if (ws.jobs.doctor.state === "running") throw new Error("a capability check is already running");
        spawnJob(ws, "doctor", opts.factory, ["doctor"]);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    /* ---------------- live preview of the built product ---------------- */

    if (url.pathname === "/api/preview/detect" && req.method === "GET") {
      const repo = resolve(url.searchParams.get("repo") ?? "");
      if (!repo || !existsSync(repo)) {
        json(res, 400, { ok: false, error: "repo path does not exist" });
        return;
      }
      json(res, 200, detectPreview(repo));
      return;
    }
    if (url.pathname === "/api/preview" && req.method === "GET") {
      json(res, 200, {
        kind: ws.preview.kind,
        state: ws.preview.state,
        url: ws.preview.url,
        output: ws.preview.output.slice(-2000),
      });
      return;
    }
    if (url.pathname === "/api/preview" && req.method === "POST") {
      try {
        const { repo } = JSON.parse(await readBody(req)) as { repo?: string };
        const dir = resolve(repo ?? "");
        if (!dir || !existsSync(dir)) throw new Error("repo path does not exist");
        const kind = startPreview(ws, dir);
        json(res, 200, { ok: true, kind });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/preview/stop" && req.method === "POST") {
      stopPreview(ws);
      json(res, 200, { ok: true });
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

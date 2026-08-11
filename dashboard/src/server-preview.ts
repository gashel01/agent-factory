/* Extracted from server.ts — mechanical split (pure move + import/export wiring). */

import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync, createReadStream, existsSync, mkdirSync,
  readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import type { Capsule, CapsuleAction, CapsuleConsent, CapsuleStep, CapsuleActionState, CapsuleView } from "./types.js";
import { extractCapsule, extractConsents, parseVerdict } from "./capsule-core.js";
import {
  type Workspace, type Preview, type CapsuleRun, type ServiceRun, type JudgeResult, type CapsuleRuntime,
  workspaceRepo, saveGrants,
} from "./server-core.js";


/* ------------------------------ live preview ------------------------------ */

/** What can we open in a browser for this repo, and how? */
export function detectPreview(repo: string): { kind: Preview["kind"]; script?: string } {
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
export function killTree(child: ChildProcess): void {
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


export function stopPreview(ws: Workspace): void {
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
export const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?\/?\S*/i;


// npm is npm.cmd on Windows; a .cmd needs a shell to launch. The commands are
// fixed and any script name is one of our four hard-coded values, so no user
// text reaches the shell.
export function npmSpawn(repo: string, args: string[]): ChildProcess {
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
export function startWebPreview(ws: Workspace, repo: string, script: string): void {
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


export function spawnDevServer(ws: Workspace, repo: string, script: string): void {
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


export const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".map": "application/json", ".txt": "text/plain", ".wasm": "application/wasm",
};


export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
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


export function startStaticServer(ws: Workspace, repo: string): void {
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


export function startPreview(ws: Workspace, repo: string): Preview["kind"] {
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


export const BOOTSTRAP_GITIGNORE = [
  "__pycache__/",
  "*.pyc",
  ".venv/",
  "node_modules/",
  "dist/",
  ".env",
  ".factory/", // the factory's own workspace state, when it lives inside the repo
  "",
].join("\n");


/** Starter factory.yaml written when a project is created, so a new workspace is
 *  never born tool-less (the agents need their toolchain allow-listed, or every
 *  `npm`/`npx`/`node` call is refused and the agent blocks). The allow-list covers
 *  git + the common Node and Python toolchains; tighten it later in Settings. */
export function starterFactoryYaml(): string {
  const tools = [
    "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)",
    "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(npm install:*)", "Bash(npm ci:*)", "Bash(npm test:*)",
    "Bash(npm run:*)", "Bash(npx:*)", "Bash(node:*)",
    "Bash(uv sync:*)", "Bash(uv run:*)", "Bash(pytest:*)",
    "Bash(python:*)", "Bash(ruff:*)",
  ];
  return [
    "# Starter config, created with the project. Tighten the allow-list in Settings.",
    "repo_defaults:",
    "  base_branch: main",
    "",
    "concurrency:",
    "  max_slots: 3",
    "  stagger_seconds: 15",
    "  max_retries: 1",
    "",
    "agent:",
    "  command: claude",
    "  permission_mode: acceptEdits",
    "  allowed_tools:",
    ...tools.map((t) => `    - "${t}"`),
    "",
    "setup:",
    "  commands: []",
    "  timeout_s: 600",
    "",
    "review:",
    "  enabled: false",
    "  model: haiku",
    "  timeout_min: 10",
    "",
    "supervisor:",
    '  allowed_tools: ["Read", "Glob", "Grep", "Write", "Edit"]',
    "",
  ].join("\n");
}


/** Ignore a path LOCALLY via .git/info/exclude — NOT the tracked .gitignore — so
 *  a project's own `.factory/` state stays out of `git status` without leaving the
 *  repo dirty. A run's preflight refuses ANY uncommitted change (even an untracked
 *  file), so touching a tracked file here would block every run. */
export function excludeLocally(repoDir: string, entry: string): void {
  const info = join(repoDir, ".git", "info");
  if (!existsSync(info)) return; // not a (normal) git repo yet — nothing to exclude
  const excl = join(info, "exclude");
  try {
    const cur = existsSync(excl) ? readFileSync(excl, "utf-8") : "";
    if (cur.split(/\r?\n/).some((l) => l.trim() === entry.trim())) return;
    writeFileSync(excl, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + entry + "\n", "utf-8");
  } catch {
    /* a locked exclude file never blocks project creation */
  }
}


/** The project's capsule.json path: the existing one (repo root, then repo/.factory,
 *  then the workspace dir), else the default write target (workspace dir, git-excluded). */
export function capsuleFile(ws: Workspace): string {
  const repo = workspaceRepo(ws);
  const candidates: string[] = [];
  if (repo) candidates.push(join(repo, "capsule.json"), join(repo, ".factory", "capsule.json"));
  candidates.push(join(ws.workdir, "capsule.json"));
  return candidates.find((f) => existsSync(f)) ?? join(ws.workdir, "capsule.json");
}

export function loadCapsule(ws: Workspace): Capsule | null {
  const f = capsuleFile(ws);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf-8")) as Capsule; } catch { return null; }
}


/** Effective env for a HOST step: process env + every granted consent's env,
 *  with granted PATH additions prepended. Container steps stay hermetic (only
 *  their declared env, passed via -e) — host paths would be meaningless there. */
export function capsuleEnv(ws: Workspace, capsule: Capsule, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  const extraPath: string[] = [];
  for (const c of capsule.consents ?? []) {
    if (!(c.granted || ws.capsule.grants.has(c.id))) continue;
    Object.assign(env, c.facts.env ?? {});
    for (const p of c.facts.path ?? []) extraPath.push(p);
  }
  Object.assign(env, extra ?? {});
  if (extraPath.length) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[key] = [...extraPath, env[key] ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
  }
  return env;
}


/** Spawn one step on its runner. host → the OS shell; container → `docker run`
 *  with the repo mounted at /work. */
export function spawnStep(ws: Workspace, capsule: Capsule, step: CapsuleStep, repo: string): ChildProcess {
  const runner = capsule.runners?.[step.on ?? "default"] ?? { kind: "host" as const };
  if (runner.kind === "container") {
    const image = runner.image ?? "alpine";
    const containerCwd = "/work" + (step.cwd ? "/" + step.cwd.replace(/\\/g, "/") : "");
    const eArgs: string[] = [];
    for (const [k, v] of Object.entries(step.env ?? {})) eArgs.push("-e", `${k}=${v}`);
    return spawn("docker",
      ["run", "--rm", "-v", `${repo}:/work`, "-w", containerCwd, ...eArgs, image, "sh", "-lc", step.run],
      { windowsHide: true });
  }
  const cwd = step.cwd ? join(repo, step.cwd) : repo;
  const env = capsuleEnv(ws, capsule, step.env);
  // shell:true runs the command line through the OS shell (cmd on Windows, sh
  // elsewhere), handling quoting/`.\gradlew.bat` resolution cross-platform.
  return spawn(step.run, { cwd, env, shell: true, windowsHide: true });
}


// Sentinel exit code: a one-shot step that behaves like a long-running server.
export const LOOKS_LIKE_SERVICE = -2;

// Extra "this is a server/watcher" signals beyond a printed localhost URL.
export const SERVER_READY = /(listening on|server (running|started|listening)|ready in \d|now listening|watching for( file)? changes|waiting for changes|watch mode|nodemon)/i;

export const GUARD_GRACE_MS = 8000;


/** Run one step, streaming combined output into `run`; resolves the exit code.
 *  When `guard` is set (one-shot actions), a step that prints a server/watcher
 *  signal and is STILL alive after a grace period is treated as a mislabeled
 *  service: it is killed and resolves LOOKS_LIKE_SERVICE, so the action fails
 *  fast with guidance instead of hanging in "running" forever. */
export function runStep(run: CapsuleRun, ws: Workspace, capsule: Capsule, step: CapsuleStep, repo: string, guard = false): Promise<number> {
  return new Promise((r) => {
    run.output = (run.output + `\n$ ${step.run}\n`).slice(-20000);
    const child = spawnStep(ws, capsule, step, repo);
    run.proc = child;
    let settled = false;
    let guardTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (guardTimer) clearTimeout(guardTimer);
      r(code);
    };
    const onData = (d: Buffer): void => {
      run.output = (run.output + d.toString("utf-8")).slice(-20000);
      if (guard && !guardTimer && (LOCAL_URL.test(run.output) || SERVER_READY.test(run.output))) {
        guardTimer = setTimeout(() => {
          if (settled) return;
          const url = LOCAL_URL.exec(run.output)?.[0] ?? "";
          run.output += `\n(guard: still running${url ? ` and serving ${url}` : ""} after ${GUARD_GRACE_MS / 1000}s — this looks like a long-running server/watcher, not a one-shot step)`;
          killTree(child);
          finish(LOOKS_LIKE_SERVICE);
        }, GUARD_GRACE_MS);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => { run.output += `\n${String(e)}`; finish(1); });
    child.on("exit", (code) => { run.proc = null; finish(code ?? 1); });
  });
}


/** Run an action's steps in order (retries + service guard); true if all passed.
 *  Shared by a normal run and the post-fix re-verification. */
export async function runActionSteps(run: CapsuleRun, ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<boolean> {
  for (const step of action.steps) {
    let code = await runStep(run, ws, capsule, step, repo, true);
    for (let a = 0; code !== 0 && code !== LOOKS_LIKE_SERVICE && a < (step.retries ?? 0); a++) {
      run.output += `\n(retrying: ${step.run} — attempt ${a + 2})`;
      code = await runStep(run, ws, capsule, step, repo, true);
    }
    if (code === LOOKS_LIKE_SERVICE) {
      run.output += '\n(This action looks like a long-running server/watcher. Set "service": true on it in the capsule so it runs as a live service — embedded preview + Stop — instead of a one-shot step that never finishes.)';
      return false;
    }
    if (code !== 0) { run.output += `\n(step failed → exit ${code})`; return false; }
  }
  return true;
}


/** Run an action's steps; gate the action's state on exit code. */
export async function runCapsuleAction(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<void> {
  const run: CapsuleRun = { state: "running", output: "", proc: null };
  ws.capsule.runs.set(action.id, run);
  if (action.consent) {
    const c = (capsule.consents ?? []).find((x) => x.id === action.consent);
    if (c && !(c.granted || ws.capsule.grants.has(c.id))) {
      run.state = "error"; run.output += `\n(blocked: needs consent "${action.consent}")`; return;
    }
  }
  run.state = (await runActionSteps(run, ws, capsule, action, repo)) ? "ok" : "error";
}


/** Execute a consent's provisioning steps (after the user approved the facts),
 *  then record the grant so host steps inherit its env/path. */
export async function runCapsuleConsent(ws: Workspace, capsule: Capsule, consent: CapsuleConsent, repo: string): Promise<CapsuleRun> {
  const run: CapsuleRun = { state: "running", output: "", proc: null };
  ws.capsule.runs.set(`consent:${consent.id}`, run);
  for (const step of consent.steps ?? []) {
    const code = await runStep(run, ws, capsule, step, repo);
    if (code !== 0) { run.state = "error"; run.output += `\n(consent step failed → exit ${code})`; return run; }
  }
  run.state = "ok";
  ws.capsule.grants.add(consent.id);
  saveGrants(ws);
  return run;
}


/** Stop a running service action (kills the whole process tree). */
export function stopService(ws: Workspace, id: string): void {
  const svc = ws.capsule.services.get(id);
  if (!svc) return;
  if (svc.proc) { killTree(svc.proc); svc.proc = null; }
  svc.state = "stopped";
  svc.url = null;
}


/** Start a long-running service action: run the prep steps to completion, then
 *  keep the final step alive and capture the URL it prints. */
export async function startService(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<void> {
  stopService(ws, action.id); // replace any prior instance
  const svc: ServiceRun = { state: "starting", url: null, output: "", proc: null };
  ws.capsule.services.set(action.id, svc);
  if (action.consent) {
    const c = (capsule.consents ?? []).find((x) => x.id === action.consent);
    if (c && !(c.granted || ws.capsule.grants.has(c.id))) {
      svc.state = "error"; svc.output += `\n(blocked: needs consent "${action.consent}")`; return;
    }
  }
  const steps = action.steps;
  for (let i = 0; i < steps.length - 1; i++) {
    const prep: CapsuleRun = { state: "running", output: svc.output, proc: null };
    const code = await runStep(prep, ws, capsule, steps[i]!, repo);
    svc.output = prep.output;
    if (svc.state !== "starting") return; // stopped mid-prep
    if (code !== 0) { svc.state = "error"; svc.output += `\n(prep step failed → exit ${code})`; return; }
  }
  const last = steps[steps.length - 1];
  if (!last) { svc.state = "error"; svc.output += "\n(no server step)"; return; }
  svc.output = (svc.output + `\n$ ${last.run}\n`).slice(-20000);
  const child = spawnStep(ws, capsule, last, repo);
  svc.proc = child;
  const re = action.urlRegex ? new RegExp(action.urlRegex) : LOCAL_URL;
  const onData = (d: Buffer): void => {
    svc.output = (svc.output + d.toString("utf-8")).slice(-20000);
    if (svc.state === "starting") {
      const m = re.exec(svc.output);
      if (m) { svc.state = "live"; svc.url = (m[1] ?? m[0]).replace("0.0.0.0", "localhost").replace(/\/+$/, ""); }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => { svc.output += `\n${String(e)}`; svc.state = "error"; svc.proc = null; });
  child.on("exit", (code) => {
    svc.proc = null;
    if (svc.state !== "stopped") { svc.state = svc.state === "live" ? "stopped" : "error"; svc.output += `\n(server exited → ${code})`; }
  });
}


/** Run a shell command to completion and capture its output (probes, device lists). */
export function captureShell(runStr: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((r) => {
    const child = spawn(runStr, { cwd, env, shell: true, windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf-8")));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString("utf-8")));
    child.on("error", () => r({ code: 1, out }));
    child.on("exit", (code) => r({ code: code ?? 1, out }));
  });
}


/** Toolchain doctor: each probe that exits 0 is "present" (host effective env). */
export async function capsuleDoctor(ws: Workspace, capsule: Capsule, repo: string): Promise<Record<string, boolean>> {
  const env = capsuleEnv(ws, capsule);
  const out: Record<string, boolean> = {};
  await Promise.all((capsule.doctor ?? []).map(async (d) => {
    const { code } = await captureShell(d.probe, repo, env);
    out[d.id] = code === 0;
  }));
  return out;
}


/** Enumerate connected devices for a device-install action (generic: run the
 *  declared list command, capture id per line via the declared regex). */
export async function capsuleDevices(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<string[]> {
  if (action.surface !== "device-install" || !action.device) return [];
  const { out } = await captureShell(action.device.listCmd, repo, capsuleEnv(ws, capsule));
  const re = new RegExp(action.device.listRegex);
  const ids: string[] = [];
  for (const line of out.split(/\r?\n/)) { const m = re.exec(line.trim()); if (m?.[1]) ids.push(m[1]); }
  return ids;
}


/** Assemble the runtime view the dashboard polls. */
export async function capsuleView(ws: Workspace): Promise<CapsuleView> {
  const capsule = loadCapsule(ws);
  if (!capsule) return { capsule: null, doctor: {}, runs: {}, grants: [...ws.capsule.grants], devices: {}, services: {} };
  const repo = workspaceRepo(ws) ?? ws.workdir;
  const [doctor, deviceEntries] = await Promise.all([
    capsuleDoctor(ws, capsule, repo),
    Promise.all(capsule.actions
      .filter((a) => a.surface === "device-install")
      .map(async (a) => [a.id, await capsuleDevices(ws, capsule, a, repo)] as const)),
  ]);
  const runs: Record<string, CapsuleActionState> = {};
  for (const a of capsule.actions) {
    const r = ws.capsule.runs.get(a.id);
    runs[a.id] = {
      state: r?.state ?? "idle",
      output: (r?.output ?? "").slice(-8000),
      artifactReady: !!(a.artifact && existsSync(join(repo, a.artifact))),
    };
  }
  const grants = new Set(ws.capsule.grants);
  for (const c of capsule.consents ?? []) if (c.granted) grants.add(c.id);
  const services: Record<string, { state: ServiceRun["state"]; url: string | null }> = {};
  for (const a of capsule.actions) {
    if (!a.service) continue;
    const s = ws.capsule.services.get(a.id);
    services[a.id] = { state: s?.state ?? "stopped", url: s?.url ?? null };
  }
  return { capsule, doctor, runs, grants: [...grants], devices: Object.fromEntries(deviceEntries), services };
}


/* ---------------------------- capsule onboarding ----------------------------
 * The "how" is decided ONCE, by an agent, then frozen: a read-only Claude Code
 * agent inspects the repo and emits a capsule.json. Nothing here knows any app
 * type — the agent figures it out and writes it as data. The result is a DRAFT
 * the human reviews (and any host mutation stays behind a consent). */

export function onboardingPrompt(): string {
  return [
    'You are the onboarding agent for "Agent Factory", a dashboard that renders a generic project "cockpit" from a capsule.json manifest. Inspect THIS repository (read-only) and emit a capsule.json describing how to build / test / run it, plus the controls to show.',
    "",
    "The host OS is Windows (win32); node, npm and python are on PATH. Prefer runner \"host\" with commands that work on this machine. Use a \"container\" runner (with an \"image\") only for a hermetic build you are confident about.",
    "",
    "Capsule schema (JSON):",
    '{ "version":1, "name":str, "summary":str,',
    '  "doctor":[{"id","label","probe": a shell command that exits 0 when the tool is present}],',
    '  "actions":[{"id","label","description": one concise line (what it does / when to use it, <=100 chars),"icon"?:"play"|"smartphone"|"external"|"eye","primary"?:bool,"group"?: short section heading this action sits under,"steps":[{"run": shell cmd,"cwd"?:relative,"retries"?:int}],"surface"?:"log-stream"|"device-install"|"preview"|"link","service"?:bool,"artifact"?:relative path,"url"?:string (use ${lan} for the LAN base),"consent"?:consentId}],',
    '  "consents":[{"id","title","summary","facts":{"downloads":[{"url","sha256"?}],"writes":[],"env":{},"path":[],"commands":[]},"granted"?:bool}] }',
    "",
    "Guidance: add doctor checks for the toolchain; add actions for the real lifecycle (install deps, build, test, lint, typecheck). Give EVERY action a short \"description\" that explains plainly what it does and when to use it (e.g. dev vs preview: \"Live-reloading dev server for coding\" vs \"Serves the production build to verify the real output\"). Cluster related actions under a shared \"group\" heading so the cockpit reads as labelled sections, not a flat wall — good groups are things like \"Setup\" (install deps), \"Checks\" (test / lint / typecheck), \"Build & run\", and a project-ops group; aim for 2-5 groups with a handful of actions each, in the order you'd use them. Give every action a group once there are more than a few; a tiny project (2-3 actions) can skip groups. CRITICAL — services: the engine runs each step to completion and gates on its exit code. So ANY action whose final command does NOT exit on its own MUST be marked \"service\":true (with \"surface\":\"preview\"); otherwise it would hang forever as a broken \"running\" action. A command is a service if it stays in the foreground serving/watching. Treat these as services WITHOUT EXCEPTION: dev servers (`vite`, `next dev`, `npm run dev`, `webpack serve`, `ng serve`), preview servers (`vite preview`, `serve`), watch modes (anything with `--watch`/`-w`, `vitest` without `run`, `jest --watch`, `tsc --watch`, `nodemon`, `--hot`), and backend servers (`uvicorn`, `gunicorn`, `flask run`, `python -m http.server`, `rails s`, `go run` of an HTTP server, `docker compose up` without `-d`). Conversely, one-shot commands that exit (`npm ci/install`, `npm run build`, `npm test`/`vitest run`, `tsc -b`, `pytest`, linters) are NOT services. If a command COULD stay running and you are unsure, mark it a service. For services, bind all interfaces and a fixed port when the tool allows (e.g. `--host --port 5173`), and the engine keeps the last step alive, captures the localhost URL it prints, and shows an embedded live preview + a Stop control. Mark the most useful action primary:true. Add a consent ONLY if a genuine host install is required (list its raw facts). Keep commands correct for THIS repo (read package.json / pyproject.toml / Makefile / scripts).",
    "",
    "Example (a Node web app):",
    '```json',
    '{"version":1,"name":"My API","summary":"Express REST API.","doctor":[{"id":"node","label":"NODE","probe":"node --version"}],"actions":[{"id":"install","label":"Install deps","description":"Install npm dependencies (run once, or after package.json changes).","group":"Setup","steps":[{"run":"npm install"}]},{"id":"test","label":"Test","description":"Run the unit test suite.","icon":"play","primary":true,"group":"Checks","steps":[{"run":"npm test"}]},{"id":"build","label":"Build","description":"Compile the production bundle into dist/.","group":"Build & run","steps":[{"run":"npm run build"}]}]}',
    '```',
    "",
    "Output: reply with ONLY one ```json fenced block containing the capsule for THIS repo. No other text.",
  ].join("\n");
}


/** Run the onboarding agent to generate this project's capsule.json (a draft). */
export function generateCapsule(ws: Workspace): void {
  const run: CapsuleRun = { state: "running", output: "Inspecting the repository…\n", proc: null };
  ws.capsule.runs.set("__generate__", run);
  const repo = workspaceRepo(ws) ?? ws.workdir;
  // claude is a .cmd shim on Windows → shell:true; the prompt goes via stdin so
  // no argv quoting is involved. Read-only tools only: it inspects, never mutates.
  const child = spawn("claude", ["-p", "--allowedTools", "Read,Glob,Grep"],
    { cwd: repo, shell: true, windowsHide: true, env: process.env });
  run.proc = child;
  let out = "";
  child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf-8"); run.output = ("Inspecting the repository…\n" + out).slice(-20000); });
  child.stderr?.on("data", (d: Buffer) => { run.output = (run.output + d.toString("utf-8")).slice(-20000); });
  const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 240_000);
  child.on("error", (e) => { clearTimeout(timer); run.proc = null; run.state = "error"; run.output += `\n${String(e)}`; });
  child.on("exit", () => {
    clearTimeout(timer); run.proc = null;
    const capsule = extractCapsule(out);
    if (!capsule) { run.state = "error"; run.output += "\n(could not parse a capsule from the agent output)"; return; }
    try {
      writeFileSync(capsuleFile(ws), JSON.stringify(capsule, null, 2), "utf-8");
      run.state = "ok"; run.output += `\n(wrote capsule.json — ${capsule.actions.length} action(s), ${(capsule.doctor ?? []).length} check(s))`;
    } catch (e) { run.state = "error"; run.output += `\n${String(e)}`; }
  });
  child.stdin?.write(onboardingPrompt());
  child.stdin?.end();
}


/* ---------------------------- auto-provision ----------------------------
 * When toolchain doctor checks fail, a read-only agent inspects the machine
 * and the repo and PROPOSES install consents (raw facts + steps). It never
 * installs: the user approves the facts, then the existing consent flow runs
 * the steps on the host. This productizes a manual "install the missing SDK". */

export function provisionPrompt(checks: Array<{ id: string; label: string; probe: string }>): string {
  const list = checks.map((c) => `- ${c.id} (${c.label}) — probe: ${c.probe}`).join("\n");
  return [
    "You are a provisioning agent for Agent Factory on Windows (win32). The project's toolchain doctor reports these checks FAILING (the probe exits non-zero):",
    list,
    "",
    "Inspect the machine (READ-ONLY — PATH, %ProgramFiles%, %LOCALAPPDATA%, D:\\, common SDK dirs) and the repo to determine what is genuinely missing and how to install it HEADLESSLY on this machine. Then output an install plan. DO NOT install anything yourself — only describe the plan; the user approves it before anything runs.",
    "",
    "Output ONLY one ```json fenced block: a JSON ARRAY of consent objects. Schema per consent:",
    '{ "id": kebab-id, "title": short, "summary": one line, "facts": { "downloads":[{"url","sha256"?}], "writes":[dirs created], "env":{VAR:val}, "path":[dirs added to PATH], "commands":[the exact commands, verbatim] }, "steps":[{"run": shell cmd, "cwd"?: relative}] }',
    "",
    "Rules: use OFFICIAL download URLs. Prefer canonical Windows locations (D:\\ when a large SDK needs space, else %LOCALAPPDATA%). `steps` are the REAL install commands run in order on the host once approved; `facts.env`/`facts.path` must be what makes the failing probe pass afterwards (e.g. set JAVA_HOME and add its bin to path). If a check only needs project dependencies (npm install, uv sync) rather than a system install, DO NOT propose a consent for it. If nothing genuinely needs installing, output an empty array [].",
  ].join("\n");
}


/** Run the provisioning agent over the failing doctor checks; merge the proposed
 *  (ungranted) consents into capsule.json for the user to review and approve. */
export async function generateProvision(ws: Workspace): Promise<void> {
  const run: CapsuleRun = { state: "running", output: "Diagnosing the toolchain…\n", proc: null };
  ws.capsule.runs.set("__provision__", run);
  const capsule = loadCapsule(ws);
  if (!capsule) { run.state = "error"; run.output += "\n(no capsule)"; return; }
  const repo = workspaceRepo(ws) ?? ws.workdir;
  const doctor = await capsuleDoctor(ws, capsule, repo);
  const failing = (capsule.doctor ?? []).filter((d) => doctor[d.id] === false);
  if (!failing.length) { run.state = "ok"; run.output += "\n(everything is present — nothing to provision)"; return; }
  run.output = `Diagnosing the toolchain…\nMissing: ${failing.map((f) => f.label).join(", ")}\nInspecting the machine…\n`;
  const out = await new Promise<string>((resolve) => {
    const child = spawn("claude", ["-p", "--allowedTools", "Read,Glob,Grep,Bash(where:*),Bash(dir:*)"],
      { cwd: repo, shell: true, windowsHide: true, env: process.env });
    run.proc = child;
    let acc = "";
    const onData = (d: Buffer): void => { acc += d.toString("utf-8"); run.output = (run.output + d.toString("utf-8")).slice(-20000); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 240_000);
    child.on("error", (e) => { clearTimeout(timer); run.output += `\n${String(e)}`; resolve(acc); });
    child.on("exit", () => { clearTimeout(timer); run.proc = null; resolve(acc); });
    child.stdin?.write(provisionPrompt(failing));
    child.stdin?.end();
  });
  const consents = extractConsents(out);
  if (!consents) { run.state = "error"; run.output += "\n(could not parse an install plan from the agent)"; return; }
  if (!consents.length) { run.state = "ok"; run.output += "\n(the agent found nothing that needs a system install)"; return; }
  // Merge as UNGRANTED (the user must approve the raw facts before anything runs).
  const byId = new Map((capsule.consents ?? []).map((c) => [c.id, c] as const));
  for (const c of consents) { c.granted = false; byId.set(c.id, c); }
  capsule.consents = [...byId.values()];
  try {
    writeFileSync(capsuleFile(ws), JSON.stringify(capsule, null, 2), "utf-8");
    run.state = "ok"; run.output += `\n(proposed ${consents.length} install plan(s): ${consents.map((c) => c.title).join(", ")} — review & approve them in the cockpit)`;
  } catch (e) { run.state = "error"; run.output += `\n${String(e)}`; }
}


/* ------------------------------- ask AI to fix -------------------------------
 * A failing one-shot action → an editing agent fixes the code, then the engine
 * RE-VERIFIES by re-running the action's own commands. The action only turns
 * green if that deterministic re-run passes — the agent can't self-declare success. */

export function fixPrompt(action: CapsuleAction, errorTail: string): string {
  const cmds = action.steps.map((s) => `  ${s.run}${s.cwd ? `   (cwd: ${s.cwd})` : ""}`).join("\n");
  return [
    "An action in this project is FAILING. Fix the code so it passes.",
    `Action: ${action.label}`,
    "Command(s) that must succeed:",
    cmds,
    "",
    "Failure output (tail):",
    errorTail,
    "",
    "Make the SMALLEST change that fixes the root cause. Do NOT weaken or delete tests, skip checks, lower coverage, or remove functionality just to make it pass. Edit the files directly, then run the command(s) yourself to confirm. When done, briefly state what you changed and why.",
  ].join("\n");
}


/** Run the fixing agent over a failed action, then re-verify deterministically. */
export async function generateFix(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<void> {
  const errorTail = (ws.capsule.runs.get(action.id)?.output ?? "").slice(-4000);
  const run: CapsuleRun = { state: "running", output: `AI is fixing “${action.label}”…\n`, proc: null };
  ws.capsule.runs.set(action.id, run);
  await new Promise<void>((resolve) => {
    // acceptEdits + file/Bash tools: the agent edits the repo and runs the build/
    // test to iterate. Changes are git-tracked (revertable); the re-verify below
    // is the real gate.
    const child = spawn("claude",
      ["-p", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash"],
      { cwd: repo, shell: true, windowsHide: true, env: process.env });
    run.proc = child;
    const onData = (d: Buffer): void => { run.output = (run.output + d.toString("utf-8")).slice(-20000); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 300_000);
    child.on("error", (e) => { clearTimeout(timer); run.output += `\n${String(e)}`; resolve(); });
    child.on("exit", () => { clearTimeout(timer); run.proc = null; resolve(); });
    child.stdin?.write(fixPrompt(action, errorTail));
    child.stdin?.end();
  });
  run.output += "\n\n=== re-verifying (deterministic gate) ===\n";
  const ok = await runActionSteps(run, ws, capsule, action, repo);
  run.state = ok ? "ok" : "error";
  run.output += ok ? "\n✓ Fixed — the action passes now." : "\n✗ Still failing after the fix attempt.";
}


/* ---------------------------- conversational edit ----------------------------
 * "Edit the capsule in English": an agent rewrites capsule.json per the user's
 * instruction and PROPOSES it as a draft. The user reviews a diff and Applies
 * (freeze) or Discards — the file changes only on Apply. */

export function chatPrompt(current: Capsule, message: string): string {
  return [
    "You are editing this project's capsule.json (the manifest that drives the dashboard cockpit) per the user's instruction. Change ONLY what is asked; keep everything else identical.",
    "",
    "CURRENT capsule.json:",
    "```json",
    JSON.stringify(current, null, 2),
    "```",
    "",
    `User instruction: ${message}`,
    "",
    'Schema reminder: actions have {id,label,description,icon,primary,steps:[{run,cwd,retries}],surface:"log-stream"|"device-install"|"preview"|"link",service,artifact,url,consent}. A long-running server MUST be service:true + surface:"preview". Read the repo (package.json/scripts/etc.) if you need exact commands or ports. Give any new action a short description.',
    "",
    "Output ONLY the COMPLETE updated capsule.json in one ```json fenced block. No prose.",
  ].join("\n");
}


/** Run the conversational-edit agent; store the proposed capsule as a draft. */
export function generateCapsuleChat(ws: Workspace, message: string): void {
  const current = loadCapsule(ws);
  const run: CapsuleRun = { state: "running", output: `Editing the capsule: “${message}”…\n`, proc: null };
  ws.capsule.runs.set("__chat__", run);
  if (!current) { run.state = "error"; run.output += "\n(no capsule to edit)"; return; }
  const repo = workspaceRepo(ws) ?? ws.workdir;
  const child = spawn("claude", ["-p", "--allowedTools", "Read,Glob,Grep"],
    { cwd: repo, shell: true, windowsHide: true, env: process.env });
  run.proc = child;
  let out = "";
  const onData = (d: Buffer): void => { out += d.toString("utf-8"); run.output = (run.output + d.toString("utf-8")).slice(-20000); };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 240_000);
  child.on("error", (e) => { clearTimeout(timer); run.proc = null; run.state = "error"; run.output += `\n${String(e)}`; });
  child.on("exit", () => {
    clearTimeout(timer); run.proc = null;
    const next = extractCapsule(out);
    if (!next) { run.state = "error"; run.output += "\n(could not parse an updated capsule from the agent)"; return; }
    ws.capsule.chatDraft = next;
    run.state = "ok"; run.output += "\n(proposed an edit — review the diff and Apply or Discard)";
  });
  child.stdin?.write(chatPrompt(current, message));
  child.stdin?.end();
}


/* ---------------------------- agent-judge (behavioral) ----------------------------
 * For what an exit code can't check ("does the UI actually render right?"), an
 * agent LOOKS at the running app (a headless-Chrome screenshot of its URL) or the
 * action's output and judges it against plain-English acceptance criteria. Verdict
 * is advisory (behavioral) — distinct from the deterministic gate. */

export function chromeBin(): string | null {
  const cands = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return cands.find((p) => existsSync(p)) ?? null;
}


/** Headless screenshot of `url` to `outPath`. Resolves true if the file appears. */
export function screenshotUrl(bin: string, url: string, outPath: string): Promise<boolean> {
  return new Promise((r) => {
    try { unlinkSync(outPath); } catch { /* not there */ }
    // --virtual-time-budget lets entrance animations / timers settle before the
    // capture, so a first-paint frame doesn't wrongly look empty on animated sites.
    const c = spawn(bin, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--virtual-time-budget=3500", `--screenshot=${outPath}`, "--window-size=1280,900", url], { windowsHide: true });
    const timer = setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 30_000);
    c.on("error", () => { clearTimeout(timer); r(false); });
    c.on("exit", () => { clearTimeout(timer); r(existsSync(outPath)); });
  });
}


export async function judgeAction(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<void> {
  const jr: JudgeResult = { state: "running", output: "Gathering evidence…\n" };
  ws.capsule.judgments.set(action.id, jr);
  const criteria = action.judge?.trim() || "The app renders correctly, with no visible error or blank screen.";
  // Evidence: a screenshot of a live URL when possible, else the action's output.
  const svc = ws.capsule.services.get(action.id);
  const url = action.service && svc?.state === "live" && svc.url ? svc.url : null;
  const bin = chromeBin();
  let imagePath: string | null = null;
  if (url && bin) {
    const out = join(ws.workdir, `.judge-${action.id.replace(/[^\w.-]/g, "_")}.png`);
    jr.output += `Screenshotting ${url} …\n`;
    if (await screenshotUrl(bin, url, out)) { imagePath = out; jr.shot = out; }
    else jr.output += "(screenshot failed — judging text output instead)\n";
  } else if (action.service) {
    jr.output += "(no live server to screenshot — start it first, or judging text output)\n";
  }
  const textEvidence = imagePath ? "" : (ws.capsule.runs.get(action.id)?.output ?? "").slice(-3000);
  const prompt = imagePath
    ? `You are a strict QA judge. Use the Read tool to look at the screenshot at ${imagePath} of the running app. Acceptance criteria: "${criteria}". Decide whether the criteria are met by what you SEE. Reply with ONLY JSON: {"verdict":"pass"|"fail","confidence":0..1,"reasons":["short observations"]}.`
    : `You are a strict QA judge. Here is the output of an action:\n"""\n${textEvidence}\n"""\nAcceptance criteria: "${criteria}". Reply with ONLY JSON: {"verdict":"pass"|"fail","confidence":0..1,"reasons":["short observations"]}.`;
  jr.output += "Judging against the criteria…\n";
  const out = await new Promise<string>((resolve) => {
    const c = spawn("claude", ["-p", "--allowedTools", "Read"], { cwd: repo, shell: true, windowsHide: true, env: process.env });
    let acc = "";
    c.stdout?.on("data", (d: Buffer) => { acc += d.toString("utf-8"); jr.output = (jr.output + d.toString("utf-8")).slice(-8000); });
    c.stderr?.on("data", (d: Buffer) => { jr.output = (jr.output + d.toString("utf-8")).slice(-8000); });
    const timer = setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 180_000);
    c.on("error", (e) => { clearTimeout(timer); jr.output += `\n${String(e)}`; resolve(acc); });
    c.on("exit", () => { clearTimeout(timer); resolve(acc); });
    c.stdin?.write(prompt);
    c.stdin?.end();
  });
  const v = parseVerdict(out);
  if (!v) { jr.state = "error"; jr.output += "\n(could not parse a verdict)"; return; }
  jr.verdict = v.verdict; jr.confidence = v.confidence; jr.reasons = v.reasons; jr.state = "done";
}

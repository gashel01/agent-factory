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
import type { FactoryEvent, Capsule } from "./types.js";
import { type CompanionCtx, type Observation, type ObsAction, foldRun, newCtx, observe } from "./companion.js";


export interface Options {
  workdir: string;
  port: number;
  host: string;
  factory: string[];
  ragmcp: string[];
}


export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    workdir: ".",
    port: 8765,
    host: "127.0.0.1",
    factory: ["uv", "run", "factory"],
    // How to invoke the ragmcp CLI (knowledge base). Like --factory: a space-split
    // command. Env RAGMCP_BIN or a bare "ragmcp" on PATH are the fallbacks.
    ragmcp: (process.env.RAGMCP_BIN || "ragmcp").split(" "),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workdir" && argv[i + 1]) opts.workdir = argv[++i]!;
    else if (arg === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg === "--host" && argv[i + 1]) opts.host = argv[++i]!; // non-local = your call
    else if (arg === "--factory" && argv[i + 1]) opts.factory = argv[++i]!.split(" ");
    else if (arg === "--ragmcp" && argv[i + 1]) opts.ragmcp = argv[++i]!.split(" ");
  }
  opts.workdir = resolve(opts.workdir);
  return opts;
}


export function latestRun(runsDir: string): string | null {
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir)
    .filter((name) => existsSync(join(runsDir, name, "events.jsonl")))
    .sort();
  return runs.length ? runs[runs.length - 1]! : null;
}


export interface RunSummary {
  counts: { queued: number; working: number; needs: number; merged: number };
  total: number;
  spend: number;
  tokens: number;
  budget: number | null;
  ended: boolean;
  updatedTs: string | null;
  mode: "subscription" | "api";
}


/**
 * Lightweight, dependency-free digest of a run's events.jsonl — the same fold
 * the client's reduce() does, but only the numbers the portfolio needs. Spend
 * mirrors the model: the authoritative spent_usd running total when present,
 * else the sum of per-agent cost_usd; tokens are input+output.
 */
export function summarizeRun(runsDir: string, run: string | null): RunSummary {
  const base: RunSummary = {
    counts: { queued: 0, working: 0, needs: 0, merged: 0 },
    total: 0, spend: 0, tokens: 0, budget: null, ended: false, updatedTs: null,
    mode: "subscription",
  };
  if (!run) return base;
  const file = join(runsDir, run, "events.jsonl");
  if (!existsSync(file)) return base;
  base.updatedTs = statSync(file).mtime.toISOString();
  const WORKING = new Set(["RUNNING", "VERIFYING", "REVIEWING", "MERGE_QUEUED", "MERGING"]);
  const states = new Map<string, string>();
  let sumCost = 0, spent = 0;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e.event === "run_start" && typeof e.budget_usd === "number") base.budget = e.budget_usd;
    if (e.event === "run_start" && typeof e.mode === "string") {
      base.mode = e.mode === "api" ? "api" : "subscription";
    }
    if (e.event === "run_end") base.ended = true;
    // Only the "state" event's `to` is a task state — other events (e.g. a ticket
    // file move) also carry a `to`, which must not be mistaken for a state.
    if (e.event === "state" && typeof e.task === "string" && typeof e.to === "string") {
      states.set(e.task, e.to);
    }
    if (e.event === "agent_result") {
      if (typeof e.cost_usd === "number") sumCost += e.cost_usd;
      if (typeof e.spent_usd === "number") spent = e.spent_usd;
      if (typeof e.input_tokens === "number") base.tokens += e.input_tokens;
      if (typeof e.output_tokens === "number") base.tokens += e.output_tokens;
    }
    if (e.event === "budget_exceeded" && typeof e.spent_usd === "number") spent = e.spent_usd;
  }
  base.spend = spent > 0 ? spent : sumCost;
  base.total = states.size;
  for (const st of states.values()) {
    if (st === "QUEUED") base.counts.queued++;
    else if (st === "DONE") base.counts.merged++;
    else if (st === "FAILED" || st === "BLOCKED") base.counts.needs++;
    else if (WORKING.has(st)) base.counts.working++;
  }
  return base;
}


export interface HistoryTicket {
  id: string;
  title: string;
  costUsd: number;
  tokens: number;
  finishedAt: string | null;
  run: string;
  diff: { repo: string; from: string; to: string } | null;
}


/**
 * The merged tickets of every run OTHER than `exceptRun`, folded from their
 * events.jsonl. This is what keeps the board cumulative: past work stays in the
 * "Merged" column across new runs and page reloads. Keyed by ticket id (ids are
 * monotonic — the planner never reuses one — so a later run wins any tie).
 */
export function historyFor(runsDir: string, exceptRun: string | null): HistoryTicket[] {
  if (!existsSync(runsDir)) return [];
  const runs = readdirSync(runsDir)
    .filter((name) => name !== exceptRun && existsSync(join(runsDir, name, "events.jsonl")))
    .sort(); // ascending: a newer run overwrites an older one for the same id
  const byId = new Map<string, HistoryTicket>();
  for (const run of runs) {
    const titles = new Map<string, string>();
    const cost = new Map<string, number>();
    const tokens = new Map<string, number>();
    const diffs = new Map<string, HistoryTicket["diff"]>();
    const done = new Map<string, string | null>(); // id -> finishedAt when DONE
    for (const line of readFileSync(join(runsDir, run, "events.jsonl"), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (e.event === "run_start" && Array.isArray(e.tasks)) {
        for (const t of e.tasks as Array<{ id?: string; title?: string } | string>) {
          if (typeof t !== "string" && t.id) titles.set(t.id, t.title ?? t.id);
        }
      }
      const id = typeof e.task === "string" ? e.task : null;
      if (!id) continue;
      if (e.event === "state" && e.to === "DONE") done.set(id, (e.ts as string) ?? null);
      if (e.event === "agent_result") {
        if (typeof e.cost_usd === "number") cost.set(id, (cost.get(id) ?? 0) + e.cost_usd);
        const tok = (typeof e.input_tokens === "number" ? e.input_tokens : 0)
          + (typeof e.output_tokens === "number" ? e.output_tokens : 0);
        if (tok) tokens.set(id, (tokens.get(id) ?? 0) + tok);
      }
      if (e.event === "merged" && e.repo && e.base && e.commit) {
        diffs.set(id, { repo: String(e.repo), from: String(e.base), to: String(e.commit) });
      }
    }
    for (const [id, finishedAt] of done) {
      byId.set(id, {
        id, title: titles.get(id) ?? id, costUsd: cost.get(id) ?? 0,
        tokens: tokens.get(id) ?? 0, finishedAt, run, diff: diffs.get(id) ?? null,
      });
    }
  }
  return [...byId.values()];
}


// YAML/JSON on Windows must use forward slashes: a backslash in a double-quoted
// scalar is read as an escape sequence (C:\Users -> invalid \U). Chroma and the
// claude CLI both accept forward slashes on Windows.
export const toPosix = (p: string): string => p.split(sep).join("/");


// ragmcp logs with ANSI colour codes (structlog); strip them so chunk counts parse
// and error text is readable in the UI.
export const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");


/** Tails one run's events.jsonl and fans lines out to SSE clients. */
export class RunTailer {
  private offset = 0;
  private buffer = "";
  // The companion mapper's per-run state (title lookup + sequence). It walks the
  // current run's events as they stream so new observations can be pushed live;
  // the /api/companion history fold uses an independent ctx per run but the same
  // `run#seq` id scheme, so the client dedups the two sources cleanly.
  private companion: CompanionCtx;
  readonly clients = new Set<ServerResponse>();

  constructor(
    readonly runsDir: string,
    public run: string | null,
  ) {
    this.companion = newCtx(run ?? "");
  }

  private get file(): string | null {
    return this.run ? join(this.runsDir, this.run, "events.jsonl") : null;
  }

  switchTo(run: string): void {
    this.run = run;
    this.offset = 0;
    this.buffer = "";
    this.companion = newCtx(run);
    this.runEnded = false;
    this.lastEventAt = 0;
    this.lastStallBriefFor = 0;
    this.lastStandupAt = 0;
    this.standupCount = 0;
    this.progressSinceStandup = 0;
    this.activeTasks.clear();
    for (const client of this.clients) {
      client.write(`event: run\ndata: ${JSON.stringify({ run })}\n\n`);
      this.seedHistory(client);
      this.replayTo(client);
    }
  }

  /** Past runs' merged tickets, so the board stays cumulative when a new run
   *  resets the client model. Sent before the current run's events, which
   *  overwrite any shared id with their live state. */
  private seedHistory(client: ServerResponse): void {
    const history = historyFor(this.runsDir, this.run);
    if (history.length) client.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
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
    this.seedHistory(client);
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
        let ev: FactoryEvent | null = null;
        try { ev = JSON.parse(line) as FactoryEvent; } catch { ev = null; }
        if (!ev) continue;
        // Narrate the event for the companion feed and push each observation as
        // a named SSE event, so the always-on rail updates live (no 2nd mapper).
        for (const obs of observe(ev, this.companion)) {
          const payload = `event: companion\ndata: ${JSON.stringify(obs)}\n\n`;
          for (const client of this.clients) client.write(payload);
        }
        this.noteActivity(ev);
      }
    });
  }

  /* ---- run-activity tracking (drives the LLM wrap-up and stall briefings) ---- */

  /** Set when a run_end streams in; the main loop reads and clears it. */
  pendingWrapup: { run: string; counts: Record<string, number> } | null = null;
  /** Epoch ms of the last event seen; a long gap while work is in flight = stall. */
  lastEventAt = 0;
  runEnded = false;
  /** Tasks currently in an in-flight state (RUNNING…MERGING). */
  readonly activeTasks = new Set<string>();
  /** The `lastEventAt` value we last briefed a stall for, to fire once per gap. */
  lastStallBriefFor = 0;
  /** Periodic stand-up bookkeeping: when the last one fired, how many so far,
   *  and how many meaningful results have landed since (the activity gate). */
  lastStandupAt = 0;
  standupCount = 0;
  progressSinceStandup = 0;

  private noteActivity(ev: FactoryEvent): void {
    this.lastEventAt = Date.now();
    if (this.lastStandupAt === 0) this.lastStandupAt = Date.now(); // anchor the cadence to first activity
    if (ev.event === "state") {
      const s = ev as { task?: string; to?: string };
      const inflight = ["RUNNING", "VERIFYING", "REVIEWING", "MERGE_QUEUED", "MERGING"];
      if (s.task && s.to) {
        if (inflight.includes(s.to)) this.activeTasks.add(s.task);
        else this.activeTasks.delete(s.task); // DONE / FAILED / BLOCKED / AWAITING_APPROVAL
        if (s.to === "DONE") this.progressSinceStandup += 1;
      }
    } else if (ev.event === "failure" || ev.event === "blocked") {
      this.progressSinceStandup += 1;
    } else if (ev.event === "run_end" && this.run) {
      this.runEnded = true;
      this.activeTasks.clear();
      this.pendingWrapup = { run: this.run, counts: (ev as { counts?: Record<string, number> }).counts ?? {} };
    }
  }
}


/* ------------------------------ workspaces ------------------------------ */

/** One clarifying question the planner asks in plan mode (an `--ask` pass). */
export interface PlanQuestion {
  q: string;
  why: string;
  suggestions: string[];
}


export interface Job {
  state: "idle" | "running" | "done" | "error";
  output: string;
  /** Latest one-line progress note (supervisor `ask --stream`); "" when idle. */
  progress?: string;
  /** Plan job only: which pass this was, and — after an `--ask` pass — the
   *  clarifying questions the planner returned for the operator to answer. */
  mode?: "tickets" | "questions";
  questions?: PlanQuestion[];
}


/** Pull the machine-readable questions line the `factory plan --ask` pass prints
 *  (`@plan-questions {json}`) out of its stdout. Last marker wins. */
export function parsePlanQuestions(stdout: string): PlanQuestion[] | null {
  const marker = "@plan-questions ";
  const line = stdout.split("\n").reverse().find((l) => l.trim().startsWith(marker));
  if (!line) return null;
  try {
    const obj = JSON.parse(line.trim().slice(marker.length)) as { questions?: unknown };
    if (!Array.isArray(obj.questions)) return null;
    return obj.questions
      .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
      .map((q) => ({
        q: String(q.q ?? ""),
        why: String(q.why ?? ""),
        suggestions: Array.isArray(q.suggestions) ? q.suggestions.map((s) => String(s)) : [],
      }))
      .filter((q) => q.q);
  } catch {
    return null;
  }
}


/**
 * A live preview of the built product. One per workspace: starting a new one
 * stops the old. `web` runs the repo's own dev server (npm run dev|start|…) and
 * scrapes the localhost URL it prints; `static` serves a plain index.html tree
 * ourselves on an ephemeral port. The browser tab is opened by the CLIENT (it
 * already runs in a browser) — the server only hands back the URL.
 */
export interface Preview {
  kind: "web" | "static" | "none";
  state: "idle" | "starting" | "ready" | "error";
  url: string | null;
  output: string;
  repo: string | null;
  proc: ChildProcess | null;
  server: Server | null;
}


export interface CapsuleRun {
  state: "idle" | "running" | "ok" | "error";
  output: string;
  proc: ChildProcess | null;
}

export interface ServiceRun {
  state: "stopped" | "starting" | "live" | "error";
  url: string | null;
  output: string;
  proc: ChildProcess | null;
}

export interface JudgeResult {
  state: "running" | "done" | "error";
  output: string;
  verdict?: "pass" | "fail";
  confidence?: number;
  reasons?: string[];
  shot?: string; // absolute path to the screenshot evidence, if any
}

export interface CapsuleRuntime {
  runs: Map<string, CapsuleRun>;
  services: Map<string, ServiceRun>; // long-running server actions
  grants: Set<string>; // granted consent ids (persisted to capsule.grants.json)
  chatDraft: Capsule | null; // a conversational edit proposed but not yet applied
  judgments: Map<string, JudgeResult>; // agent behavioral verdicts per action
}


export interface Workspace {
  name: string;
  workdir: string;
  // The project's repository path, remembered server-side (workspaces.json) so
  // every browser/device sees it — NOT a per-browser "last typed" value.
  repo: string | null;
  tailer: RunTailer;
  jobs: { plan: Job; run: Job; chat: Job; doctor: Job; loop: Job };
  // The autopilot loop's child process, kept so /api/loop/stop can kill its tree.
  loopProc: ChildProcess | null;
  preview: Preview;
  capsule: CapsuleRuntime;
  // Ticket ids the operator removed from the board. Display-only: run history
  // (events.jsonl) and backlog files are untouched, so a remove is reversible.
  hidden: Set<string>;
}


/** The workspace's repo: the remembered one, else derived from ticket front
 *  matter — pending backlog first, then the archived (merged) tickets, since a
 *  project that shipped everything has an empty backlog but a full done/. */
export function workspaceRepo(ws: Workspace): string | null {
  if (ws.repo) return ws.repo;
  const backlog = join(ws.workdir, "backlog");
  for (const dir of [backlog, join(backlog, "done")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      try {
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), "utf-8"))?.[1] ?? "";
        const raw = /^repo:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm)?.[1]?.trim();
        if (raw) return resolve(backlog, raw); // tickets resolve relative to the backlog dir
      } catch { /* try the next ticket */ }
    }
  }
  return null;
}


export const SAFE_WS = /^[\w][\w .-]{0,40}$/;


export class Registry {
  readonly workspaces = new Map<string, Workspace>();

  constructor(readonly file: string) {}

  load(defaultWorkdir: string): void {
    let entries: Array<{ name: string; workdir: string; repo?: string }> = [];
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
    for (const entry of entries) this.register(entry.name, entry.workdir, entry.repo ?? null);
    this.save();
  }

  register(name: string, workdir: string, repo: string | null = null): Workspace {
    const dir = resolve(workdir);
    const runs = join(dir, "runs");
    const ws: Workspace = {
      name,
      workdir: dir,
      repo,
      tailer: new RunTailer(runs, latestRun(runs)),
      jobs: {
        plan: { state: "idle", output: "" },
        run: { state: "idle", output: "" },
        chat: { state: "idle", output: "" },
        doctor: { state: "idle", output: "" },
        loop: { state: "idle", output: "" },
      },
      loopProc: null,
      preview: { kind: "none", state: "idle", url: null, output: "", repo: null, proc: null, server: null },
      capsule: { runs: new Map(), services: new Map(), grants: loadGrants(dir), chatDraft: null, judgments: new Map() },
      hidden: loadHidden(dir),
    };
    this.workspaces.set(name, ws);
    return ws;
  }

  rename(oldName: string, newName: string): void {
    const ws = this.workspaces.get(oldName);
    if (!ws) throw new Error("unknown workspace");
    // Rebuild the map so the display order (registration order) is preserved
    // rather than moving the renamed entry to the end.
    const entries = [...this.workspaces.entries()];
    this.workspaces.clear();
    for (const [key, value] of entries) {
      if (key === oldName) { value.name = newName; this.workspaces.set(newName, value); }
      else this.workspaces.set(key, value);
    }
  }

  save(): void {
    const entries = [...this.workspaces.values()]
      .map(({ name, workdir, repo }) => ({ name, workdir, ...(repo ? { repo } : {}) }));
    writeFileSync(this.file, JSON.stringify({ workspaces: entries }, null, 2), "utf-8");
  }

  resolve(url: URL): Workspace | null {
    const name = url.searchParams.get("ws");
    if (name) return this.workspaces.get(name) ?? null;
    return this.workspaces.values().next().value ?? null;
  }
}


export function spawnJob(
  ws: Workspace,
  kind: "plan" | "run" | "chat" | "doctor" | "loop",
  factory: string[],
  args: string[],
  env?: Record<string, string>,
  onDone?: (ok: boolean, output: string, stdout: string) => void,
  streamProgress = false,
): ChildProcess {
  ws.jobs[kind] = { state: "running", output: "", progress: "" };
  // NEVER shell:true — goals are user text (spaces, parentheses, quotes) and
  // must reach the CLI as one argv entry. Windows: the command must resolve
  // to an .exe (uv, python, a full path); .cmd shims need an explicit path.
  const [cmd, ...prefix] = factory;
  const child = spawn(cmd!, [...prefix, ...args], {
    cwd: ws.workdir,
    shell: false,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  // `output` is the combined stream (surfaces errors in the job panel); `stdout`
  // is kept separate so a caller can parse a clean final answer even when stderr
  // carries progress lines (see the supervisor's `ask --stream`).
  let stdout = "";
  const append = (chunk: Buffer) => {
    ws.jobs[kind].output = (ws.jobs[kind].output + chunk.toString("utf-8")).slice(-20_000);
  };
  child.stdout.on("data", (c: Buffer) => { stdout = (stdout + c.toString("utf-8")).slice(-40_000); append(c); });
  let errBuf = "";
  child.stderr.on("data", (c: Buffer) => {
    append(c);
    if (!streamProgress) return;
    errBuf += c.toString("utf-8");
    let nl: number;
    while ((nl = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, nl).trim();
      errBuf = errBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line) as { kind?: string; text?: unknown };
        if (j?.kind === "progress" && typeof j.text === "string") ws.jobs[kind].progress = j.text;
      } catch { /* not a progress line — it's ordinary stderr, already in output */ }
    }
  });
  child.on("error", (err) => {
    ws.jobs[kind].state = "error";
    ws.jobs[kind].output += `\n${String(err)}`;
  });
  child.on("exit", (code) => {
    ws.jobs[kind].state = code === 0 ? "done" : "error";
    ws.jobs[kind].progress = "";
    onDone?.(code === 0, ws.jobs[kind].output.trim(), stdout.trim());
  });
  return child;
}


/** One-shot `factory ask` that resolves with the model's raw answer. Unlike
 *  spawnJob it isn't tracked in ws.jobs (it never competes with a run/chat) and
 *  is request/response — used to expand a hand-written ticket on demand. */
export function askOneShot(factory: string[], cwd: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...prefix] = factory;
    const child = spawn(cmd!, [...prefix, "ask", "--json", prompt], {
      cwd, shell: false, windowsHide: true, env: process.env,
    });
    let out = "";
    const cap = (c: Buffer) => { out = (out + c.toString("utf-8")).slice(-40_000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => { child.kill(); reject(new Error("the model took too long — try again")); }, 90_000);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(out.trim().slice(-280) || `ask exited ${code}`));
    });
  });
}


/** Run one command to completion (no shell — args reach the exe as real argv). */
export function runCmd(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => resolvePromise({ code: -1, output: String(err) }));
    child.on("exit", (code) => resolvePromise({ code: code ?? -1, output }));
  });
}


/* ------------------------------- capsule engine -------------------------------
 * Generic, app-agnostic runner for a project's capsule.json. The factory knows
 * phases/runners/surfaces; the capsule carries the app-specific commands as DATA.
 * Determinism lives here (declared commands, exit-code gating); the open-ended
 * "how" was decided once when the capsule was generated and then frozen. */

export function capsuleGrantsFile(workdir: string): string {
  return join(workdir, "capsule.grants.json");
}

export function loadGrants(workdir: string): Set<string> {
  const f = capsuleGrantsFile(workdir);
  if (!existsSync(f)) return new Set();
  try {
    const a = JSON.parse(readFileSync(f, "utf-8"));
    return new Set(Array.isArray(a) ? (a as string[]) : []);
  } catch { return new Set(); }
}

export function saveGrants(ws: Workspace): void {
  try { writeFileSync(capsuleGrantsFile(ws.workdir), JSON.stringify([...ws.capsule.grants]), "utf-8"); }
  catch { /* best effort */ }
}


/** Removed-ticket ids (board-only hide, reversible), persisted per workspace. */
export function loadHidden(workdir: string): Set<string> {
  const f = join(workdir, "hidden-tickets.json");
  if (!existsSync(f)) return new Set();
  try {
    const a = JSON.parse(readFileSync(f, "utf-8"));
    return new Set(Array.isArray(a) ? (a as string[]) : []);
  } catch { return new Set(); }
}

export function saveHidden(ws: Workspace): void {
  try { writeFileSync(join(ws.workdir, "hidden-tickets.json"), JSON.stringify([...ws.hidden]), "utf-8"); }
  catch { /* best effort */ }
}


/* --------------------------------- http --------------------------------- */

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolvePromise(body));
  });
}


/** Read the per-install auth secret, creating it on first launch. */
export function readOrCreateToken(file: string): string {
  try { const t = readFileSync(file, "utf-8").trim(); if (t) return t; } catch { /* create */ }
  const t = randomBytes(16).toString("hex");
  try { writeFileSync(file, t, "utf-8"); } catch { /* best effort */ }
  return t;
}


export function json(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}


/**
 * Best-guess LAN IPv4 for reaching this dashboard from another device on the
 * same network. Skips internal (loopback) and non-IPv4 interfaces; prefers a
 * private-range address (192.168/10/172.16-31) over anything else.
 */
export function lanIPv4(): string | null {
  const isPrivate = (ip: string): boolean =>
    ip.startsWith("192.168.") || ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  let fallback: string | null = null;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (isPrivate(a.address)) return a.address;
      fallback ??= a.address;
    }
  }
  return fallback;
}


export const SAFE_NAME = /^[\w.-]+\.md$/;

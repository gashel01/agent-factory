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
import { homedir, networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import type {
  FactoryEvent,
  Capsule, CapsuleAction, CapsuleConsent, CapsuleStep, CapsuleActionState, CapsuleView,
} from "./types.js";
import { type CompanionCtx, type ObsAction, type Observation, foldRun, newCtx, observe } from "./companion.js";
import { capsuleDiff, extractCapsule, extractConsents, parseVerdict } from "./capsule-core.js";

interface Options {
  workdir: string;
  port: number;
  host: string;
  factory: string[];
  ragmcp: string[];
}

function parseArgs(argv: string[]): Options {
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

function latestRun(runsDir: string): string | null {
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir)
    .filter((name) => existsSync(join(runsDir, name, "events.jsonl")))
    .sort();
  return runs.length ? runs[runs.length - 1]! : null;
}

interface RunSummary {
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
function summarizeRun(runsDir: string, run: string | null): RunSummary {
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

interface HistoryTicket {
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
function historyFor(runsDir: string, exceptRun: string | null): HistoryTicket[] {
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

/* ------------------------------ learned facts (memory) ------------------------------ */

interface Fact {
  id: string;
  text: string;
  scope: "project" | "global";
  ticketId: string | null;
  createdTs: string;
  applied?: number;
}

/** How often each lesson was injected into an agent prompt. Written only by the
 *  factory (`memory.applied.json`); the dashboard reads it to show "used N×". */
function readApplied(file: string): Record<string, number> {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { counts?: Record<string, number> };
    return raw.counts ?? {};
  } catch {
    return {};
  }
}

function readFacts(file: string): Fact[] {
  if (!existsSync(file)) return [];
  try {
    return (JSON.parse(readFileSync(file, "utf-8")) as { facts?: Fact[] }).facts ?? [];
  } catch {
    return [];
  }
}

function writeFacts(file: string, facts: Fact[]): void {
  writeFileSync(file, JSON.stringify({ facts }, null, 2), "utf-8");
}

/* ------------------------------ knowledge base (ragmcp) ------------------------------ */

// A document the dev added to the project's knowledge base. The raw file lives in
// knowledge/docs/; this is just the index entry shown in the UI.
interface KnowledgeDoc {
  id: string;
  name: string;
  size: number;
  addedTs: string;
  chunks: number | null; // set once ragmcp has ingested it; null while pending/failed
  error?: string;
}

// YAML/JSON on Windows must use forward slashes: a backslash in a double-quoted
// scalar is read as an escape sequence (C:\Users -> invalid \U). Chroma and the
// claude CLI both accept forward slashes on Windows.
const toPosix = (p: string): string => p.split(sep).join("/");

// ragmcp logs with ANSI colour codes (structlog); strip them so chunk counts parse
// and error text is readable in the UI.
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

function knowledgePaths(workdir: string) {
  const dir = join(workdir, "knowledge");
  return {
    dir,
    docsDir: join(dir, "docs"),
    store: join(dir, ".ragmcp"),
    yaml: join(dir, "ragmcp.yaml"),
    mcp: join(dir, "mcp.json"),
    index: join(dir, "docs.json"),
  };
}

function readDocs(indexFile: string): KnowledgeDoc[] {
  if (!existsSync(indexFile)) return [];
  try {
    return (JSON.parse(readFileSync(indexFile, "utf-8")) as { docs?: KnowledgeDoc[] }).docs ?? [];
  } catch {
    return [];
  }
}

function writeDocs(indexFile: string, docs: KnowledgeDoc[]): void {
  writeFileSync(indexFile, JSON.stringify({ docs }, null, 2), "utf-8");
}

// Write the per-project ragmcp config + the agent's mcp.json. Idempotent: safe to
// call on every enable. The store is scoped to this project's knowledge/.ragmcp,
// embeddings are local (fastembed, offline, no API key).
function scaffoldKnowledge(workdir: string, ragmcp: string[]): void {
  const p = knowledgePaths(workdir);
  mkdirSync(p.docsDir, { recursive: true });
  mkdirSync(p.store, { recursive: true });
  writeFileSync(p.yaml, [
    "# Generated by the dashboard Knowledge panel. Local, offline, per-project.",
    "embedder:",
    "  provider: fastembed",
    "  model: BAAI/bge-small-en-v1.5",
    "vectorstore:",
    "  type: chroma",
    `  path: ${toPosix(p.store)}`,
    "  collection: chunks",
    "pipeline:",
    "  top_k: 8",
    "server:",
    "  transport: stdio",
    "  ingest_mode: path",
    "",
  ].join("\n"), "utf-8");
  const [cmd, ...prefix] = ragmcp;
  const mcp = {
    mcpServers: {
      ragmcp: { command: cmd, args: [...prefix, "serve", "--config", toPosix(p.yaml)] },
    },
  };
  writeFileSync(p.mcp, JSON.stringify(mcp, null, 2), "utf-8");
}

// Spawn the ragmcp CLI and resolve with its exit code + captured output. Used for
// ingest/sync; ragmcp reloads its (local) embedder per call, so this takes seconds.
function runRagmcp(ragmcp: string[], args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const [cmd, ...prefix] = ragmcp;
    const child = spawn(cmd!, [...prefix, ...args], { cwd, shell: false, windowsHide: true });
    let out = "";
    const grab = (c: Buffer) => { out = (out + c.toString("utf-8")).slice(-20_000); };
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    child.on("error", (err) => resolve({ ok: false, out: stripAnsi(out + "\n" + String(err)) }));
    child.on("exit", (code) => resolve({ ok: code === 0, out: stripAnsi(out).trim() }));
  });
}

// Toggle the `agent.mcp_config` line in factory.yaml. generateConfig (the Settings
// panel) also emits/preserves this exact line, so the two writers agree and a
// Settings save never clobbers an enabled knowledge base.
const MCP_CONFIG_LINE = "  mcp_config: knowledge/mcp.json";

function setKnowledgeEnabled(configFile: string, enabled: boolean): void {
  let text = existsSync(configFile) ? readFileSync(configFile, "utf-8") : "";
  const has = /^\s*mcp_config:/m.test(text);
  if (enabled && !has) {
    if (/^agent:\s*$/m.test(text)) {
      text = text.replace(/^agent:\s*$/m, `agent:\n${MCP_CONFIG_LINE}`);
    } else {
      text += `${text.endsWith("\n") ? "" : "\n"}agent:\n${MCP_CONFIG_LINE}\n`;
    }
    writeFileSync(configFile, text, "utf-8");
  } else if (!enabled && has) {
    writeFileSync(configFile, text.replace(/^\s*mcp_config:.*\n?/m, ""), "utf-8");
  }
}

/** Tails one run's events.jsonl and fans lines out to SSE clients. */
class RunTailer {
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

/** Fold a workspace's runs into the companion timeline — the narrated,
 *  persistent record of "what happened in this project", newest last. Derived
 *  fresh from events.jsonl each call, so it is always consistent with the board. */
function companionTimeline(runsDir: string, limit: number): Observation[] {
  if (!existsSync(runsDir)) return [];
  const runs = readdirSync(runsDir)
    .filter((n) => existsSync(join(runsDir, n, "events.jsonl")))
    .sort(); // run ids are timestamped, so lexical order is chronological
  const all: Observation[] = [];
  for (const run of runs) {
    try {
      all.push(...foldRun(readFileSync(join(runsDir, run, "events.jsonl"), "utf-8"), newCtx(run)));
    } catch { /* skip an unreadable run */ }
  }
  return all.slice(-limit);
}

/* ------------------------------ companion briefings ------------------------------ */

// LLM-composed briefings (the supervisor's own voice). Unlike event-derived
// observations these cannot be re-derived, so they are persisted per workspace
// and merged into the timeline. Deduped by their stable id.
const briefInFlight = new Set<string>();

// A run is "stalled" when nothing has moved for this long while work is in
// flight. Overridable (mostly for tests) via FACTORY_STALL_MS.
const STALL_MS = Number(process.env.FACTORY_STALL_MS) || 5 * 60 * 1000;

// Cadence for the periodic mid-run stand-up. Only fires when someone is watching
// AND real progress landed since the last one, so cost stays bounded.
const STANDUP_MS = Number(process.env.FACTORY_STANDUP_MS) || 12 * 60 * 1000;

function briefingsFile(ws: Workspace): string {
  return join(ws.workdir, "companion-briefings.jsonl");
}

/** Push one observation to every SSE client of the workspace's live feed. */
function pushCompanion(ws: Workspace, obs: Observation): void {
  const payload = `event: companion\ndata: ${JSON.stringify(obs)}\n\n`;
  for (const client of ws.tailer.clients) client.write(payload);
}

function readBriefings(ws: Workspace): Observation[] {
  const file = briefingsFile(ws);
  if (!existsSync(file)) return [];
  const out: Observation[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as Observation); } catch { /* skip a torn line */ }
  }
  return out;
}

const CONTROL_OPS = new Set<ObsAction["op"]>(["retry", "kill", "pause", "resume", "stop"]);

/** Parse `factory ask --json` stdout into the briefing text plus validated,
 *  executable suggestions. Defense in depth: even though the CLI already
 *  validates, we re-check the ops here before they can become live buttons.
 *  Falls back to treating the output as prose if it is not the JSON envelope. */
function parseAnswer(raw: string): { text: string; suggestions: ObsAction[] } {
  try {
    const j = JSON.parse(raw) as { reply?: unknown; suggestions?: unknown };
    if (j && typeof j.reply === "string") {
      const suggestions: ObsAction[] = [];
      if (Array.isArray(j.suggestions)) {
        for (const s of j.suggestions as Array<Record<string, unknown>>) {
          if (!s || typeof s !== "object") continue;
          const op = String(s.op ?? "") as ObsAction["op"];
          // "plan" is not a control op: it carries a goal for the ticket planner,
          // not a task to act on. Keep it only when the goal is present.
          if (op === "plan") {
            const goal = String(s.goal ?? "").trim();
            if (!goal) continue;
            const label = (String(s.label ?? "Draft tickets").slice(0, 24) || "Draft tickets");
            suggestions.push({ op, label, goal: goal.slice(0, 2000) });
            continue;
          }
          if (!CONTROL_OPS.has(op)) continue;
          const task = s.task ? String(s.task) : undefined;
          if ((op === "retry" || op === "kill") && !task) continue;
          const label = (String(s.label ?? op).slice(0, 24) || op);
          suggestions.push({ op, label, ...(task ? { task } : {}) });
        }
      }
      return { text: j.reply.trim(), suggestions };
    }
  } catch { /* not the JSON envelope — treat as prose */ }
  return { text: raw, suggestions: [] };
}

/**
 * Spawn the supervisor to compose a briefing (its own voice) and drop it into
 * the companion feed. Fire-and-forget: `factory ask` on the shared --resume
 * session (continuity), then persist + push over SSE. Deduped durably by id and
 * skipped while a live chat holds the session. Used for run wrap-ups and stalls.
 */
function spawnBriefing(
  ws: Workspace, factory: string[], run: string, id: string, prompt: string,
  render: (reply: string) => Pick<Observation, "level" | "icon">,
): void {
  if (briefInFlight.has(id)) return;
  if (readBriefings(ws).some((o) => o.id === id)) return; // already briefed
  if (ws.jobs.chat.state === "running") return; // don't collide on the shared session
  briefInFlight.add(id);

  const [cmd, ...prefix] = factory;
  // --json gives us the structured answer (reply + machine-executable
  // suggestions) instead of prose, so proposals become one-click buttons.
  const child = spawn(cmd!, [...prefix, "ask", "--json", prompt], {
    cwd: ws.workdir, shell: false, windowsHide: true, env: process.env,
  });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString("utf-8")));
  child.stderr.on("data", (c: Buffer) => (out += c.toString("utf-8")));
  child.on("error", () => briefInFlight.delete(id));
  child.on("exit", (code) => {
    briefInFlight.delete(id);
    const raw = out.trim();
    if (code !== 0 || !raw) return;
    const { text, suggestions } = parseAnswer(raw);
    if (!text) return;
    const { level, icon } = render(text);
    const obs: Observation = {
      id, ts: new Date().toISOString(), run, level, degree: 1, icon,
      text: text.slice(0, 2000), kind: "briefing",
      ...(suggestions.length ? { suggestions } : {}),
    };
    try { appendFileSync(briefingsFile(ws), JSON.stringify(obs) + "\n", "utf-8"); } catch { /* best effort */ }
    pushCompanion(ws, obs);
    // Token saver: the wrap-up closes the run's chapter, so retire the shared
    // supervisor session. It grows with every chat + briefing and is otherwise
    // NEVER reset — each exchange would re-pay an ever-longer history. The next
    // ask starts a fresh session (contract re-sent once; the ground truth lives
    // in the files it reads, not in the conversation).
    if (id.endsWith("#wrapup")) {
      try { unlinkSync(join(ws.workdir, ".supervisor-session")); } catch { /* none yet */ }
    }
  });
}

/** LLM wrap-up of a run that just finished. Once per run (durable dedup). */
function composeWrapup(ws: Workspace, factory: string[], run: string, counts: Record<string, number>): void {
  const failed = counts.FAILED ?? 0;
  const prompt =
    "The run just finished. In 2-3 sentences, give the operator a wrap-up: what shipped, " +
    "anything that failed or still needs their attention, and what you'd suggest doing next. " +
    "Ground it in the run's events. Warm and concrete, no preamble. Do not take any action.";
  spawnBriefing(ws, factory, run, `brief#${run}#wrapup`, prompt,
    () => ({ level: failed ? "warn" : "good", icon: "🤖" }));
}

/** LLM diagnosis when a live run goes quiet while work is still in flight. The
 *  gap-anchored id fires it at most once per quiet period. */
function composeStall(ws: Workspace, factory: string[], run: string, quietSince: number, activeN: number): void {
  const mins = Math.round((Date.now() - quietSince) / 60000);
  const prompt =
    `Nothing has moved for about ${mins} minute(s), yet ${activeN} task(s) are still in flight. ` +
    "Look at the running agents' recent activity (their stdout logs) and tell the operator in 1-2 " +
    "sentences what is happening and whether they should step in. Concrete, no preamble. Do not act.";
  spawnBriefing(ws, factory, run, `brief#${run}#stall#${quietSince}`, prompt,
    () => ({ level: "warn", icon: "🐢" }));
}

/** Periodic mid-run stand-up: the companion's proactive "here's where we are"
 *  while a run is progressing. The `n`-suffixed id keeps each one distinct. */
function composeStandup(ws: Workspace, factory: string[], run: string, n: number): void {
  const prompt =
    "Give the operator a brief mid-run stand-up: where things stand now, what's in flight, " +
    "and anything worth keeping an eye on. 2-3 sentences, concrete, grounded in the run's events. " +
    "No preamble. Do not take any action.";
  spawnBriefing(ws, factory, run, `brief#${run}#standup#${n}`, prompt,
    () => ({ level: "info", icon: "📋" }));
}

/* ------------------------------ workspaces ------------------------------ */

/** One clarifying question the planner asks in plan mode (an `--ask` pass). */
interface PlanQuestion {
  q: string;
  why: string;
  suggestions: string[];
}

interface Job {
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
function parsePlanQuestions(stdout: string): PlanQuestion[] | null {
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
interface Preview {
  kind: "web" | "static" | "none";
  state: "idle" | "starting" | "ready" | "error";
  url: string | null;
  output: string;
  repo: string | null;
  proc: ChildProcess | null;
  server: Server | null;
}

interface CapsuleRun {
  state: "idle" | "running" | "ok" | "error";
  output: string;
  proc: ChildProcess | null;
}
interface ServiceRun {
  state: "stopped" | "starting" | "live" | "error";
  url: string | null;
  output: string;
  proc: ChildProcess | null;
}
interface JudgeResult {
  state: "running" | "done" | "error";
  output: string;
  verdict?: "pass" | "fail";
  confidence?: number;
  reasons?: string[];
  shot?: string; // absolute path to the screenshot evidence, if any
}
interface CapsuleRuntime {
  runs: Map<string, CapsuleRun>;
  services: Map<string, ServiceRun>; // long-running server actions
  grants: Set<string>; // granted consent ids (persisted to capsule.grants.json)
  chatDraft: Capsule | null; // a conversational edit proposed but not yet applied
  judgments: Map<string, JudgeResult>; // agent behavioral verdicts per action
}

interface Workspace {
  name: string;
  workdir: string;
  // The project's repository path, remembered server-side (workspaces.json) so
  // every browser/device sees it — NOT a per-browser "last typed" value.
  repo: string | null;
  tailer: RunTailer;
  jobs: { plan: Job; run: Job; chat: Job; doctor: Job };
  preview: Preview;
  capsule: CapsuleRuntime;
  // Ticket ids the operator removed from the board. Display-only: run history
  // (events.jsonl) and backlog files are untouched, so a remove is reversible.
  hidden: Set<string>;
}

/** The workspace's repo: the remembered one, else derived from ticket front
 *  matter — pending backlog first, then the archived (merged) tickets, since a
 *  project that shipped everything has an empty backlog but a full done/. */
function workspaceRepo(ws: Workspace): string | null {
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

const SAFE_WS = /^[\w][\w .-]{0,40}$/;

class Registry {
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
      },
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

function spawnJob(
  ws: Workspace,
  kind: "plan" | "run" | "chat" | "doctor",
  factory: string[],
  args: string[],
  env?: Record<string, string>,
  onDone?: (ok: boolean, output: string, stdout: string) => void,
  streamProgress = false,
): void {
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
}

/** One-shot `factory ask` that resolves with the model's raw answer. Unlike
 *  spawnJob it isn't tracked in ws.jobs (it never competes with a run/chat) and
 *  is request/response — used to expand a hand-written ticket on demand. */
function askOneShot(factory: string[], cwd: string, prompt: string): Promise<string> {
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

/* ------------------------------ Docker sandbox preflight ------------------------------ */

// Docker is host-global (not per-workspace), so its readiness + the in-progress
// image build live at module scope. The cockpit polls /api/docker while the
// Sandbox toggle is on; POST /api/docker/build kicks the (slow) image build.
const sbxBuild: { running: boolean; log: string; ok: boolean | null } = {
  running: false, log: "", ok: null,
};

/** Ask the factory for machine-readable sandbox readiness (one-shot subprocess). */
function dockerPreflight(factory: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const [cmd, ...prefix] = factory;
    const child = spawn(cmd!, [...prefix, "sandbox-preflight"], {
      shell: false, windowsHide: true, env: process.env,
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf-8")));
    child.on("error", () =>
      resolve({ engine: false, image: false, proxy: false, ready: false,
                detail: "could not run factory sandbox-preflight" }));
    child.on("exit", () => {
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        resolve({ engine: false, image: false, proxy: false, ready: false,
                  detail: "unreadable preflight output" });
      }
    });
  });
}

/** Ask the factory for the repo's oversized-file hotspots (one-shot subprocess,
 *  deterministic — no agent, no tokens). Failures degrade to an empty list so a
 *  missing/odd repo never breaks the screen that shows the advisory. */
function hotspotsScan(factory: string[], repo: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const [cmd, ...prefix] = factory;
    const child = spawn(cmd!, [...prefix, "hotspots", "--repo", repo, "--json"], {
      shell: false, windowsHide: true, env: process.env,
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf-8")));
    child.on("error", () => resolve({ hotspots: [] }));
    child.on("exit", () => {
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        resolve({ hotspots: [] });
      }
    });
  });
}

/** Build the sandbox images in the background, streaming into sbxBuild.log. */
function startDockerBuild(factory: string[]): void {
  if (sbxBuild.running) return;
  sbxBuild.running = true; sbxBuild.log = ""; sbxBuild.ok = null;
  const [cmd, ...prefix] = factory;
  const child = spawn(cmd!, [...prefix, "sandbox-build"], {
    shell: false, windowsHide: true, env: process.env,
  });
  const append = (c: Buffer) => { sbxBuild.log = (sbxBuild.log + c.toString("utf-8")).slice(-8000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (err) => { sbxBuild.running = false; sbxBuild.ok = false; sbxBuild.log += `\n${String(err)}`; });
  child.on("exit", (code) => { sbxBuild.running = false; sbxBuild.ok = code === 0; });
}

/* ------------------------------ subscription plan usage ------------------------------ */

// The full plan-usage breakdown (5h session %, weekly %, per-model) that Claude Code's
// interactive /usage shows. Headless `claude -p` doesn't stream it, but the same data
// is served by an OAuth endpoint the CLI itself calls. We read the logged-in
// subscription token from ~/.claude/.credentials.json (server-side — it never reaches
// the browser) and proxy it, cached briefly since that endpoint is itself rate-limited.
// NOTE: undocumented endpoint; Anthropic may change it without notice.
let usageCache: { at: number; data: unknown } | null = null;
// Persist the last good snapshot to disk so a server restart — or a long 429 window
// on this fragile endpoint — never blanks the bars. Loaded lazily on first use.
const USAGE_CACHE_FILE = join(homedir(), ".claude", ".agent-factory-usage.json");
function loadUsageCache(): void {
  if (usageCache) return;
  try { usageCache = JSON.parse(readFileSync(USAGE_CACHE_FILE, "utf-8")); } catch { /* none yet */ }
}
function saveUsageCache(): void {
  try { writeFileSync(USAGE_CACHE_FILE, JSON.stringify(usageCache)); } catch { /* best effort */ }
}
async function subscriptionUsage(): Promise<unknown> {
  loadUsageCache();
  // Serve fresh cache without touching the (itself rate-limited) endpoint.
  if (usageCache && Date.now() - usageCache.at < 120_000) return usageCache.data;
  // On ANY failure (esp. the 429 this endpoint hands out freely), keep showing the
  // last good data rather than blanking the bars — only report an error if we've
  // never succeeded.
  const fallback = (err: unknown): unknown => usageCache?.data ?? { error: String(err).slice(0, 60) };
  let token: string | undefined;
  try {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8");
    token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } })?.claudeAiOauth?.accessToken;
  } catch { /* no credentials file */ }
  if (!token) return usageCache?.data ?? { error: "not-logged-in" };
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallback(`http-${res.status}`);
    const data = await res.json();
    usageCache = { at: Date.now(), data };
    saveUsageCache();
    return data;
  } catch (err) {
    return fallback(err);
  }
}

/* ------------------------------ supervisor chat history ------------------------------ */

// One turn of the operator <-> supervisor conversation. Since the companion and
// the supervisor merged into one thread, each turn also carries the run it was
// said during (gates the reply's one-click suggestions to the live run).
interface ChatMsg {
  who: "you" | "supervisor";
  text: string;
  ts: string;
  run?: string;
  suggestions?: ObsAction[];
}

function chatHistoryFile(ws: Workspace): string {
  return join(ws.workdir, ".supervisor-chat.jsonl");
}

function readChatHistory(ws: Workspace): ChatMsg[] {
  const file = chatHistoryFile(ws);
  if (!existsSync(file)) return [];
  const out: ChatMsg[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ChatMsg); } catch { /* skip a torn line */ }
  }
  return out;
}

function appendChatMsg(ws: Workspace, msg: ChatMsg): void {
  appendFileSync(chatHistoryFile(ws), JSON.stringify(msg) + "\n", "utf-8");
}

/** A chat turn as a timeline Observation. The id is the line index in the
 *  history file — stable across reloads, so the client dedups history vs SSE. */
function chatObs(m: ChatMsg, i: number): Observation {
  const base = { id: `chat#${i}`, ts: m.ts, run: m.run ?? "", degree: 0 as const, level: "info" as const };
  return m.who === "you"
    ? { ...base, icon: "•", text: m.text, kind: "chat", who: "you" }
    : { ...base, icon: "🤖", text: m.text, kind: "briefing",
        ...(m.suggestions?.length ? { suggestions: m.suggestions } : {}) };
}

function chatObservations(ws: Workspace): Observation[] {
  return readChatHistory(ws).map(chatObs);
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
  ".factory/", // the factory's own workspace state, when it lives inside the repo
  "",
].join("\n");

/** Starter factory.yaml written when a project is created, so a new workspace is
 *  never born tool-less (the agents need their toolchain allow-listed, or every
 *  `npm`/`npx`/`node` call is refused and the agent blocks). The allow-list covers
 *  git + the common Node and Python toolchains; tighten it later in Settings. */
function starterFactoryYaml(): string {
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
function excludeLocally(repoDir: string, entry: string): void {
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

/* ------------------------------- capsule engine -------------------------------
 * Generic, app-agnostic runner for a project's capsule.json. The factory knows
 * phases/runners/surfaces; the capsule carries the app-specific commands as DATA.
 * Determinism lives here (declared commands, exit-code gating); the open-ended
 * "how" was decided once when the capsule was generated and then frozen. */

function capsuleGrantsFile(workdir: string): string {
  return join(workdir, "capsule.grants.json");
}
function loadGrants(workdir: string): Set<string> {
  const f = capsuleGrantsFile(workdir);
  if (!existsSync(f)) return new Set();
  try {
    const a = JSON.parse(readFileSync(f, "utf-8"));
    return new Set(Array.isArray(a) ? (a as string[]) : []);
  } catch { return new Set(); }
}
function saveGrants(ws: Workspace): void {
  try { writeFileSync(capsuleGrantsFile(ws.workdir), JSON.stringify([...ws.capsule.grants]), "utf-8"); }
  catch { /* best effort */ }
}

/** Removed-ticket ids (board-only hide, reversible), persisted per workspace. */
function loadHidden(workdir: string): Set<string> {
  const f = join(workdir, "hidden-tickets.json");
  if (!existsSync(f)) return new Set();
  try {
    const a = JSON.parse(readFileSync(f, "utf-8"));
    return new Set(Array.isArray(a) ? (a as string[]) : []);
  } catch { return new Set(); }
}
function saveHidden(ws: Workspace): void {
  try { writeFileSync(join(ws.workdir, "hidden-tickets.json"), JSON.stringify([...ws.hidden]), "utf-8"); }
  catch { /* best effort */ }
}

/** The project's capsule.json path: the existing one (repo root, then repo/.factory,
 *  then the workspace dir), else the default write target (workspace dir, git-excluded). */
function capsuleFile(ws: Workspace): string {
  const repo = workspaceRepo(ws);
  const candidates: string[] = [];
  if (repo) candidates.push(join(repo, "capsule.json"), join(repo, ".factory", "capsule.json"));
  candidates.push(join(ws.workdir, "capsule.json"));
  return candidates.find((f) => existsSync(f)) ?? join(ws.workdir, "capsule.json");
}
function loadCapsule(ws: Workspace): Capsule | null {
  const f = capsuleFile(ws);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf-8")) as Capsule; } catch { return null; }
}

/** Effective env for a HOST step: process env + every granted consent's env,
 *  with granted PATH additions prepended. Container steps stay hermetic (only
 *  their declared env, passed via -e) — host paths would be meaningless there. */
function capsuleEnv(ws: Workspace, capsule: Capsule, extra?: Record<string, string>): NodeJS.ProcessEnv {
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
function spawnStep(ws: Workspace, capsule: Capsule, step: CapsuleStep, repo: string): ChildProcess {
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
const LOOKS_LIKE_SERVICE = -2;
// Extra "this is a server/watcher" signals beyond a printed localhost URL.
const SERVER_READY = /(listening on|server (running|started|listening)|ready in \d|now listening|watching for( file)? changes|waiting for changes|watch mode|nodemon)/i;
const GUARD_GRACE_MS = 8000;

/** Run one step, streaming combined output into `run`; resolves the exit code.
 *  When `guard` is set (one-shot actions), a step that prints a server/watcher
 *  signal and is STILL alive after a grace period is treated as a mislabeled
 *  service: it is killed and resolves LOOKS_LIKE_SERVICE, so the action fails
 *  fast with guidance instead of hanging in "running" forever. */
function runStep(run: CapsuleRun, ws: Workspace, capsule: Capsule, step: CapsuleStep, repo: string, guard = false): Promise<number> {
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
async function runActionSteps(run: CapsuleRun, ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<boolean> {
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
async function runCapsuleAction(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<void> {
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
async function runCapsuleConsent(ws: Workspace, capsule: Capsule, consent: CapsuleConsent, repo: string): Promise<CapsuleRun> {
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
function stopService(ws: Workspace, id: string): void {
  const svc = ws.capsule.services.get(id);
  if (!svc) return;
  if (svc.proc) { killTree(svc.proc); svc.proc = null; }
  svc.state = "stopped";
  svc.url = null;
}

/** Start a long-running service action: run the prep steps to completion, then
 *  keep the final step alive and capture the URL it prints. */
async function startService(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<void> {
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
function captureShell(runStr: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
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
async function capsuleDoctor(ws: Workspace, capsule: Capsule, repo: string): Promise<Record<string, boolean>> {
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
async function capsuleDevices(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<string[]> {
  if (action.surface !== "device-install" || !action.device) return [];
  const { out } = await captureShell(action.device.listCmd, repo, capsuleEnv(ws, capsule));
  const re = new RegExp(action.device.listRegex);
  const ids: string[] = [];
  for (const line of out.split(/\r?\n/)) { const m = re.exec(line.trim()); if (m?.[1]) ids.push(m[1]); }
  return ids;
}

/** Assemble the runtime view the dashboard polls. */
async function capsuleView(ws: Workspace): Promise<CapsuleView> {
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

function onboardingPrompt(): string {
  return [
    'You are the onboarding agent for "Agent Factory", a dashboard that renders a generic project "cockpit" from a capsule.json manifest. Inspect THIS repository (read-only) and emit a capsule.json describing how to build / test / run it, plus the controls to show.',
    "",
    "The host OS is Windows (win32); node, npm and python are on PATH. Prefer runner \"host\" with commands that work on this machine. Use a \"container\" runner (with an \"image\") only for a hermetic build you are confident about.",
    "",
    "Capsule schema (JSON):",
    '{ "version":1, "name":str, "summary":str,',
    '  "doctor":[{"id","label","probe": a shell command that exits 0 when the tool is present}],',
    '  "actions":[{"id","label","description": one concise line (what it does / when to use it, <=100 chars),"icon"?:"play"|"smartphone"|"external"|"eye","primary"?:bool,"steps":[{"run": shell cmd,"cwd"?:relative,"retries"?:int}],"surface"?:"log-stream"|"device-install"|"preview"|"link","service"?:bool,"artifact"?:relative path,"url"?:string (use ${lan} for the LAN base),"consent"?:consentId}],',
    '  "consents":[{"id","title","summary","facts":{"downloads":[{"url","sha256"?}],"writes":[],"env":{},"path":[],"commands":[]},"granted"?:bool}] }',
    "",
    "Guidance: add doctor checks for the toolchain; add actions for the real lifecycle (install deps, build, test, lint, typecheck). Give EVERY action a short \"description\" that explains plainly what it does and when to use it (e.g. dev vs preview: \"Live-reloading dev server for coding\" vs \"Serves the production build to verify the real output\"). CRITICAL — services: the engine runs each step to completion and gates on its exit code. So ANY action whose final command does NOT exit on its own MUST be marked \"service\":true (with \"surface\":\"preview\"); otherwise it would hang forever as a broken \"running\" action. A command is a service if it stays in the foreground serving/watching. Treat these as services WITHOUT EXCEPTION: dev servers (`vite`, `next dev`, `npm run dev`, `webpack serve`, `ng serve`), preview servers (`vite preview`, `serve`), watch modes (anything with `--watch`/`-w`, `vitest` without `run`, `jest --watch`, `tsc --watch`, `nodemon`, `--hot`), and backend servers (`uvicorn`, `gunicorn`, `flask run`, `python -m http.server`, `rails s`, `go run` of an HTTP server, `docker compose up` without `-d`). Conversely, one-shot commands that exit (`npm ci/install`, `npm run build`, `npm test`/`vitest run`, `tsc -b`, `pytest`, linters) are NOT services. If a command COULD stay running and you are unsure, mark it a service. For services, bind all interfaces and a fixed port when the tool allows (e.g. `--host --port 5173`), and the engine keeps the last step alive, captures the localhost URL it prints, and shows an embedded live preview + a Stop control. Mark the most useful action primary:true. Add a consent ONLY if a genuine host install is required (list its raw facts). Keep commands correct for THIS repo (read package.json / pyproject.toml / Makefile / scripts).",
    "",
    "Example (a Node web app):",
    '```json',
    '{"version":1,"name":"My API","summary":"Express REST API.","doctor":[{"id":"node","label":"NODE","probe":"node --version"}],"actions":[{"id":"install","label":"Install deps","description":"Install npm dependencies (run once, or after package.json changes).","steps":[{"run":"npm install"}]},{"id":"test","label":"Test","description":"Run the unit test suite.","icon":"play","primary":true,"steps":[{"run":"npm test"}]},{"id":"build","label":"Build","description":"Compile the production bundle into dist/.","steps":[{"run":"npm run build"}]}]}',
    '```',
    "",
    "Output: reply with ONLY one ```json fenced block containing the capsule for THIS repo. No other text.",
  ].join("\n");
}

/** Run the onboarding agent to generate this project's capsule.json (a draft). */
function generateCapsule(ws: Workspace): void {
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

function provisionPrompt(checks: Array<{ id: string; label: string; probe: string }>): string {
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
async function generateProvision(ws: Workspace): Promise<void> {
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

function fixPrompt(action: CapsuleAction, errorTail: string): string {
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
async function generateFix(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<void> {
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

function chatPrompt(current: Capsule, message: string): string {
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
function generateCapsuleChat(ws: Workspace, message: string): void {
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

function chromeBin(): string | null {
  const cands = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return cands.find((p) => existsSync(p)) ?? null;
}

/** Headless screenshot of `url` to `outPath`. Resolves true if the file appears. */
function screenshotUrl(bin: string, url: string, outPath: string): Promise<boolean> {
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

/** Best-effort probe of the underlying coding-agent CLI version, so the cockpit
 *  can surface "which Claude Code am I driving". Probed once and cached for the
 *  server's life; resolves null if the CLI isn't on PATH (chip stays hidden).
 *  Uses `shell: true` so a Windows `claude.cmd` shim resolves like the binary. */
let agentVersionProbe: Promise<string | null> | null = null;
function agentVersion(): Promise<string | null> {
  if (agentVersionProbe) return agentVersionProbe;
  agentVersionProbe = new Promise<string | null>((r) => {
    let out = "";
    let c: ChildProcess;
    try {
      c = spawn("claude", ["--version"], { shell: true, windowsHide: true });
    } catch {
      r(null);
      return;
    }
    const timer = setTimeout(() => { try { c.kill(); } catch { /* gone */ } r(null); }, 5000);
    c.stdout?.on("data", (d) => { out += String(d); });
    c.on("error", () => { clearTimeout(timer); r(null); });
    c.on("exit", () => {
      clearTimeout(timer);
      const m = out.match(/\d+\.\d+\.\d+/);
      r(m ? m[0] : (out.trim() || null));
    });
  });
  return agentVersionProbe;
}

async function judgeAction(ws: Workspace, capsule: Capsule, action: CapsuleAction, repo: string): Promise<void> {
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

/* --------------------------------- http --------------------------------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolvePromise(body));
  });
}

/** Read the per-install auth secret, creating it on first launch. */
function readOrCreateToken(file: string): string {
  try { const t = readFileSync(file, "utf-8").trim(); if (t) return t; } catch { /* create */ }
  const t = randomBytes(16).toString("hex");
  try { writeFileSync(file, t, "utf-8"); } catch { /* best effort */ }
  return t;
}

function json(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Best-guess LAN IPv4 for reaching this dashboard from another device on the
 * same network. Skips internal (loopback) and non-IPv4 interfaces; prefers a
 * private-range address (192.168/10/172.16-31) over anything else.
 */
function lanIPv4(): string | null {
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

const SAFE_NAME = /^[\w.-]+\.md$/;

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = resolve(here, "..", "public");

  const registry = new Registry(join(opts.workdir, "workspaces.json"));
  registry.load(opts.workdir);

  // Auth: the server binds the LAN (--host 0.0.0.0) for the phone flow, and many
  // endpoints run agents / mutate the repo / spend tokens. Gate every mutation
  // (POST/DELETE) behind a per-install secret; GET stays open (the board is
  // viewable and the phone can download the APK without a token). The operator
  // opens the dashboard once with ?token=… (printed below) — it's then stored.
  const token = readOrCreateToken(join(opts.workdir, ".dashboard-token"));

  // Global (cross-project) learned facts live next to the registry; project-scoped
  // facts live in each workspace's own memory.json.
  const globalMemFile = join(opts.workdir, "memory.global.json");

  setInterval(() => {
    for (const ws of registry.workspaces.values()) {
      const newest = latestRun(ws.tailer.runsDir);
      if (newest && newest !== ws.tailer.run) ws.tailer.switchTo(newest);
      ws.tailer.poll();
      const t = ws.tailer;
      const pending = t.pendingWrapup;
      if (pending) {
        t.pendingWrapup = null;
        composeWrapup(ws, opts.factory, pending.run, pending.counts);
      }
      // Stall: a live run has gone quiet while work is in flight. Fire once per
      // quiet period (anchored on lastEventAt, which a new event would bump).
      if (t.run && !t.runEnded && t.activeTasks.size > 0 && t.lastEventAt > 0
          && Date.now() - t.lastEventAt > STALL_MS && t.lastStallBriefFor !== t.lastEventAt) {
        t.lastStallBriefFor = t.lastEventAt;
        composeStall(ws, opts.factory, t.run, t.lastEventAt, t.activeTasks.size);
      }
      // Periodic stand-up: only when someone is watching and real progress has
      // landed since the last one — so we never spend on a vacuous or unseen one.
      if (t.run && !t.runEnded && t.activeTasks.size > 0 && t.clients.size > 0
          && t.progressSinceStandup > 0 && t.lastStandupAt > 0
          && Date.now() - t.lastStandupAt >= STANDUP_MS) {
        t.lastStandupAt = Date.now();
        t.progressSinceStandup = 0;
        composeStandup(ws, opts.factory, t.run, ++t.standupCount);
      }
    }
  }, 500);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Gate mutations: any POST/DELETE to /api needs the token (header or query).
    // GETs stay open (viewing + phone APK download need no secret).
    if ((req.method === "POST" || req.method === "DELETE") && url.pathname.startsWith("/api/")
        && url.searchParams.get("token") !== token && req.headers["x-factory-token"] !== token) {
      json(res, 401, { ok: false, error: "unauthorized — open the dashboard with the ?token= shown in the server console" });
      return;
    }

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
    if (url.pathname === "/style.css") {
      res.writeHead(200, {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(readFileSync(join(publicDir, "style.css")));
      return;
    }

    /* ---------------- workspace management ---------------- */

    if (url.pathname === "/api/workspaces" && req.method === "GET") {
      json(res, 200, {
        workspaces: [...registry.workspaces.values()].map((ws) => ({
          name: ws.name,
          workdir: ws.workdir,
          repo: workspaceRepo(ws),
          currentRun: ws.tailer.run,
        })),
      });
      return;
    }
    if (url.pathname === "/api/netinfo" && req.method === "GET") {
      const ip = lanIPv4();
      json(res, 200, {
        ip,
        port: opts.port,
        url: ip ? `http://${ip}:${opts.port}` : null,
      });
      return;
    }
    if (url.pathname === "/api/usage" && req.method === "GET") {
      json(res, 200, await subscriptionUsage());
      return;
    }
    if (url.pathname === "/api/docker" && req.method === "GET") {
      const pf = await dockerPreflight(opts.factory);
      json(res, 200, { ...pf, building: sbxBuild.running, buildOk: sbxBuild.ok,
                       buildLog: sbxBuild.log.slice(-4000) });
      return;
    }
    if (url.pathname === "/api/docker/build" && req.method === "POST") {
      if (sbxBuild.running) { json(res, 409, { ok: false, error: "a build is already running" }); return; }
      startDockerBuild(opts.factory);
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/hotspots" && req.method === "GET") {
      const repo = url.searchParams.get("repo");
      if (!repo) { json(res, 400, { hotspots: [], error: "repo is required" }); return; }
      json(res, 200, await hotspotsScan(opts.factory, repo));
      return;
    }
    if (url.pathname === "/api/portfolio" && req.method === "GET") {
      json(res, 200, {
        projects: [...registry.workspaces.values()].map((ws) => ({
          name: ws.name,
          workdir: ws.workdir,
          currentRun: ws.tailer.run,
          running: ws.jobs.run.state === "running",
          ...summarizeRun(ws.tailer.runsDir, ws.tailer.run),
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
    // Create a NEW project: one repo, one dedicated workspace, fully isolated.
    // The workspace state (factory.yaml, backlog, runs, project-maps) lives in
    // <repo>/.factory so it travels with the code and can NEVER bleed into
    // another project the way a reused/shared workspace does.
    if (url.pathname === "/api/projects" && req.method === "POST") {
      try {
        const { repo, name } = JSON.parse(await readBody(req)) as { repo?: string; name?: string };
        if (!repo?.trim()) throw new Error("repository path is required");
        const repoDir = resolve(repo.trim());
        if (!existsSync(repoDir)) throw new Error("repository folder does not exist");
        const base =
          (name?.trim() || basename(repoDir)).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") ||
          "project";
        let wsName = base;
        for (let i = 2; registry.workspaces.has(wsName); i++) wsName = `${base}-${i}`;
        const workdir = join(repoDir, ".factory");
        mkdirSync(join(workdir, "backlog"), { recursive: true });
        const cfgPath = join(workdir, "factory.yaml");
        if (!existsSync(cfgPath)) writeFileSync(cfgPath, starterFactoryYaml(), "utf-8");
        excludeLocally(repoDir, ".factory/");
        registry.register(wsName, workdir, repoDir);
        registry.save();
        json(res, 200, { ok: true, name: wsName, workdir });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname.startsWith("/api/workspaces/") && req.method === "PUT") {
      try {
        const oldName = decodeURIComponent(url.pathname.slice("/api/workspaces/".length));
        const { name } = JSON.parse(await readBody(req)) as { name?: string };
        if (!registry.workspaces.has(oldName)) throw new Error("unknown workspace");
        if (!name || !SAFE_WS.test(name)) throw new Error("bad workspace name");
        if (name !== oldName) {
          if (registry.workspaces.has(name)) throw new Error("name already exists");
          registry.rename(oldName, name);
          registry.save();
        }
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
    // The repo belongs to the PROJECT (like /api/plan does as a side-effect):
    // persist it so it survives reloads, browser switches and the phone. Settings
    // is the one place a project's repo path is set without drafting work.
    if (url.pathname === "/api/repo/path" && req.method === "POST") {
      try {
        const { path } = JSON.parse(await readBody(req)) as { path?: string };
        ws.repo = path?.trim() ? resolve(path.trim()) : null;
        registry.save();
        json(res, 200, { ok: true, repo: ws.repo });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/companion" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 400, 1000);
      // Event-derived observations + persisted LLM briefings, merged by time.
      // The sort is stable, so a briefing settles right after the same-ts events.
      // Events + LLM briefings + the operator's conversation: one merged thread.
      const merged = [...companionTimeline(ws.tailer.runsDir, limit), ...readBriefings(ws), ...chatObservations(ws)]
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
        .slice(-limit);
      json(res, 200, { observations: merged });
      return;
    }

    const backlogDir = join(ws.workdir, "backlog");
    const projectMemFile = join(ws.workdir, "memory.json");

    /* ---------------- learned facts (memory) ---------------- */

    if (url.pathname === "/api/memory" && req.method === "GET") {
      const applied = readApplied(join(ws.workdir, "memory.applied.json"));
      const withCount = (f: Fact): Fact => ({ ...f, applied: applied[f.id] ?? 0 });
      const project = readFacts(projectMemFile).map((f) => withCount({ ...f, scope: "project" as const }));
      const global = readFacts(globalMemFile).map((f) => withCount({ ...f, scope: "global" as const }));
      json(res, 200, { facts: [...global, ...project] });
      return;
    }
    if (url.pathname === "/api/memory" && req.method === "POST") {
      try {
        const { text, scope, ticketId } = JSON.parse(await readBody(req)) as {
          text?: string; scope?: string; ticketId?: string | null;
        };
        if (!text?.trim()) throw new Error("text is required");
        const isGlobal = scope === "global";
        const file = isGlobal ? globalMemFile : projectMemFile;
        const facts = readFacts(file);
        facts.unshift({
          id: "F-" + Date.now().toString(36),
          text: text.trim(),
          scope: isGlobal ? "global" : "project",
          ticketId: ticketId || null,
          createdTs: new Date().toISOString(),
        });
        writeFacts(file, facts);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname.startsWith("/api/memory/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/memory/".length));
      const files = [globalMemFile, projectMemFile];
      if (req.method === "DELETE") {
        for (const file of files) {
          const facts = readFacts(file);
          const next = facts.filter((f) => f.id !== id);
          if (next.length !== facts.length) writeFacts(file, next);
        }
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "PUT") {
        try {
          const body = JSON.parse(await readBody(req)) as {
            text?: string; scope?: string; ticketId?: string | null;
          };
          // Pull the fact out of whichever file holds it (a scope change moves it).
          let existing: Fact | undefined;
          for (const file of files) {
            const facts = readFacts(file);
            const found = facts.find((f) => f.id === id);
            if (found) { existing = found; writeFacts(file, facts.filter((f) => f.id !== id)); }
          }
          if (!existing) throw new Error("fact not found");
          const isGlobal = (body.scope ?? existing.scope) === "global";
          const target = isGlobal ? globalMemFile : projectMemFile;
          const facts = readFacts(target);
          facts.unshift({
            ...existing,
            text: body.text ?? existing.text,
            ticketId: body.ticketId !== undefined ? body.ticketId : existing.ticketId,
            scope: isGlobal ? "global" : "project",
          });
          writeFacts(target, facts);
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
        }
        return;
      }
    }

    /* ---------------- knowledge base (ragmcp docs) ---------------- */

    const kp = knowledgePaths(ws.workdir);
    const configFile = join(ws.workdir, "factory.yaml");

    if (url.pathname === "/api/knowledge" && req.method === "GET") {
      const enabled = existsSync(configFile) && /^\s*mcp_config:/m.test(readFileSync(configFile, "utf-8"));
      json(res, 200, { enabled, ready: existsSync(kp.mcp), docs: readDocs(kp.index) });
      return;
    }
    if (url.pathname === "/api/knowledge" && req.method === "POST") {
      try {
        const { name, content } = JSON.parse(await readBody(req)) as { name?: string; content?: string };
        if (!name?.trim() || !content) throw new Error("name and content are required");
        // Keep only a safe basename; default a .md extension for pasted notes.
        let safe = basename(name.trim()).replace(/[^\w.\- ]+/g, "_");
        if (!extname(safe)) safe += ".md";
        scaffoldKnowledge(ws.workdir, opts.ragmcp); // idempotent; ensures store + config exist
        const file = join(kp.docsDir, safe);
        writeFileSync(file, content, "utf-8");
        const ingest = await runRagmcp(opts.ragmcp, ["ingest", toPosix(file), "--config", toPosix(kp.yaml)], ws.workdir);
        const doc: KnowledgeDoc = {
          id: "K-" + Date.now().toString(36),
          name: safe,
          size: Buffer.byteLength(content, "utf-8"),
          addedTs: new Date().toISOString(),
          chunks: ingest.ok ? Number(ingest.out.match(/chunks_new=(\d+)/)?.[1] ?? 0) : null,
          ...(ingest.ok ? {} : { error: ingest.out.slice(-300) }),
        };
        const docs = readDocs(kp.index).filter((d) => d.name !== safe);
        docs.unshift(doc);
        writeDocs(kp.index, docs);
        // 200 even on ingest failure: the HTTP call succeeded; the failure is a
        // domain result the client reads from doc.error (fetchJSON throws on !2xx).
        json(res, 200, { ok: ingest.ok, doc });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/knowledge/enable" && req.method === "POST") {
      try {
        const { enabled } = JSON.parse(await readBody(req)) as { enabled?: boolean };
        if (enabled) scaffoldKnowledge(ws.workdir, opts.ragmcp);
        setKnowledgeEnabled(configFile, !!enabled);
        json(res, 200, { ok: true, enabled: !!enabled });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname.startsWith("/api/knowledge/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/api/knowledge/".length));
      const docs = readDocs(kp.index);
      const doc = docs.find((d) => d.id === id);
      if (doc) {
        const file = join(kp.docsDir, doc.name);
        if (existsSync(file)) unlinkSync(file);
        // --sync drops from the store any source no longer on disk.
        await runRagmcp(opts.ragmcp, ["ingest", toPosix(kp.docsDir), "--config", toPosix(kp.yaml), "--sync"], ws.workdir);
        writeDocs(kp.index, docs.filter((d) => d.id !== id));
      }
      json(res, 200, { ok: true });
      return;
    }

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
        const { op, task, text, to } = JSON.parse(await readBody(req)) as {
          op?: string; task?: string; text?: string; to?: string;
        };
        const ops = ["pause", "resume", "stop", "kill", "retry", "answer", "approve", "changes", "undo"];
        if (!op || !ops.includes(op)) throw new Error(`op must be one of ${ops.join(", ")}`);
        if (task !== undefined && !/^[\w.-]+$/.test(task)) throw new Error("bad task id");
        if (!ws.tailer.run) throw new Error("no active run");
        // "answer" (to a blocked agent) and "changes" (to a task awaiting approval)
        // carry free text; other ops never do. Cap the length to keep it one line.
        const payload: Record<string, unknown> = { ts: new Date().toISOString(), op, task };
        if (op === "answer") {
          const answer = (text ?? "").trim();
          if (!answer) throw new Error("answer text is required");
          payload.text = answer.slice(0, 4000);
        }
        if (op === "changes") {
          payload.text = (text ?? "").trim().slice(0, 4000);
        }
        if (op === "undo") {
          // A checkpoint SHA to rewind the parked branch to; the dispatcher only
          // honours one it actually handed out, so this is just a shape guard.
          const sha = (to ?? "").trim();
          if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("undo requires a checkpoint sha");
          payload.to = sha;
        }
        appendFileSync(
          join(ws.tailer.runsDir, ws.tailer.run, "control.jsonl"),
          JSON.stringify(payload) + "\n",
          "utf-8",
        );
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
        agentVersion: await agentVersion(),
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
    // Freeze-frame of the running app — headless screenshot of the live preview
    // URL, streamed as PNG. Visual evidence you can hand to the supervisor or keep
    // as proof the build renders (the same infra the capsule judge uses).
    if (url.pathname === "/api/preview/shot" && req.method === "GET") {
      const target = ws.preview.url;
      if (!target) { json(res, 400, { ok: false, error: "no live preview to capture" }); return; }
      const bin = chromeBin();
      if (!bin) { json(res, 400, { ok: false, error: "no Chrome or Edge found to render the screenshot" }); return; }
      const out = join(ws.workdir, ".preview-shot.png");
      if (!(await screenshotUrl(bin, target, out))) {
        json(res, 500, { ok: false, error: "the screenshot could not be captured" });
        return;
      }
      const buf = readFileSync(out);
      res.writeHead(200, { "content-type": "image/png", "content-length": buf.length, "cache-control": "no-store" });
      res.end(buf);
      return;
    }

    /* -------- capsule: the generic, app-agnostic project cockpit -------- */
    if (url.pathname === "/api/capsule" && req.method === "GET") {
      json(res, 200, await capsuleView(ws));
      return;
    }
    if (url.pathname === "/api/capsule/panel" && req.method === "GET") {
      const capsule = loadCapsule(ws);
      const panel = (capsule?.panels ?? []).find((p) => p.id === url.searchParams.get("id"));
      if (!capsule || !panel) { json(res, 404, { ok: false, error: "unknown panel" }); return; }
      if (!panel.source) { json(res, 200, { output: "" }); return; } // html panel: nothing to run
      const { out } = await captureShell(panel.source, workspaceRepo(ws) ?? ws.workdir, capsuleEnv(ws, capsule));
      json(res, 200, { output: out.slice(-4000) });
      return;
    }
    if (url.pathname === "/api/capsule/action" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const action = capsule?.actions.find((a) => a.id === id);
        if (!capsule || !action) throw new Error("unknown action");
        if (ws.capsule.runs.get(action.id)?.state === "running") throw new Error("already running");
        void runCapsuleAction(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/capsule/status" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const r = ws.capsule.runs.get(id);
      json(res, 200, { state: r?.state ?? "idle", output: (r?.output ?? "").slice(-8000) });
      return;
    }
    if (url.pathname === "/api/capsule/generate" && req.method === "POST") {
      if (!workspaceRepo(ws)) { json(res, 400, { ok: false, error: "no repository for this project" }); return; }
      if (ws.capsule.runs.get("__generate__")?.state === "running") { json(res, 409, { ok: false, error: "already generating" }); return; }
      generateCapsule(ws);
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/capsule/provision" && req.method === "POST") {
      if (!loadCapsule(ws)) { json(res, 400, { ok: false, error: "no capsule for this project" }); return; }
      if (ws.capsule.runs.get("__provision__")?.state === "running") { json(res, 409, { ok: false, error: "already provisioning" }); return; }
      void generateProvision(ws);
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/capsule/fix" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const action = capsule?.actions.find((a) => a.id === id);
        if (!capsule || !action) throw new Error("unknown action");
        if (ws.capsule.runs.get(action.id)?.state === "running") throw new Error("already running");
        void generateFix(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/chat" && req.method === "POST") {
      try {
        const { message } = JSON.parse(await readBody(req)) as { message?: string };
        if (!message?.trim()) throw new Error("message is required");
        if (!loadCapsule(ws)) throw new Error("no capsule for this project");
        if (ws.capsule.runs.get("__chat__")?.state === "running") throw new Error("already editing");
        generateCapsuleChat(ws, message.trim());
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/chat/draft" && req.method === "GET") {
      const draft = ws.capsule.chatDraft;
      json(res, 200, { has: !!draft, diff: draft ? capsuleDiff(loadCapsule(ws), draft) : [] });
      return;
    }
    if (url.pathname === "/api/capsule/chat/apply" && req.method === "POST") {
      try {
        if (!ws.capsule.chatDraft) throw new Error("nothing to apply");
        writeFileSync(capsuleFile(ws), JSON.stringify(ws.capsule.chatDraft, null, 2), "utf-8");
        ws.capsule.chatDraft = null;
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/chat/discard" && req.method === "POST") {
      ws.capsule.chatDraft = null;
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/capsule/judge" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const action = capsule?.actions.find((a) => a.id === id);
        if (!capsule || !action) throw new Error("unknown action");
        if (ws.capsule.judgments.get(action.id)?.state === "running") throw new Error("already judging");
        void judgeAction(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/judge" && req.method === "GET") {
      const jr = ws.capsule.judgments.get(url.searchParams.get("id") ?? "");
      json(res, 200, {
        state: jr?.state ?? "idle", output: (jr?.output ?? "").slice(-6000),
        verdict: jr?.verdict ?? null, confidence: jr?.confidence ?? null,
        reasons: jr?.reasons ?? [], hasShot: !!(jr?.shot && existsSync(jr.shot)),
      });
      return;
    }
    if (url.pathname === "/api/capsule/judge/shot" && req.method === "GET") {
      const jr = ws.capsule.judgments.get(url.searchParams.get("id") ?? "");
      if (!jr?.shot || !existsSync(jr.shot)) { json(res, 404, { ok: false, error: "no screenshot" }); return; }
      const buf = readFileSync(jr.shot);
      res.writeHead(200, { "content-type": "image/png", "content-length": buf.length, "cache-control": "no-store" });
      res.end(buf);
      return;
    }
    if (url.pathname === "/api/capsule/service" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const action = capsule?.actions.find((a) => a.id === id);
        if (!capsule || !action || !action.service) throw new Error("not a service action");
        void startService(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/service/stop" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        stopService(ws, id ?? "");
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/service" && req.method === "GET") {
      const s = ws.capsule.services.get(url.searchParams.get("id") ?? "");
      json(res, 200, { state: s?.state ?? "stopped", url: s?.url ?? null, output: (s?.output ?? "").slice(-8000) });
      return;
    }
    if (url.pathname === "/api/capsule/consent" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const consent = (capsule?.consents ?? []).find((c) => c.id === id);
        if (!capsule || !consent) throw new Error("unknown consent");
        const r = await runCapsuleConsent(ws, capsule, consent, workspaceRepo(ws) ?? ws.workdir);
        if (r.state !== "ok") throw new Error(r.output.trim().slice(-400) || "provisioning failed");
        json(res, 200, { ok: true, output: r.output.trim() });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/capsule/artifact" && req.method === "GET") {
      const capsule = loadCapsule(ws);
      const action = capsule?.actions.find((a) => a.id === url.searchParams.get("id"));
      const repo = workspaceRepo(ws) ?? ws.workdir;
      const file = action?.artifact ? join(repo, action.artifact) : null;
      if (!file || !existsSync(file)) { json(res, 404, { ok: false, error: "no artifact built yet" }); return; }
      const buf = readFileSync(file);
      const type = extname(file).toLowerCase() === ".apk"
        ? "application/vnd.android.package-archive" : "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "content-disposition": `attachment; filename="${basename(file)}"`,
        "content-length": buf.length,
        "cache-control": "no-store",
      });
      res.end(buf);
      return;
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const { message } = JSON.parse(await readBody(req)) as { message?: string };
        if (!message?.trim()) throw new Error("message is required");
        if (ws.jobs.chat.state === "running") throw new Error("the supervisor is still answering");
        // Persist the exchange so the conversation survives a reload (the server
        // is the sole writer of this file) AND push each turn over SSE — the
        // conversation lives in the same rail as the companion timeline.
        const run = ws.tailer.run ?? "";
        const userMsg: ChatMsg = { who: "you", text: message.trim(), ts: new Date().toISOString(), run };
        const userIdx = readChatHistory(ws).length;
        appendChatMsg(ws, userMsg);
        pushCompanion(ws, chatObs(userMsg, userIdx));
        // --json: the reply comes back as the ask envelope (structured suggestions
        // → one-click buttons). --stream: per-turn progress on stderr, surfaced live
        // in the rail. The answer is parsed from STDOUT only (stderr holds progress).
        spawnJob(ws, "chat", opts.factory, ["ask", "--json", "--stream", message.trim()], undefined,
          (ok, output, stdout) => {
            const raw = stdout || output || (ok ? "(no answer)" : "The supervisor failed to answer.");
            const { text, suggestions } = parseAnswer(raw);
            const reply: ChatMsg = {
              who: "supervisor", text: text.slice(0, 4000), ts: new Date().toISOString(),
              run: ws.tailer.run ?? "", ...(suggestions.length ? { suggestions } : {}),
            };
            const idx = readChatHistory(ws).length;
            appendChatMsg(ws, reply);
            pushCompanion(ws, chatObs(reply, idx));
          },
          true); // streamProgress: parse per-turn progress into ws.jobs.chat.progress
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/analytics" && req.method === "GET") {
      // One point per run, oldest first — spend/tokens/outcomes over time.
      const runsDir = ws.tailer.runsDir;
      const names = existsSync(runsDir)
        ? readdirSync(runsDir).filter((r) => existsSync(join(runsDir, r, "events.jsonl"))).sort()
        : [];
      const series = names.map((run) => {
        const s = summarizeRun(runsDir, run);
        return {
          run, ts: s.updatedTs, spend: s.spend, tokens: s.tokens,
          merged: s.counts.merged, needs: s.counts.needs, total: s.total,
          mode: s.mode,
        };
      });
      json(res, 200, { series });
      return;
    }

    if (url.pathname === "/api/ticket/complete" && req.method === "POST") {
      // Expand a hand-written ticket into a proper Goal + Done-when body, on demand.
      try {
        const { title, notes } = JSON.parse(await readBody(req)) as { title?: string; notes?: string };
        if (!title?.trim() && !notes?.trim()) throw new Error("write a title or a few notes first");
        const prompt = "You are drafting ONE work ticket for a coding agent working on this project. "
          + "Turn the rough note below into a crisp, single-scope ticket. Reply with GitHub-flavored "
          + "markdown ONLY (no preamble, no code fences): a \"## Goal\" section of 2-4 concrete sentences, "
          + "then a \"## Done when\" checklist of \"- \" acceptance items. Keep it to one focused change.\n\n"
          + `Rough title: ${title?.trim() || "(none)"}\nRough notes: ${notes?.trim() || "(none)"}`;
        const raw = await askOneShot(opts.factory, ws.workdir, prompt);
        const { text } = parseAnswer(raw);
        json(res, 200, { ok: true, body: text });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/ticket/review" && req.method === "POST") {
      // Opt-in companion review: a developer finished a MANUAL ticket by hand and
      // chose to have the AI check it. We hand the model the ticket plus the repo's
      // git diff (working changes, else the last commit) and ask for a review.
      try {
        const { file } = JSON.parse(await readBody(req)) as { file?: string };
        if (!file?.trim()) throw new Error("file is required");
        const ticketPath = join(ws.workdir, "backlog", basename(file));
        if (!existsSync(ticketPath)) throw new Error("ticket not found");
        const content = readFileSync(ticketPath, "utf-8");
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
        const repoRaw = /^repo:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1]?.trim();
        const repo = repoRaw ? resolve(repoRaw) : (workspaceRepo(ws) ?? "");
        if (!repo || !existsSync(join(repo, ".git"))) throw new Error("no git repository to review");
        let diff = (await runCmd("git", ["diff", "HEAD"], repo)).output.trim();
        if (!diff) diff = (await runCmd("git", ["show", "-p", "--stat", "HEAD"], repo)).output.trim();
        diff = diff.slice(0, 28_000);
        const prompt = "A developer says they finished this ticket BY HAND (not the AI). Review their work "
          + "as a careful code reviewer: does it fulfil the ticket, and are there bugs, gaps, missing tests, "
          + "or risks? Be concise and concrete; if it looks solid, say so plainly. Do not take any action.\n\n"
          + `# Ticket\n${content}\n\n# Repository changes\n`
          + (diff || "(no diff found — review from the ticket intent and by reading the repo files)");
        const raw = await askOneShot(opts.factory, ws.workdir, prompt);
        const { text } = parseAnswer(raw);
        json(res, 200, { ok: true, review: text });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/plan" && req.method === "POST") {
      try {
        const { goal, repo, ask, clarifications } = JSON.parse(await readBody(req)) as
          { goal?: string; repo?: string; ask?: boolean; clarifications?: string };
        if (!goal?.trim()) throw new Error("goal is required");
        if (!repo?.trim()) throw new Error("repo path is required");
        if (ws.jobs.plan.state === "running" || ws.jobs.run.state === "running") {
          throw new Error("a job is already running in this workspace");
        }
        // Remember the repo on the workspace: it survives reloads, browser
        // switches and the phone — the repo belongs to the project, not the tab.
        ws.repo = resolve(repo.trim());
        registry.save();
        // Fold the operator's answers into the goal so the ticket pass plans with
        // them in hand — the planner is stateless between the ask and draft passes.
        const goalText = clarifications?.trim()
          ? `${goal.trim()}\n\n## Operator's answers to clarifying questions\n${clarifications.trim()}`
          : goal.trim();
        const args = ["plan", goalText, "--repo", repo.trim()];
        if (ask) args.push("--ask");
        // In the ask pass, parse the questions the planner emitted and hang them
        // off the plan job for the cockpit to render (the pass writes no drafts).
        const onDone = ask
          ? (ok: boolean, _out: string, stdout: string): void => {
              if (!ok) return;
              const qs = parsePlanQuestions(stdout);
              if (qs && qs.length) ws.jobs.plan.questions = qs;
              else {
                ws.jobs.plan.state = "error";
                ws.jobs.plan.output += "\n(the planner returned no clarifying questions — try again or skip plan mode)";
              }
            }
          : undefined;
        spawnJob(ws, "plan", opts.factory, args, undefined, onDone);
        // spawnJob replaced the job object; tag the fresh one so /api/status tells
        // the client which pass is running and to clear any stale questions.
        ws.jobs.plan.mode = ask ? "questions" : "tickets";
        ws.jobs.plan.questions = undefined;
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
        // The run reads project lessons from its own workdir; the shared global
        // lessons live outside it, so hand their path over explicitly.
        spawnJob(ws, "run", opts.factory, args, { FACTORY_GLOBAL_MEMORY: globalMemFile });
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/tickets/hidden" && req.method === "GET") {
      json(res, 200, { hidden: [...ws.hidden] });
      return;
    }
    if ((url.pathname === "/api/tickets/hide" || url.pathname === "/api/tickets/unhide") && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        if (!id) throw new Error("id is required");
        if (url.pathname.endsWith("/hide")) ws.hidden.add(id); else ws.hidden.delete(id);
        saveHidden(ws);
        json(res, 200, { ok: true, hidden: [...ws.hidden] });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
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
      // The client saves via postJSON (POST); accept PUT too for symmetry.
      if (req.method === "PUT" || req.method === "POST") {
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
    console.log(`open:      http://localhost:${opts.port}/?token=${token}`);
  });
}

main();

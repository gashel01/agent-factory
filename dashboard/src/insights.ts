/** The fs layer under the two pure cores.
 *
 *  `diagnostics.ts` and `forecast.ts` do no I/O by design: they take events,
 *  ticket text and run records, and return verdicts. This module is the only
 *  place that knows those things live on disk — it reads a run's events.jsonl,
 *  an agent's stdout log and the backlog, feeds them in, and persists the one
 *  thing the cores cannot: the estimate an operator accepted before a launch.
 *
 *  No HTTP and no React live here. The route group calls these functions and
 *  turns what they return (or throw) into a response; keeping the split means
 *  the whole layer is testable without a server.
 *
 *  Two rules run through everything below:
 *
 *  1. Reading is TOTAL. A missing directory, a truncated last line, a file
 *     someone hand-edited into invalid JSON — none of these throw. The operator
 *     opening a diagnosis on a half-written run gets the honest partial answer
 *     the cores are built to produce, not a stack trace.
 *  2. Ids are REJECTED, never repaired. Every run/task id reaching a path comes
 *     from a query string, so it is validated against the same `[\w.-]+` guard
 *     the /api/log and /api/control routes use AND re-checked after `resolve`.
 *     Clamping a traversal to something inside the base would silently serve a
 *     different file than the caller asked for; throwing surfaces the attempt.
 */

import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { diagnose } from "./diagnostics.js";
import type { Diagnosis, DiagnosisCategory, ErrorPatternSummary } from "./diagnostics.js";
import {
  forecastRun, historyStats, parseTicket, PROFILE_NAMES, PROFILES, reconcile,
} from "./forecast.js";
import type {
  Actuals, Forecast, HistoryStats, ProfileName, Reconciliation, RunRecord, Ticket,
} from "./forecast.js";
import { summarizeRun } from "./server-core.js";
import type { FactoryEvent } from "./types.js";

/* ============================ Path safety ============================ */

/** The guard POST /api/control and GET /api/log already apply to task ids. */
export const SAFE_ID = /^[\w.-]+$/;

/** `.` and `..` both match SAFE_ID, so they are excluded by name: they are the
 *  two ids that resolve to a directory the caller never asked for. */
export function isSafeId(id: unknown): id is string {
  return typeof id === "string"
    && id.length > 0
    && id.length <= 200
    && id !== "."
    && id !== ".."
    && SAFE_ID.test(id);
}

/**
 * Resolve `id` inside `base`, or return null.
 *
 * The regex alone would be enough today, but it is one edit away from letting a
 * separator through; the containment check is the invariant that actually
 * matters, so it is asserted on the RESOLVED path rather than assumed from the
 * shape of the input. Symlink resolution is deliberately not attempted — the
 * runs directory is written by the factory itself, not by untrusted callers.
 */
export function safeJoin(base: string, id: unknown): string | null {
  if (!isSafeId(id)) return null;
  const root = resolve(base);
  const target = resolve(root, id);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}

/** Same as safeJoin, but loud — for the callers that must answer with a 400. */
function requireJoin(base: string, id: unknown, what: string): string {
  const path = safeJoin(base, id);
  if (!path) throw new Error(`bad ${what} id`);
  return path;
}

/** A run's directory, or null when the id is unusable. Callers that only read
 *  (and are happy with an empty answer) use this; callers that must report the
 *  rejection use `requireRun`. */
function runDir(runsDir: string, run: string | null | undefined): string | null {
  if (!run) return null;
  return safeJoin(runsDir, run);
}

/**
 * Validate an explicitly requested run id: it must be well-formed AND exist.
 * `null`/empty means "no run selected", which is not an error — a workspace
 * that has never been launched has no current run, and the caller renders an
 * empty state rather than a failure.
 */
export function requireRun(runsDir: string, run: string | null | undefined): string | null {
  if (run === null || run === undefined || run === "") return null;
  const dir = requireJoin(runsDir, run, "run");
  if (!existsSync(join(dir, "events.jsonl"))) throw new Error("unknown run");
  return run;
}

/**
 * Choose which run a request is about. An id the caller typed is validated
 * strictly (a typo must be visible, not silently answered about another run);
 * the tailer's own current run is trusted but still shape-checked, since it
 * ends up in a path just the same.
 */
export function pickRun(
  runsDir: string,
  requested: string | null | undefined,
  current: string | null | undefined,
): string | null {
  const asked = typeof requested === "string" ? requested.trim() : "";
  if (asked) return requireRun(runsDir, asked);
  return isSafeId(current) ? current : null;
}

/* ============================ Reading a run ============================ */

/**
 * One run's events, corrupt lines skipped.
 *
 * events.jsonl is append-only and read while it is being written, so the last
 * line is regularly a half-flushed object. Dropping it costs one event; letting
 * JSON.parse throw would cost the whole diagnosis.
 */
export function readRunEvents(runsDir: string, run: string | null | undefined): FactoryEvent[] {
  const dir = runDir(runsDir, run);
  if (!dir) return [];
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out: FactoryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as FactoryEvent);
      }
    } catch {
      /* a truncated or hand-mangled line — the rest of the run is still usable */
    }
  }
  return out;
}

/** Run ids that actually carry events, oldest first (the ids are timestamps, so
 *  a lexical sort is chronological). A directory without an events.jsonl is a
 *  scaffolding leftover, not a run. */
export function listRuns(runsDir: string): string[] {
  if (!runsDir || !existsSync(runsDir)) return [];
  try {
    return readdirSync(runsDir)
      .filter((name) => existsSync(join(runsDir, name, "events.jsonl")))
      .sort();
  } catch {
    return [];
  }
}

/** Bytes of an agent log the diagnosis is allowed to see. The parser only ever
 *  uses the last records and the tail lines, so reading a run-long stream-json
 *  file in full would cost megabytes to reach the same verdict. */
export const AGENT_LOG_TAIL_BYTES = 256_000;

/**
 * The last `max` bytes of a file, as text. Reads from an offset instead of
 * slicing a full read: the whole point is not to hold an unbounded file in
 * memory. The first (partial) line of a mid-file cut is dropped so the JSONL
 * parser is never handed half a record.
 */
export function tailFile(file: string, max: number = AGENT_LOG_TAIL_BYTES): string {
  if (!file || !existsSync(file)) return "";
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    if (size <= 0) return "";
    const start = Math.max(0, size - Math.max(1, max));
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = openSync(file, "r");
    const read = readSync(fd, buf, 0, length, start);
    const text = buf.subarray(0, read).toString("utf-8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : "";
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed or gone */
      }
    }
  }
}

/** The tail of one task's agent stdout, or "" when it has none yet. */
export function readAgentLog(
  runsDir: string,
  run: string | null | undefined,
  taskId: string,
): string {
  const dir = runDir(runsDir, run);
  if (!dir || !isSafeId(taskId)) return "";
  const agents = join(dir, "agents");
  const file = safeJoin(agents, `${taskId}.stdout.jsonl`);
  return file ? tailFile(file) : "";
}

/**
 * Why one ticket ended the way it did.
 *
 * A missing agent log is normal, not an error: a task can fail in the queue, in
 * verification or in the merge without the agent ever writing a line, and the
 * events alone are enough to diagnose those. Bad ids, on the other hand, throw
 * — see the module header.
 */
export function diagnoseTask(
  runsDir: string,
  run: string | null | undefined,
  taskId: string,
): Diagnosis {
  if (!isSafeId(taskId)) throw new Error("bad task id");
  if (run !== null && run !== undefined && run !== "") requireJoin(runsDir, run, "run");
  return diagnose({
    taskId,
    events: readRunEvents(runsDir, run),
    agentLog: readAgentLog(runsDir, run, taskId),
  });
}

/* ============================ Backlog ============================ */

/** Every pending ticket, parsed. `backlog/done/` is skipped for free: it is a
 *  directory, not a `.md`. One unreadable ticket is dropped rather than sinking
 *  the estimate for all the others. */
export function readBacklogTickets(workdir: string): Ticket[] {
  const dir = join(workdir, "backlog");
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: Ticket[] = [];
  for (const name of names) {
    try {
      out.push(parseTicket(name, readFileSync(join(dir, name), "utf-8")));
    } catch {
      /* unreadable ticket — the rest of the backlog still forecasts */
    }
  }
  return out;
}

/* ============================ Forecasting ============================ */

/** Past runs in the shape `historyStats` expects. `summarizeRun` owns the spend
 *  rule (the authoritative running total when present, else the sum of per-agent
 *  costs), so it is reused rather than re-implemented. */
export function runRecords(runsDir: string, exceptRun?: string | null): RunRecord[] {
  return listRuns(runsDir)
    .filter((run) => run !== exceptRun)
    .map((run) => {
      const s = summarizeRun(runsDir, run);
      return {
        run,
        ts: s.updatedTs,
        spend: s.spend,
        tokens: s.tokens,
        merged: s.counts.merged,
        needs: s.counts.needs,
        total: s.total,
        mode: s.mode,
      };
    });
}

export interface ForecastBundle {
  /** What the three estimates were built on — shown so the operator can judge
   *  how much the numbers are worth. */
  history: HistoryStats;
  tickets: number;
  slots: number;
  forecasts: Record<ProfileName, Forecast>;
}

/**
 * One estimate per profile over the current backlog, all three built on the
 * same history so they are comparable — the operator is choosing between them,
 * and a difference must come from the profile, never from the sampling.
 */
export function buildForecasts(workdir: string, runsDir: string, slots?: number): ForecastBundle {
  const tickets = readBacklogTickets(workdir);
  const history = historyStats(runRecords(runsDir));
  const wanted = typeof slots === "number" && Number.isFinite(slots) && slots > 0 ? slots : undefined;
  const forecasts = {} as Record<ProfileName, Forecast>;
  for (const name of PROFILE_NAMES) {
    forecasts[name] = forecastRun(tickets, { profile: PROFILES[name], slots: wanted, history });
  }
  return { history, tickets: tickets.length, slots: forecasts.standard.slots, forecasts };
}

/* ==================== Pending / attached forecasts ==================== */

/** The estimate an operator accepted, as it is stored on disk. */
export interface StoredForecast {
  profile: ProfileName;
  forecast: Forecast;
  /** When it was accepted, ISO-8601. */
  ts: string;
}

/** Written before the launch, when the run it belongs to has no id yet. */
const PENDING_FILE = "forecast-pending.json";
/** Where it lands once that run exists. */
const RUN_FILE = "forecast.json";

export function pendingForecastFile(workdir: string): string {
  return join(workdir, PENDING_FILE);
}

function isProfileName(s: unknown): s is ProfileName {
  return typeof s === "string" && (PROFILE_NAMES as readonly string[]).includes(s);
}

/** Read a stored estimate, shape-checked. Anything that is not a recognisable
 *  `{ profile, forecast }` degrades to null: an estimate we cannot trust is the
 *  same as no estimate, and must never break the panel that displays it. */
function readStored(file: string): StoredForecast | null {
  if (!existsSync(file)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const forecast = rec.forecast;
    if (!isProfileName(rec.profile)) return null;
    if (!forecast || typeof forecast !== "object" || Array.isArray(forecast)) return null;
    return {
      profile: rec.profile,
      forecast: forecast as Forecast,
      ts: typeof rec.ts === "string" ? rec.ts : "",
    };
  } catch {
    return null;
  }
}

/**
 * Persist the estimate the operator accepted, BEFORE the run is spawned.
 *
 * The order is the point: the dispatcher picks the run id itself, so there is a
 * window where the run exists and the estimate does not. Writing first means a
 * launch that crashes mid-spawn still leaves the estimate behind, and nothing
 * can later be scored against a forecast that was never recorded.
 *
 * Throws on an unknown profile — the caller turns that into a 400 and does NOT
 * start the run, rather than launching against an estimate we cannot name.
 */
export function savePendingForecast(
  workdir: string,
  profile: unknown,
  forecast: unknown,
  ts?: string,
): StoredForecast {
  if (!isProfileName(profile)) {
    throw new Error(`profile must be one of ${PROFILE_NAMES.join(", ")}`);
  }
  if (!forecast || typeof forecast !== "object" || Array.isArray(forecast)) {
    throw new Error("forecast is required");
  }
  const stored: StoredForecast = {
    profile,
    forecast: forecast as Forecast,
    ts: typeof ts === "string" && ts ? ts : new Date().toISOString(),
  };
  mkdirSync(workdir, { recursive: true });
  writeFileSync(pendingForecastFile(workdir), JSON.stringify(stored, null, 2), "utf-8");
  return stored;
}

export function readPendingForecast(workdir: string): StoredForecast | null {
  return readStored(pendingForecastFile(workdir));
}

export function clearPendingForecast(workdir: string): void {
  try {
    const file = pendingForecastFile(workdir);
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* nothing to clear */
  }
}

/** The estimate already attached to a run, if any. */
export function readRunForecast(runsDir: string, run: string | null | undefined): StoredForecast | null {
  const dir = runDir(runsDir, run);
  return dir ? readStored(join(dir, RUN_FILE)) : null;
}

/**
 * Move the pending estimate into the run it turned out to belong to.
 *
 * Called lazily (on read) rather than at launch, because the run directory does
 * not exist yet when the operator accepts the estimate — only the dispatcher
 * knows the id, and it creates the directory itself. The first read once that
 * directory exists claims the pending file; an estimate already attached always
 * wins, so a second launch cannot rewrite the first run's history.
 */
export function attachForecastToRun(
  workdir: string,
  runsDir: string,
  run: string | null | undefined,
): StoredForecast | null {
  const dir = runDir(runsDir, run);
  if (!dir || !existsSync(dir)) return null;
  const attached = readStored(join(dir, RUN_FILE));
  if (attached) return attached;
  const pending = readPendingForecast(workdir);
  if (!pending) return null;
  try {
    writeFileSync(join(dir, RUN_FILE), JSON.stringify(pending, null, 2), "utf-8");
    clearPendingForecast(workdir);
  } catch {
    /* keep the pending file so a later read retries the attach */
  }
  return pending;
}

/* ============================ Reconciliation ============================ */

interface ActualRow {
  id: string;
  title: string;
  usd: number;
  tokens: number;
}

/**
 * What a run actually cost.
 *
 * The TOTALS come from `summarizeRun` — it already encodes which number is
 * authoritative, and re-deriving it here would be a second answer to the same
 * question. Only the per-ticket split, which no existing helper reports for a
 * run you are currently looking at, is folded from the events.
 */
export function actualsFor(runsDir: string, run: string | null | undefined): Actuals {
  const summary = summarizeRun(runsDir, run ?? null);
  const rows = new Map<string, ActualRow>();
  const titles = new Map<string, string>();
  for (const event of readRunEvents(runsDir, run)) {
    const e = event as unknown as Record<string, unknown>;
    if (e.event === "run_start" && Array.isArray(e.tasks)) {
      for (const t of e.tasks as unknown[]) {
        if (!t || typeof t !== "object") continue;
        const rec = t as Record<string, unknown>;
        if (typeof rec.id === "string") {
          titles.set(rec.id, typeof rec.title === "string" && rec.title ? rec.title : rec.id);
        }
      }
    }
    if (e.event !== "agent_result" || typeof e.task !== "string") continue;
    const row = rows.get(e.task) ?? { id: e.task, title: e.task, usd: 0, tokens: 0 };
    if (typeof e.cost_usd === "number") row.usd += e.cost_usd;
    if (typeof e.input_tokens === "number") row.tokens += e.input_tokens;
    if (typeof e.output_tokens === "number") row.tokens += e.output_tokens;
    rows.set(e.task, row);
  }
  const tickets = [...rows.values()].map((r) => ({ ...r, title: titles.get(r.id) ?? r.title }));
  return { tickets, usd: summary.spend, tokens: summary.tokens };
}

/**
 * Score a run against the estimate it was launched on. `null` when no estimate
 * was ever stored for it — most runs are launched straight from the board, and
 * "we never predicted this one" is an answer, not a failure.
 */
export function reconcileRun(
  workdir: string,
  runsDir: string,
  run: string | null | undefined,
): Reconciliation | null {
  const stored = attachForecastToRun(workdir, runsDir, run);
  if (!stored) return null;
  return reconcile(stored.forecast, actualsFor(runsDir, run));
}

export function analyzeErrorPatterns(runsDir: string, run: string): ErrorPatternSummary {
  const events = readRunEvents(runsDir, run);
  const taskIds = new Set<string>();
  const errorCounts: Record<DiagnosisCategory, number> = {
    verify_failed: 0,
    agent_error: 0,
    blocked: 0,
    merge_conflict: 0,
    timeout: 0,
    rate_limit: 0,
    budget: 0,
    stopped: 0,
    unknown: 0,
  };

  for (const event of events) {
    const e = event as unknown as Record<string, unknown>;
    if (typeof e.task === "string" && e.task) {
      taskIds.add(e.task);
    }
  }

  for (const taskId of taskIds) {
    const diagnosis = diagnose({ taskId, events, agentLog: "" });
    errorCounts[diagnosis.category]++;
  }

  return {
    run,
    taskCount: taskIds.size,
    errorCounts,
  };
}

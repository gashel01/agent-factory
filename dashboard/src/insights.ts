/** Filesystem layer for the two pure cores: `diagnostics.ts` (why a task failed)
 *  and `forecast.ts` (what a run will cost, and what it really cost).
 *
 *  Those modules deliberately take already-read strings and hand back plain data.
 *  Something has to read the run directory, the agent logs, the backlog and the
 *  persisted forecasts — and it cannot be `server.ts`, which calls main() at import
 *  time and can therefore never be pulled into a unit test. So the glue lives here:
 *  every route in server.ts is a two-liner delegating to a function below, and this
 *  file is testable against a temp directory.
 *
 *  Total by construction: a missing file, a torn last line, an unreadable JSON blob
 *  or an unknown id yields an empty result or `null`, never a throw — the one
 *  exception is `savePendingForecast`, where silently dropping the operator's
 *  choice would be worse than a 400.
 *
 *  Every path is built from a VALIDATED id. Run and task ids come off the query
 *  string, so `isSafeId` is the only thing standing between a caller and the rest
 *  of the disk. */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diagnose, type Diagnosis } from "./diagnostics.js";
import {
  PROFILE_IDS,
  PROFILES,
  forecastRun,
  historyStats,
  parseTicket,
  reconcile,
  type Forecast,
  type HistoryStats,
  type Profile,
  type Reconciliation,
  type TicketMeta,
} from "./forecast.js";

/* --------------------------------- guards --------------------------------- */

/** The task-id shape `/api/log` already enforces. `..` matches it (a dot is a word
 *  character's neighbour here), so it is excluded separately — otherwise a run id
 *  of ".." would walk out of the runs directory. */
const SAFE_ID = /^[\w.-]+$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && SAFE_ID.test(id) && !id.includes("..");
}

/* ------------------------------- run events ------------------------------- */

/** Every parseable line of a run's events.jsonl, in order.
 *
 *  Tolerant on purpose: the file is appended to live, so the last line is routinely
 *  half-written when we read it. A torn or malformed line is skipped, not fatal. */
export function readRunEvents(runsDir: string, run: string): Record<string, unknown>[] {
  if (!isSafeId(run)) return [];
  const file = join(runsDir, run, "events.jsonl");
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return []; // no such run, or it has not written an event yet
  }
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue; // torn tail of a live file
    }
  }
  return events;
}

/** Run ids that actually have an event log, oldest first. Run ids are timestamps
 *  (`2026-08-09_025052`), so a lexical sort IS chronological. */
export function listRuns(runsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => isSafeId(name) && existsSync(join(runsDir, name, "events.jsonl")))
    .sort();
}

/* ------------------------------- diagnostics ------------------------------- */

/** How much of an agent's stdout log to feed the analyser. The interesting part of
 *  a failure is always at the end, and these files reach tens of megabytes. */
const AGENT_LOG_TAIL_BYTES = 256 * 1024;

/** Last `maxBytes` of a file, without reading the rest of it into memory. */
function readTail(file: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    const text = buf.toString("utf-8");
    if (start === 0) return text;
    // Seeking to a byte offset lands mid-line (and possibly mid-code-point). The
    // leading fragment is not valid JSON, so drop it instead of feeding garbage in.
    const nl = text.indexOf("\n");
    return nl === -1 ? "" : text.slice(nl + 1);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already gone */ }
    }
  }
}

function agentLogFile(runsDir: string, run: string, taskId: string): string {
  return join(runsDir, run, "agents", `${taskId}.stdout.jsonl`);
}

/** Task ids the run declared up front, so a task that was planned but never emitted
 *  an event of its own still counts as known rather than as a typo. */
function declaredTasks(events: ReadonlyArray<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const ev of events) {
    if (ev["event"] !== "run_start") continue;
    const tasks = ev["tasks"];
    if (!Array.isArray(tasks)) continue;
    for (const t of tasks) {
      // Pre-0.2 logs list bare id strings; newer ones list objects.
      if (typeof t === "string") ids.add(t);
      else if (t && typeof t === "object") {
        const id = (t as Record<string, unknown>)["id"];
        if (typeof id === "string" && id) ids.add(id);
      }
    }
  }
  return ids;
}

/** Diagnose one task of one run: its events plus the tail of its agent log.
 *
 *  Returns `null` — not an empty diagnosis — when the id is unsafe or the run knows
 *  nothing about that task, so the route can answer 404 instead of inventing a
 *  confident-looking "unknown" verdict for a typo. */
export function diagnoseTask(runsDir: string, run: string, taskId: string): Diagnosis | null {
  if (!isSafeId(run) || !isSafeId(taskId)) return null;
  const events = readRunEvents(runsDir, run);
  const logFile = agentLogFile(runsDir, run, taskId);
  const hasLog = existsSync(logFile);
  const known =
    hasLog
    || events.some((ev) => ev["task"] === taskId)
    || declaredTasks(events).has(taskId);
  if (!known) return null;
  return diagnose({
    taskId,
    events,
    agentLog: hasLog ? readTail(logFile, AGENT_LOG_TAIL_BYTES) : "",
  });
}

/* --------------------------------- backlog --------------------------------- */

/** Every `backlog/*.md` parsed into its front matter, sorted by filename (which is
 *  the order the dispatcher considers them in). */
export function readBacklogTickets(backlogDir: string): TicketMeta[] {
  let names: string[];
  try {
    names = readdirSync(backlogDir);
  } catch {
    return [];
  }
  const tickets: TicketMeta[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    try {
      tickets.push(parseTicket(name, readFileSync(join(backlogDir, name), "utf-8")));
    } catch {
      continue; // unreadable file: one bad ticket must not sink the whole quote
    }
  }
  return tickets;
}

/* --------------------------------- forecast -------------------------------- */

/** What the client needs to render the quote picker, on the wire. */
export interface ForecastHistory {
  runs: number;
  samples: number;
  /** How the numbers were produced — identical across profiles, since it depends
   *  only on how much history there is. */
  basis: Forecast["basis"];
  retryRate: number;
  medianCostUsd: number;
}

export interface ForecastBundle {
  profiles: Profile[];
  tickets: TicketMeta[];
  /** One forecast per profile, in `PROFILE_IDS` order. */
  forecasts: Forecast[];
  history: ForecastHistory;
}

export interface BuildForecastsOptions {
  /** Exclude a run from the calibration sample — the run being forecast should not
   *  predict itself. */
  exceptRun?: string | null;
}

/** Quote the current backlog under every profile, calibrated against past runs.
 *
 *  Deliberately NOT passing factory.yaml's agent.model as `defaultModel`: it would
 *  override each profile's own model and collapse the three quotes into one. */
export function buildForecasts(
  runsDir: string,
  backlogDir: string,
  opts: BuildForecastsOptions = {},
): ForecastBundle {
  const tickets = readBacklogTickets(backlogDir);
  const except = opts.exceptRun ?? null;
  const past = listRuns(runsDir)
    .filter((run) => run !== except)
    .map((run) => ({ run, events: readRunEvents(runsDir, run) }));
  const history: HistoryStats = historyStats(past);
  const forecasts = PROFILE_IDS.map((id) => forecastRun(tickets, { profile: id, history }));
  return {
    profiles: PROFILE_IDS.map((id) => PROFILES[id]),
    tickets,
    forecasts,
    history: {
      runs: history.runs,
      samples: history.samples,
      basis: forecasts[0]?.basis ?? "heuristic",
      retryRate: history.retryRate,
      medianCostUsd: history.medianCostUsd,
    },
  };
}

/* --------------------------- predicted vs actual --------------------------- */

/** A forecast the operator committed to, on its way to (or already bound to) a run. */
export interface StoredForecast {
  /** The profile they picked; `forecast.profile` after normalisation. */
  profile: string;
  /** ISO timestamp of the moment it was committed. */
  savedAt: string;
  /** The run it ended up describing — absent while still pending. */
  run?: string;
  forecast: Forecast;
}

const PENDING = "pending.json";

function forecastsDir(workdir: string): string {
  return join(workdir, "forecasts");
}

function readStored(file: string): StoredForecast | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const stored = parsed as StoredForecast;
    return Array.isArray(stored.forecast?.perTask) ? stored : null;
  } catch {
    return null; // hand-edited or half-written: treat as "no forecast"
  }
}

/** The forecast bound to a given run, if one was ever committed for it. */
export function readForecastFor(workdir: string, run: string): StoredForecast | null {
  if (!isSafeId(run)) return null;
  return readStored(join(forecastsDir(workdir), `${run}.json`));
}

/** Park the operator's chosen quote before the run exists.
 *
 *  `factory run` mints the run id itself, so at POST time there is nothing to key
 *  the forecast on; it waits under `forecasts/pending.json` until the tailer sees
 *  the run appear. Throws on a malformed forecast — losing the choice silently
 *  would leave the operator with a reconciliation that never arrives. */
export function savePendingForecast(
  workdir: string,
  forecast: Forecast,
  profile?: string,
  now: Date = new Date(),
): StoredForecast {
  if (!forecast || typeof forecast !== "object" || !Array.isArray(forecast.perTask)) {
    throw new Error("forecast must be an object with a perTask array");
  }
  const stored: StoredForecast = {
    profile: String(profile ?? forecast.profile ?? ""),
    savedAt: now.toISOString(),
    forecast,
  };
  const dir = forecastsDir(workdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PENDING), JSON.stringify(stored, null, 2), "utf-8");
  return stored;
}

/** Bind the pending forecast to a run id, once one is known.
 *
 *  Called from the poll loop on every tick, so the miss path costs a single stat.
 *  Idempotent and non-destructive: a run that already has a forecast keeps it, and
 *  the pending file is only consumed once it has actually been written somewhere. */
export function attachPendingForecast(workdir: string, run: string): StoredForecast | null {
  if (!isSafeId(run)) return null;
  const dir = forecastsDir(workdir);
  const pending = join(dir, PENDING);
  if (!existsSync(pending)) return null;

  const target = join(dir, `${run}.json`);
  const already = readStored(target);
  // Never overwrite: the first binding is the prediction we must be judged against.
  if (already) return already;

  const stored = readStored(pending);
  if (!stored) {
    // Unparseable pending file: drop it rather than re-reading it forever.
    try { unlinkSync(pending); } catch { /* raced with another binder */ }
    return null;
  }
  const bound: StoredForecast = { ...stored, run };
  try {
    writeFileSync(target, JSON.stringify(bound, null, 2), "utf-8");
  } catch {
    return null; // keep the pending file so the next tick can retry
  }
  try { unlinkSync(pending); } catch { /* already consumed */ }
  return bound;
}

/** Every task's real spend, summed over attempts.
 *
 *  A retried task emits one `agent_result` per attempt and the operator is billed
 *  for all of them, so the actual cost is the SUM — the forecast already carries a
 *  retry allowance on the predicted side. */
export function actualCosts(
  events: ReadonlyArray<Record<string, unknown>>,
): Array<{ id: string; costUsd: number }> {
  const totals = new Map<string, number>();
  for (const ev of events) {
    if (ev["event"] !== "agent_result") continue;
    const id = ev["task"];
    if (typeof id !== "string" || !id) continue;
    const cost = ev["cost_usd"];
    const usd = typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
    totals.set(id, (totals.get(id) ?? 0) + usd);
  }
  return [...totals].map(([id, costUsd]) => ({ id, costUsd }));
}

/** Compare what a run was quoted at against what it really spent. `null` when no
 *  forecast was ever committed for that run — there is nothing to reconcile, which
 *  is not the same as a reconciliation that came out at zero. */
export function reconcileRun(workdir: string, runsDir: string, run: string): Reconciliation | null {
  if (!isSafeId(run)) return null;
  const stored = readForecastFor(workdir, run);
  if (!stored) return null;
  return reconcile(stored.forecast, actualCosts(readRunEvents(runsDir, run)));
}

/**
 * The companion timeline — a narrated, human-friendly layer over the factory's
 * ground-truth `events.jsonl`. It is a PURE FUNCTION of the events: the same
 * mapper drives both the historical fold (`foldCompanion`, for "what happened in
 * this project") and the live SSE feed (the server calls `observe` per new line).
 * Deriving from events means the journal is always correct — no separate file to
 * keep in sync, no offset/dedup bugs.
 *
 * The personality toggle lives in the CLIENT: every observation carries a
 * `degree` (the minimum verbosity level at which it should surface) and a
 * `level` (its severity, which drives colour and desktop notifications). The
 * server emits everything; the client filters what to show and ping about.
 */

import type { FactoryEvent, RunStartEvent, StateEvent } from "./types.js";

export type ObsLevel = "info" | "good" | "warn" | "attention";
/** Minimum personality degree to surface: 0 = minimal, 1 = balanced, 2 = chatty. */
export type ObsDegree = 0 | 1 | 2;

export interface ObsAction {
  op: "retry" | "kill" | "pause" | "resume" | "stop" | "plan";
  task?: string;
  goal?: string; // set on op:"plan" — the supervisor's articulation of what to build
  label: string;
}

export interface Observation {
  id: string; // stable: `${run}#${seq}` — used as React key and for dedup
  ts: string; // ISO timestamp, straight from the event
  run: string;
  level: ObsLevel;
  degree: ObsDegree;
  icon: string;
  text: string;
  task?: string;
  action?: ObsAction;
  // "briefing" marks an LLM-composed message (the supervisor's own voice) and
  // "chat" the operator's own turn — both non-derivable, so they are persisted
  // separately and merged into the timeline. `actions` are what it already did;
  // `suggestions` are one-click proposals the operator can apply.
  kind?: "briefing" | "chat";
  who?: "you"; // set on kind:"chat" — renders as the operator's bubble
  actions?: string[];
  suggestions?: ObsAction[];
}

/** Per-run context the mapper threads across events (title lookup, sequence,
 *  plus aggregate counters for the milestone and cost nudges). */
export interface CompanionCtx {
  run: string;
  titles: Map<string, string>;
  seq: number;
  total: number; // tickets in the run (from run_start)
  merged: number; // merged so far
  milestoneFired: boolean; // the "halfway" nudge is emitted at most once
  costStep: number; // last $ threshold announced (multiples of COST_STEP_USD)
}

export function newCtx(run: string): CompanionCtx {
  return { run, titles: new Map(), seq: 0, total: 0, merged: 0, milestoneFired: false, costStep: 0 };
}

/** Announce cumulative spend as it crosses each multiple of this (chatty only). */
const COST_STEP_USD = 5;

function titleOf(ctx: CompanionCtx, task: string | undefined): string {
  if (!task) return "a ticket";
  return ctx.titles.get(task) ?? task;
}

/** Ingest a run_start's ticket list into the title map so later observations
 *  can name tickets instead of showing bare ids. */
function absorbTitles(ctx: CompanionCtx, ev: RunStartEvent): void {
  for (const t of ev.tasks ?? []) {
    if (typeof t === "string") continue;
    if (t.id && t.title) ctx.titles.set(t.id, t.title);
  }
}

// State transitions worth a chatty (degree 2) line, with the verb to use.
const TRANSITION_VERB: Partial<Record<string, string>> = {
  RUNNING: "started",
  VERIFYING: "is running its checks",
  REVIEWING: "is under review",
  MERGE_QUEUED: "is queued to merge",
  MERGING: "is merging",
};

/**
 * Map ONE event to zero or more observations. A single event can yield several
 * lines (e.g. a merge that also crosses the halfway milestone). Mutates `ctx`
 * (titles, seq, aggregate counters) — call it in event order.
 */
export function observe(raw: FactoryEvent, ctx: CompanionCtx): Observation[] {
  const out: Observation[] = [];
  const push = (o: Omit<Observation, "id" | "ts" | "run">): void => {
    out.push({ id: `${ctx.run}#${ctx.seq++}`, ts: raw.ts, run: ctx.run, ...o });
  };

  switch (raw.event) {
    case "run_start": {
      const ev = raw as RunStartEvent;
      absorbTitles(ctx, ev);
      const n = ev.tasks?.length ?? 0;
      ctx.total = n;
      push({
        level: "info", degree: 1, icon: "🚀",
        text: `Run started — ${n} ticket${n === 1 ? "" : "s"}, up to ${ev.slots} agent${ev.slots === 1 ? "" : "s"} in parallel.`,
      });
      break;
    }
    case "state": {
      const ev = raw as StateEvent;
      if (ev.to === "DONE") {
        push({ level: "good", degree: 1, icon: "✅", task: ev.task,
          text: `${titleOf(ctx, ev.task)} merged.` });
        ctx.merged += 1;
        // Halfway nudge: fired once, only when it is a genuine midpoint (not the
        // last ticket, which the run wrap-up already celebrates).
        if (!ctx.milestoneFired && ctx.total >= 3 && ctx.merged * 2 >= ctx.total && ctx.merged < ctx.total) {
          ctx.milestoneFired = true;
          push({ level: "good", degree: 1, icon: "🎯",
            text: `Halfway there — ${ctx.merged} of ${ctx.total} tickets merged.` });
        }
        break;
      }
      if (ev.to === "AWAITING_APPROVAL") {
        push({ level: "warn", degree: 1, icon: "🔎", task: ev.task,
          text: `${titleOf(ctx, ev.task)} is ready for your review.` });
        break;
      }
      // FAILED / BLOCKED carry no reason here — the dedicated failure/blocked
      // events do, so we surface those instead and skip these transitions.
      if (ev.to === "FAILED" || ev.to === "BLOCKED") break;
      const verb = TRANSITION_VERB[ev.to];
      if (verb) {
        push({ level: "info", degree: 2, icon: "•", task: ev.task,
          text: `${titleOf(ctx, ev.task)} ${verb}.` });
      }
      break;
    }
    case "retry": {
      const ev = raw as import("./types.js").RetryEvent;
      push({ level: "warn", degree: 1, icon: "↻", task: ev.task,
        text: `${titleOf(ctx, ev.task)} — retry ${ev.attempt} (${ev.reason}).` });
      break;
    }
    case "failure": {
      const ev = raw as import("./types.js").FailureEvent;
      push({ level: "attention", degree: 0, icon: "⛔", task: ev.task,
        text: `${titleOf(ctx, ev.task)} failed — ${ev.reason}.`,
        action: { op: "retry", task: ev.task, label: "Retry" } });
      break;
    }
    case "blocked": {
      const ev = raw as import("./types.js").BlockedEvent;
      push({ level: "attention", degree: 0, icon: "✋", task: ev.task,
        text: `${titleOf(ctx, ev.task)} is blocked — it needs you: ${ev.question}` });
      break;
    }
    case "verify": {
      const ev = raw as import("./types.js").VerifyEvent;
      if (ev.ok) break; // a pass just leads to review — not worth a line
      const detail = ev.failures?.length ? ` (${ev.failures.slice(0, 2).join("; ")})` : "";
      push({ level: "warn", degree: 2, icon: "❌", task: ev.task,
        text: `${titleOf(ctx, ev.task)} — checks failed${detail}.` });
      break;
    }
    case "agent_result": {
      // Cost checkpoint: announce cumulative spend as it crosses each step.
      // Chatty-only (degree 2) so it never adds noise at lower verbosity.
      const spent = (raw as import("./types.js").AgentResultEvent).spent_usd;
      if (typeof spent === "number" && spent > 0) {
        const step = Math.floor(spent / COST_STEP_USD) * COST_STEP_USD;
        if (step > ctx.costStep) {
          ctx.costStep = step;
          push({ level: "info", degree: 2, icon: "💰", text: `Spend is around $${spent.toFixed(2)} so far.` });
        }
      }
      break;
    }
    case "budget_exceeded": {
      const ev = raw as import("./types.js").BudgetEvent;
      push({ level: "attention", degree: 0, icon: "💸",
        text: `Budget exceeded — $${ev.spent_usd.toFixed(2)} of $${ev.budget_usd.toFixed(2)}.`,
        action: { op: "stop", label: "Stop run" } });
      break;
    }
    case "paused_ratelimit": {
      const ev = raw as import("./types.js").PausedEvent;
      push({ level: "warn", degree: 1, icon: "⏸",
        text: `Paused on a rate limit — cooling down ${ev.cooldown_s}s (pause #${ev.pause_n}).` });
      break;
    }
    case "run_end": {
      const ev = raw as import("./types.js").RunEndEvent;
      const merged = ev.counts?.DONE ?? ev.counts?.MERGED ?? 0;
      const failed = ev.counts?.FAILED ?? 0;
      const stopped = ev.stopped ? " (stopped early)" : "";
      const bits = [`${merged} merged`];
      if (failed) bits.push(`${failed} failed`);
      push({ level: failed ? "warn" : "good", degree: 0, icon: "🏁",
        text: `Run finished${stopped} — ${bits.join(", ")}.` });
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Fold a run's events (newline JSON) into observations. `ctx` is reused across
 * runs by the caller so a cross-run fold stays in one sequence space.
 */
export function foldRun(eventsText: string, ctx: CompanionCtx): Observation[] {
  const out: Observation[] = [];
  for (const line of eventsText.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let ev: FactoryEvent;
    try { ev = JSON.parse(s) as FactoryEvent; } catch { continue; }
    out.push(...observe(ev, ctx));
  }
  return out;
}

/** The board's pure model: run headlines, dependency layering, the manual-ticket
 *  lanes and the ticket shapes the board renders. No React here. */

import type { TaskState } from "./types.js";
import { Model, fmtDuration, fmtUsd } from "./model.js";
import { ticketTitle } from "./tickets.js";

export function headline(
  model: Model, runActive: boolean, hiddenIds?: ReadonlySet<string>,
): { text: string; tone: string } {
  if (!model.run) return { text: "No run yet — describe some work to begin.", tone: "warning" };
  if (!model.endedTs && !runActive) {
    return {
      text: "This run is no longer active — its process has stopped. Start a new run to finish the rest.",
      tone: "warning",
    };
  }
  // Removed tickets are gone from the operator's view — they must not colour the
  // banner either (a run is "all done" once the only failure was one you dropped).
  const tasks = [...model.tasks.values()].filter((t) => !hiddenIds?.has(t.id));
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const blocked = tasks.filter((t) => t.state === "BLOCKED").length;
  const done = tasks.filter((t) => t.state === "DONE").length;
  if (model.endedTs) {
    const queued = tasks.filter((t) => t.state === "QUEUED").length;
    if (model.budgetHit) {
      return { text: `Stopped — budget reached (${fmtUsd(model.spentUsd)}). Raise it in Settings, then run again.`, tone: "warning" };
    }
    if (model.stopped || queued > 0) {
      return { text: `Stopped — ${queued} task${queued > 1 ? "s" : ""} still waiting. They run on the next start.`, tone: "warning" };
    }
    if (failed === 0 && blocked === 0) return { text: "All done — everything merged.", tone: "good" };
    const parts = [`${done} merged`];
    if (failed) parts.push(`${failed} failed`);
    if (blocked) parts.push(`${blocked} waiting on you`);
    return { text: `Finished: ${parts.join(", ")}.`, tone: failed ? "critical" : "warning" };
  }
  if (blocked > 0) return { text: `${blocked} task${blocked > 1 ? "s" : ""} need${blocked > 1 ? "" : "s"} you.`, tone: "warning" };
  if (model.manualPause) return { text: "Paused by you.", tone: "warning" };
  if (model.ratePause) return { text: `Paused — usage limit hit, retrying in ${fmtDuration(model.ratePause.cooldown_s)}. Nothing is lost.`, tone: "warning" };
  return { text: "Everything is running fine.", tone: "good" };
}

/** True when this run belongs to an autopilot loop — its dir is named
 *  "<timestamp>-loop-<name>-<iteration>", so the board can tag it as autopilot. */
export function isAutopilotRun(run: string | null | undefined): boolean {
  return !!run && /-loop-.+-\d+$/.test(run);
}

/* ------------------------------ cost analytics (D8) ------------------------------ */

export interface RunPoint { run: string; ts: string | null; spend: number; tokens: number; merged: number; needs: number; total: number; mode?: "subscription" | "api"; error_counts?: Record<string, number> }

/** A run id like "2026-07-17_203726" → a human date+time, from the timestamp when
 *  present (falls back to parsing the id). */
export function humanRun(r: RunPoint): string {
  const d = r.ts ? new Date(r.ts) : null;
  if (d && !Number.isNaN(d.getTime())) {
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }
  return r.run.replace(/^\d{4}-/, "").replace("_", " · ");
}

/* ------------------------------ dependency graph (D7) ------------------------------ */

export interface DepNode { id: string; title: string; deps: string[] }

export function parseTicketDeps(content: string): { id: string; title: string; deps: string[] } {
  const id = content.match(/^id:\s*["']?([\w.-]+)["']?/m)?.[1] ?? "?";
  const title = ticketTitle(content);
  const depLine = content.match(/^depends_on:\s*(.+)$/m)?.[1] ?? "";
  const deps = [...depLine.matchAll(/["']?([\w.-]+)["']?/g)].map((m) => m[1]!).filter((d) => d && d !== "[]");
  return { id, title, deps };
}

/** Longest-path layering → columns; simple, no crossing-minimisation, but enough
 *  to read what blocks what and the critical path. */
export function layerNodes(nodes: DepNode[]): DepNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const n = byId.get(id);
    const d = n && n.deps.length ? 1 + Math.max(...n.deps.map((x) => compute(x, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) compute(n.id, new Set());
  const maxD = Math.max(0, ...[...depth.values()]);
  const layers: DepNode[][] = Array.from({ length: maxD + 1 }, () => []);
  for (const n of nodes) layers[depth.get(n.id) ?? 0]!.push(n);
  return layers;
}

/* --------------------------------- kanban --------------------------------- */

/** States a new run would actually (re-)execute — what "Run again (N)" counts.
 *  Excludes DONE (merged), AWAITING_APPROVAL (finished, needs your approval — not a
 *  re-run) and MERGE_QUEUED/MERGING (already succeeded, about to land). */
export const RERUNNABLE: ReadonlySet<TaskState> = new Set<TaskState>([
  "QUEUED", "RUNNING", "VERIFYING", "REVIEWING", "FAILED", "BLOCKED",
] as TaskState[]);

export interface BoardTicket {
  file: string; content: string; id: string; title: string;
  assignee: "ai" | "human"; status: string; hold: boolean;
  /** The ticket ids it waits on (front-matter depends_on). */
  deps: string[];
}

/** Which board column a manual ticket's status lives in, and the reverse: the
 *  status a manual ticket takes when dropped in a given column. Manual work only
 *  ever sits in these three human-meaningful lanes. */
export const MANUAL_COL: Record<string, string> = { todo: "queued", doing: "working", review: "approval", done: "done" };
export const COL_STATUS: Record<string, string> = { queued: "todo", working: "doing", approval: "review", done: "done" };

/* --------------------------------- oversized-file advisory --------------------------------- */

export interface Hotspot {
  path: string;
  sizeBytes: number;
  estTokens: number;
  edits: number;
  score: number;
}

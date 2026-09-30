/** Talking to the run: operator controls (pause, retry, answer...), the backlog
 *  and hidden-ticket hooks, and the subscription plan-usage poll. */

import { useCallback, useEffect, useState } from "react";
import { fetchJSON, postJSON } from "./api.js";
import { toast, usePolling } from "./core.js";
import { Ticket } from "./tickets.js";

/** Human label for a plan rate-limit window ("five_hour" → "5h window"). */
export interface UsageLimit {
  kind: string; group: string; percent: number; severity: string; resets_at: string | null;
  is_active?: boolean; scope?: { model?: { display_name?: string | null } | null } | null;
}
export interface UsageResp { limits?: UsageLimit[]; error?: string }

/** Plan-usage cadence: the endpoint is itself rate-limited, so poll gently. */
const PLAN_LIMITS_POLL_MS = 120_000;
/** Backlog cadence: catches a ticket added elsewhere (phone, planner). */
const BACKLOG_POLL_MS = 15_000;

/** Poll the real subscription plan usage (5h session + weekly, per model) — the data
 *  Claude's own /usage screen shows, fetched server-side via the account's OAuth token. */
export function usePlanLimits(active: boolean): UsageLimit[] {
  const [u, setU] = useState<UsageResp | null>(null);
  usePolling(async ({ alive }) => {
    const d = await fetchJSON<UsageResp>("/api/usage");
    if (alive()) setU(d);
  }, PLAN_LIMITS_POLL_MS, [active], active);
  return (u?.limits ?? []).filter((l) => ["session", "weekly_all", "weekly_scoped"].includes(l.kind));
}

/** The project's pending backlog (tickets drafted but not yet run), with a manual
 *  refresh. Drives the Up-next draft cards and the Deps-button visibility, and
 *  polls gently so a ticket added elsewhere (phone, planner) shows up. */
export function useBacklog(ws: string): { tickets: Ticket[]; refresh: () => void } {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const load = useCallback((): void => {
    void fetchJSON<{ tickets: Ticket[] }>("/api/backlog")
      .then((r) => setTickets(r.tickets ?? []))
      .catch(() => {});
  }, []);
  usePolling(load, BACKLOG_POLL_MS, [ws, load]);
  return { tickets, refresh: load };
}

/** Ticket ids the operator removed from the board (reversible hide). Server-backed
 *  per workspace; history and files are untouched. */
export function useHidden(ws: string): { ids: Set<string>; hide: (id: string) => Promise<void>; unhide: (id: string) => Promise<void> } {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    void fetchJSON<{ hidden: string[] }>("/api/tickets/hidden")
      .then((h) => { if (alive) setIds(new Set(h.hidden ?? [])); }).catch(() => {});
    return () => { alive = false; };
  }, [ws]);
  const post = async (path: string, id: string): Promise<void> => {
    try { const r = await postJSON<{ hidden: string[] }>(path, { id }); setIds(new Set(r.hidden ?? [])); }
    catch (e) { toast(String(e), true); }
  };
  return { ids, hide: (id) => post("/api/tickets/hide", id), unhide: (id) => post("/api/tickets/unhide", id) };
}

/** Human label for one plan window. */
export function limitLabel(l: UsageLimit): string {
  return l.kind === "session" ? "5h session"
    : l.kind === "weekly_all" ? "Weekly · all models"
      : l.kind === "weekly_scoped" ? `Weekly · ${l.scope?.model?.display_name ?? "top model"}`
        : l.kind;
}

/** When a window reopens. Under a day a countdown is what you act on ("in 2h 51m");
 *  beyond it a countdown is noise, so switch to wall clock ("Mon 16:59"). */
export function fmtReset(iso: string | null): string {
  const ms = iso ? Date.parse(iso) - Date.now() : NaN;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resetting";
  if (ms < 86_400_000) {
    const mins = Math.round(ms / 60_000);
    return mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
  }
  return new Date(iso as string).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** Fuzzy-ish filter: every query char appears in order somewhere in the haystack. */
export function fuzzyMatch(query: string, hay: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase(), h = hay.toLowerCase();
  let i = 0;
  for (const ch of h) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return false;
}

/* --------------------------------- controls --------------------------------- */

export async function sendControl(op: string, taskId?: string, text?: string, to?: string): Promise<void> {
  try {
    await postJSON("/api/control", { op, task: taskId, ...(text ? { text } : {}), ...(to ? { to } : {}) });
    const messages: Record<string, string> = {
      pause: "Pausing — running agents finish, no new ones start.",
      resume: "Resuming.",
      stop: "Stopping — running agents finish, the rest stays queued.",
      kill: `Cancelling ${taskId} — it won't merge.`,
      retry: `${taskId} is back in the queue with a fresh budget.`,
      approve: `${taskId} approved — merging now.`,
      changes: `${taskId} sent back to the agent with your note.`,
      undo: `Rewound ${taskId} to that checkpoint.`,
    };
    toast(messages[op] ?? "Sent.");
  } catch (err) { toast(`Could not send the command: ${String(err)}`, true); }
}

/** Reply to a blocked agent: the answer is threaded to the agent on re-run. */
export async function sendAnswer(taskId: string, text: string): Promise<void> {
  try {
    await postJSON("/api/control", { op: "answer", task: taskId, text });
    toast(`Answer sent — ${taskId} restarts with it.`);
  } catch (err) { toast(`Could not send the answer: ${String(err)}`, true); }
}

export async function quickRun(): Promise<void> {
  try {
    await postJSON("/api/run", {});
    toast("New run starting — remaining tickets replay with the current config.");
  } catch (err) { toast(String(err), true); }
}

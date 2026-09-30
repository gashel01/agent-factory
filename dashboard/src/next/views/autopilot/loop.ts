/** The autopilot loop's data layer for the new interface: the state the server
 *  reports (GET /api/loop), the four modes, and the calls the page makes. Same
 *  endpoints and bodies as the classic autopilot modal (src/autopilot-modal.tsx),
 *  so both interfaces drive the one loop process the server keeps per workspace
 *  — it keeps running when the page is left, and either UI picks it up. */

import { Flag, InfinityIcon, ListChecks, Sparkles } from "../../icons.js";
import type { LucideIcon } from "../../icons.js";
import { fetchJSON, postJSON } from "../../../api.js";
import type { LoopState } from "../../../api-shapes.js";

export type { LoopState };

export type LoopMode = "explicit" | "supervisor" | "self" | "backlog";

export const MODES: Array<{ id: LoopMode; Icon: LucideIcon; title: string; desc: string }> = [
  { id: "explicit", Icon: Flag, title: "Objective", desc: "Pursue a goal until an acceptance check passes." },
  { id: "supervisor", Icon: Sparkles, title: "Mission", desc: "A supervisor turns a mission into a step each round." },
  { id: "self", Icon: InfinityIcon, title: "Auto-improve", desc: "Split the largest files until none stay oversized." },
  { id: "backlog", Icon: ListChecks, title: "Run backlog", desc: "Work through this project's backlog, hands-off." },
];

/** Modes that need a written objective (the other two are self-driving). */
export const needsObjective = (m: LoopMode): boolean => m === "explicit" || m === "supervisor";

export function fetchLoop(ws: string): Promise<LoopState> {
  return fetchJSON<LoopState>(`/api/loop?ws=${encodeURIComponent(ws)}`);
}

/** What past runs cost per ticket — turns the budget into "≈ N tickets". */
export interface CostHistory { medianUsdPerTicket: number; runs: number }

export async function fetchCostHistory(ws: string): Promise<CostHistory | null> {
  const f = await fetchJSON<{ history?: { medianUsdPerTicket?: number; runs?: number } }>(
    `/api/forecast?ws=${encodeURIComponent(ws)}`);
  const median = f.history?.medianUsdPerTicket ?? 0;
  return median > 0 ? { medianUsdPerTicket: median, runs: f.history?.runs ?? 0 } : null;
}

type Reply = { ok?: boolean; error?: string };

export function draftObjective(repo: string): Promise<Reply & { objective?: string; accept?: string }> {
  return postJSON("/api/loop/draft", { repo });
}

export function startLoop(body: {
  mode: LoopMode; objective: string; accept: string; repo: string; budget: number; maxIterations: number;
}): Promise<Reply> {
  return postJSON("/api/loop/start", body);
}

export function stopLoop(): Promise<unknown> {
  return postJSON("/api/loop/stop", {});
}

export function steerLoop(objective: string): Promise<Reply> {
  return postJSON("/api/loop/steer", { objective });
}

/** The spend gauge warms from the accent to review-orange to red as the spend
 *  nears the cap. */
export function gaugeColor(pct: number): string {
  return pct >= 95 ? "var(--st-needs)" : pct >= 75 ? "var(--st-review)" : "var(--accent)";
}

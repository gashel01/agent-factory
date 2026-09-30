/** Where the new interface is: one page (a rail destination) plus at most one
 *  overlay on top of it. The page lives in the URL hash (#/board, #/repo…) so a
 *  reload, a bookmark or the phone keeps the place; overlays are transient. */

import type { BlockedContext, DecisionOption } from "../types.js";
import type { BoardTicket } from "../board-model.js";

export type Page =
  | "projects" | "board" | "prs" | "autopilot" | "repo" | "knowledge" | "run"
  | "insights" | "memory" | "settings" | "diff";

export const PAGES: readonly Page[] = [
  "projects", "board", "prs", "autopilot", "repo", "knowledge", "run", "insights", "memory", "settings", "diff",
];

/** A page plus its optional argument (#/diff/014, #/repo/src/app.py, #/settings/trust). */
export interface Route { page: Page; arg: string }

export function parseHash(hash: string): Route {
  const [page = "", ...rest] = hash.replace(/^#\/?/, "").split("/");
  const known = (PAGES as readonly string[]).includes(page);
  return { page: known ? (page as Page) : "board", arg: known ? decodeURIComponent(rest.join("/")) : "" };
}

export function hashFor(route: Route): string {
  return `#/${route.page}${route.arg ? `/${encodeURIComponent(route.arg).replace(/%2F/g, "/")}` : ""}`;
}

/** The overlay currently open over the page, if any. */
export type Overlay =
  | null
  | { type: "ticket"; taskId: string }
  | { type: "answer"; taskId: string; title: string; question: string; context: BlockedContext | null }
  | { type: "decision"; taskId: string; title: string; question: string; options: DecisionOption[] }
  | { type: "newwork"; tab?: "one" | "goal"; goal?: string; autostart?: boolean }
  | { type: "editticket"; ticket: BoardTicket }
  | { type: "lesson"; text: string; ticketId?: string }
  | { type: "projectedit"; name: string }
  | { type: "runestimate"; tickets: number }
  | { type: "palette" }
  /** Where it was opened from, so the popover appears next to it. */
  | { type: "mode"; from?: "rail" | "top" };

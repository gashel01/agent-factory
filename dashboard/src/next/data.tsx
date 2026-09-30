/** The new interface's shared state: the live run model, the backlog, the
 *  workspace list, navigation. Built once in the shell and read by every view
 *  through useWarden(), so a view never re-subscribes to the event stream.
 *
 *  All data access goes through the shared layers (api.ts, model.ts, core.tsx,
 *  control.ts) — the same ones the server-side tests exercise. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { fetchJSON, getWs, postJSON, setWs as persistWs } from "../api.js";
import { RERUNNABLE, headline, isAutopilotRun, parseTicketDeps } from "../board-model.js";
import type { BoardTicket } from "../board-model.js";
import { toast, useEventStream, useNow, useRunActive } from "../core.js";
import type { WorkspaceInfo } from "../core.js";
import { inFlight } from "../model.js";
import type { Model, TaskModel } from "../model.js";
import { useBacklog, useHidden } from "../control.js";
import { fmGet, fmSet, ticketTitle } from "../tickets.js";
import { hashFor, parseHash } from "./routes.js";
import type { Overlay, Page, Route } from "./routes.js";

export interface Warden {
  /* workspace */
  ws: string;
  workspaces: WorkspaceInfo[];
  switchWs: (name: string) => void;
  reloadWorkspaces: () => Promise<void>;
  /* live run */
  model: Model;
  connected: boolean;
  runActive: boolean;
  /** A run is in progress right now (started, not ended, process alive). */
  live: boolean;
  autopilot: boolean;
  now: number;
  headline: { text: string; tone: string };
  /** Every task of the run, sorted by id, minus in-flight ghosts of a dead run. */
  tasks: TaskModel[];
  /** tasks minus the ones the operator removed from the board. */
  visible: TaskModel[];
  /* backlog */
  boardTickets: BoardTicket[];
  /** AI drafts not yet picked up by a run. */
  pending: BoardTicket[];
  /** Tickets a human owns. */
  manual: BoardTicket[];
  removed: Array<{ id: string; title: string }>;
  hiddenIds: Set<string>;
  refreshBacklog: () => void;
  /** How many tickets "Run" would launch now. */
  willRun: number;
  /** Of those, how many re-run tickets from a finished run. */
  rerunnable: number;
  spent: number;
  /* actions shared by several views */
  removeTicket: (id: string) => Promise<void>;
  restoreTicket: (id: string) => Promise<void>;
  saveTicket: (bt: BoardTicket, content: string, note: string) => Promise<void>;
  /* navigation */
  route: Route;
  go: (page: Page, arg?: string) => void;
  overlay: Overlay;
  open: (o: Overlay) => void;
  close: () => void;
  supervisorOpen: boolean;
  setSupervisorOpen: (v: boolean) => void;
  /* appearance */
  theme: ThemeChoice;
  /** The theme actually shown ("system" resolved against the OS). */
  resolvedTheme: "dark" | "light";
  setTheme: (t: ThemeChoice) => void;
}

export type ThemeChoice = "dark" | "light" | "system";

function useThemeChoice(): [ThemeChoice, "dark" | "light", (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    try {
      const v = localStorage.getItem("warden.next.theme");
      return v === "light" || v === "system" ? v : "dark";
    } catch { return "dark"; }
  });
  const query = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: light)") : null;
  const [osLight, setOsLight] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const onChange = (e: MediaQueryListEvent): void => setOsLight(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const set = (t: ThemeChoice): void => {
    setChoice(t);
    try { localStorage.setItem("warden.next.theme", t); } catch { /* private mode */ }
  };
  const resolved = choice === "system" ? (osLight ? "light" : "dark") : choice;
  return [choice, resolved, set];
}

const WardenContext = createContext<Warden | null>(null);

export function useWarden(): Warden {
  const w = useContext(WardenContext);
  if (!w) throw new Error("useWarden() outside <WardenProvider>");
  return w;
}

function useRoute(): [Route, (page: Page, arg?: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((page: Page, arg = ""): void => {
    const next = hashFor({ page, arg });
    if (location.hash !== next) location.hash = next;
    else setRoute({ page, arg });
  }, []);
  return [route, go];
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch { return fallback; }
}

export function WardenProvider({ children }: { children: ReactNode }): JSX.Element {
  const [ws, setWsState] = useState(getWs());
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [model, tick, connected] = useEventStream(ws);
  const runActive = useRunActive(tick);
  const backlog = useBacklog(ws);
  const hidden = useHidden(ws);
  const [route, go] = useRoute();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [theme, resolvedTheme, setTheme] = useThemeChoice();
  const [supervisorOpen, setSupervisorOpenState] = useState(() => readFlag("warden.next.supervisor", false));
  const setSupervisorOpen = (v: boolean): void => {
    setSupervisorOpenState(v);
    try { localStorage.setItem("warden.next.supervisor", v ? "1" : "0"); } catch { /* private mode */ }
  };

  const reloadWorkspaces = useCallback(async (): Promise<void> => {
    try {
      const { workspaces: list } = await fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
      setWorkspaces(list);
      if (!list.some((w) => w.name === getWs())) {
        const first = list[0]?.name ?? "";
        persistWs(first);
        setWsState(first);
      }
    } catch { /* offline: the connection banner says so */ }
  }, []);
  useEffect(() => { void reloadWorkspaces(); }, [reloadWorkspaces]);

  const switchWs = (name: string): void => { persistWs(name); setWsState(name); setOverlay(null); };

  const allTasks = [...model.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  // A killed run leaves tickets in an in-flight state with no terminal event;
  // when nothing is actually running they're ghosts — keep them off the board.
  const tasks = runActive ? allTasks : allTasks.filter((t) => !inFlight(t.state));
  const visible = tasks.filter((t) => !hidden.ids.has(t.id));
  const anyRunning = tasks.some((t) => t.runningSince !== null);
  const now = useNow(anyRunning || model.ratePause !== null || model.planLimit !== null);
  const live = Boolean(model.run) && !model.endedTs && runActive;

  // A merged ticket's file is archived out of the backlog the moment it lands;
  // re-read the backlog then (and when a run ends) instead of waiting for the
  // next poll — which pauses in a background tab — so its draft never lingers
  // in Up next next to its own merged card.
  const doneCount = tasks.filter((t) => t.state === "DONE").length;
  useEffect(() => { backlog.refresh(); }, [doneCount, model.endedTs]);

  const boardTickets: BoardTicket[] = useMemo(() => backlog.tickets.map((t) => {
    const { id, deps } = parseTicketDeps(t.content);
    return {
      file: t.file, content: t.content,
      id, deps, title: ticketTitle(t.content),
      assignee: fmGet(t.content, "assignee") === "human" ? "human" : "ai",
      status: fmGet(t.content, "status") || "todo",
      hold: fmGet(t.content, "hold") === "true",
    };
  }), [backlog.tickets]);
  // A live task masks its own draft so a ticket isn't shown twice (a merged one
  // must not mask a fresh reuse of the same id).
  const runIds = new Set(tasks.filter((t) => t.state !== "DONE").map((t) => t.id));
  const pending = boardTickets.filter((t) => t.assignee === "ai" && !runIds.has(t.id) && !hidden.ids.has(t.id));
  const manual = boardTickets.filter((t) => t.assignee === "human" && !hidden.ids.has(t.id));
  const removed = [
    ...tasks.filter((t) => hidden.ids.has(t.id)).map((t) => ({ id: t.id, title: t.title })),
    ...boardTickets.filter((bt) => hidden.ids.has(bt.id) && !tasks.some((t) => t.id === bt.id))
      .map((bt) => ({ id: bt.id, title: bt.title })),
  ];
  const rerunnable = tasks.filter((t) => RERUNNABLE.has(t.state) && !hidden.ids.has(t.id)).length;
  const willRun = rerunnable || pending.filter((p) => !p.hold).length;
  const spent = model.spentUsd || tasks.reduce((s, t) => s + t.costUsd, 0);

  // Removing a ticket is a reversible board hide. An AI draft is also put on hold
  // so a run skips it; restoring lifts the hold. Files and history are untouched.
  const setHoldSilent = (bt: BoardTicket, on: boolean): Promise<unknown> =>
    postJSON(`/api/backlog/${encodeURIComponent(bt.file)}`, { content: fmSet(bt.content, "hold", on ? "true" : "") });
  const removeTicket = async (id: string): Promise<void> => {
    await hidden.hide(id);
    const bt = boardTickets.find((b) => b.id === id);
    if (bt?.assignee === "ai") { try { await setHoldSilent(bt, true); backlog.refresh(); } catch { /* hidden anyway */ } }
    toast(`${id} removed — restore it from Removed.`);
  };
  const restoreTicket = async (id: string): Promise<void> => {
    await hidden.unhide(id);
    const bt = boardTickets.find((b) => b.id === id);
    if (bt?.assignee === "ai" && bt.hold) { try { await setHoldSilent(bt, false); backlog.refresh(); } catch { /* ok */ } }
    toast(`${id} restored.`);
  };
  const saveTicket = async (bt: BoardTicket, content: string, note: string): Promise<void> => {
    try {
      await postJSON(`/api/backlog/${encodeURIComponent(bt.file)}`, { content });
      toast(note);
      backlog.refresh();
    } catch (err) { toast(String(err), true); }
  };

  const value: Warden = {
    ws, workspaces, switchWs, reloadWorkspaces,
    model, connected, runActive, live, autopilot: isAutopilotRun(model.run) && runActive, now,
    headline: headline(model, runActive, hidden.ids),
    tasks, visible,
    boardTickets, pending, manual, removed, hiddenIds: hidden.ids, refreshBacklog: backlog.refresh,
    willRun, rerunnable, spent,
    removeTicket, restoreTicket, saveTicket,
    route, go, overlay, open: setOverlay, close: () => setOverlay(null),
    supervisorOpen, setSupervisorOpen,
    theme, resolvedTheme, setTheme,
  };
  return <WardenContext.Provider value={value}>{children}</WardenContext.Provider>;
}

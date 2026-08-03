/** Agent Factory dashboard — React app. Mounts into #app. */

import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  BlockedContext, FactoryEvent, TaskState,
  CapsuleAction, CapsuleConsent, CapsulePanel, CapsuleView,
} from "./types.js";
import {
  api, fetchJSON, getText, getWs, initToken, initWs, postJSON, repoGet, repoPath, scopedJSON, setRepoPath, setWs,
} from "./api.js";
import {
  ACTIVITY, EFFORT_CHOICES, HistoryTicket, MODEL_CHOICES, Model, Settings, StoryItem, TaskModel,
  ago, fmtDuration, fmtTokens, fmtUsd, freshModel, generateConfig, inFlight, narrate,
  parseDiff, parseSettings, reduce, seedHistory,
} from "./model.js";
import { langFromPath, tokenizeLine } from "./highlight.js";
import { qrSvg } from "./qr.js";
import type { Observation } from "./companion.js";
import {
  ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpFromLine,
  Bell, BellOff, BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Circle,
  CircleDot, CircleHelp, Command, CompanionIcon, CornerDownLeft, CornerDownRight,
  ExternalLink, Eye, FileText, FlaskConical, Flag, Folder, FolderOpen, FolderPlus,
  GitBranch, GitMerge, InfinityIcon, Key, Laptop, Lightbulb, Lock, MessageCircle,
  MoreHorizontal, Palette, Pause, Pencil, Play, Plus, RotateCw, Search, Send,
  Smartphone, Sparkles, Square, Timer, Trash2, TriangleAlert, Upload, X,
} from "./icons.js";
import type { LucideIcon } from "./icons.js";

/* --------------------------------- toasts --------------------------------- */

interface Toast { id: number; msg: string; error: boolean }
let toastSeq = 0;
let toastList: Toast[] = [];
const toastSubs = new Set<(t: Toast[]) => void>();
function emitToasts(): void { for (const s of toastSubs) s(toastList); }
export function toast(msg: string, error = false): void {
  const t = { id: ++toastSeq, msg, error };
  toastList = [...toastList, t];
  emitToasts();
  setTimeout(() => { toastList = toastList.filter((x) => x.id !== t.id); emitToasts(); }, 4600);
}
function Toaster(): JSX.Element {
  const [items, setItems] = useState<Toast[]>(toastList);
  useEffect(() => { toastSubs.add(setItems); return () => { toastSubs.delete(setItems); }; }, []);
  return (
    <div className="toaster">
      {items.map((t) => <div key={t.id} className={`toast${t.error ? " error" : ""}`}>{t.msg}</div>)}
    </div>
  );
}

/* --------------------------------- ui primitives --------------------------------- */

/** A small inline activity spinner. Decorative — always paired with a label or aria-busy. */
function Spinner({ size = 13 }: { size?: number }): JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

/**
 * The one button. It centralises behaviour — in-flight pending, disabled, and the
 * accessible name — while reusing the existing CSS vocabularies (`hbtn` / `btn` /
 * `act`) via `kind`, so the whole product routes clicks through one component
 * without a fourth class system. `autoPending` makes it own the spinner: it awaits
 * the onClick promise and disables itself for the duration — no external flag needed.
 */
type BtnKind = "hbtn" | "btn" | "act";
interface ButtonProps {
  children: ReactNode;
  onClick?: () => void | Promise<void>;
  kind?: BtnKind;
  variant?: string;        // appended verbatim, e.g. "accent" | "primary" | "ghost" | "danger-soft"
  pending?: boolean;       // controlled: the caller owns the in-flight flag
  autoPending?: boolean;   // uncontrolled: the button awaits onClick and shows its own spinner
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  className?: string;
  type?: "button" | "submit";
}
function Button({
  children, onClick, kind = "hbtn", variant, pending, autoPending,
  disabled, title, ariaLabel, className = "", type = "button",
}: ButtonProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const isPending = pending ?? (autoPending ? busy : false);
  const run = async (): Promise<void> => {
    if (!onClick || isPending || disabled) return;
    if (!autoPending) { await onClick(); return; }
    setBusy(true);
    try { await onClick(); } finally { setBusy(false); }
  };
  const cls = [kind, variant, isPending ? "is-pending" : "", className].filter(Boolean).join(" ");
  return (
    <button type={type} title={title} aria-label={ariaLabel} aria-busy={isPending || undefined}
      disabled={disabled || isPending} className={cls} onClick={() => void run()}>
      {isPending && <Spinner />}
      <span className="btn-label">{children}</span>
    </button>
  );
}

/** Shimmer placeholder for async panels — replaces bare "loading…" text. */
function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }): JSX.Element {
  return (
    <div className={`skeleton ${className}`.trim()} role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" style={{ width: `${92 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** Secondary header actions folded behind one "More" disclosure, closed on outside click.
 *  Tames the flat toolbar without hiding anything — every item stays keyboard-reachable. */
/* --------------------------------- hooks --------------------------------- */

/**
 * ONE EventSource per workspace, fanned out to every subscriber. The board model
 * and the companion rail both need `/api/events`; opening two streams made the
 * server replay the whole run twice. A ref-counted hub opens the stream on the
 * first subscriber and closes it when the last leaves. Safe against the classic
 * late-subscribe race because React runs both hooks' effects synchronously in
 * the same commit, before the stream receives its first byte.
 */
interface EventSub {
  onRun?: (data: string) => void;
  onHistory?: (data: string) => void;
  onMessage?: (data: string) => void;
  onCompanion?: (data: string) => void;
  onOpen?: () => void;
  onError?: () => void;
}
const eventHubs = new Map<string, { es: EventSource; subs: Set<EventSub> }>();
function subscribeEvents(ws: string, sub: EventSub): () => void {
  let hub = eventHubs.get(ws);
  if (!hub) {
    const es = new EventSource(api("/api/events"));
    const h = { es, subs: new Set<EventSub>() };
    const fan = (pick: (s: EventSub) => ((d: string) => void) | undefined) =>
      (e: Event) => { for (const s of h.subs) pick(s)?.((e as MessageEvent).data); };
    es.addEventListener("run", fan((s) => s.onRun));
    es.addEventListener("history", fan((s) => s.onHistory));
    es.addEventListener("companion", fan((s) => s.onCompanion));
    es.onmessage = (e) => { for (const s of h.subs) s.onMessage?.(e.data); };
    es.onopen = () => { for (const s of h.subs) s.onOpen?.(); };
    es.onerror = () => { for (const s of h.subs) s.onError?.(); };
    hub = h;
    eventHubs.set(ws, h);
  }
  hub.subs.add(sub);
  return () => {
    const h = eventHubs.get(ws);
    if (!h) return;
    h.subs.delete(sub);
    if (h.subs.size === 0) { h.es.close(); eventHubs.delete(ws); }
  };
}

/** SSE stream folded into a model; returns [model, tick, connected] and resets
 *  per run. `connected` flips false when the server is unreachable (the browser
 *  auto-reconnects), so the UI can say "disconnected" instead of "no run". */
function useEventStream(ws: string): [Model, number, boolean] {
  const modelRef = useRef<Model>(freshModel(""));
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    modelRef.current = freshModel("");
    // The model is mutated in place; a bump() forces the re-render. SSE onmessage
    // callbacks are separate macrotasks, so React can't auto-batch them — a busy
    // run would re-render on every event. Coalesce bumps into one per animation
    // frame: correctness is unchanged (we render the same up-to-date model), we
    // just stop rendering faster than the screen refreshes.
    let raf: number | null = null;
    const bump = (): void => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => { raf = null; setTick((t) => t + 1); });
    };
    const stop = subscribeEvents(ws, {
      onOpen: () => setConnected(true),
      // EventSource retries on its own; onError just means "currently down".
      onError: () => setConnected(false),
      onRun: (data) => {
        const { run } = JSON.parse(data) as { run: string | null };
        modelRef.current = freshModel(run ?? "");
        setConnected(true);
        bump();
      },
      onHistory: (data) => {
        try { seedHistory(modelRef.current, JSON.parse(data) as HistoryTicket[]); }
        catch { return; }
        bump();
      },
      onMessage: (data) => {
        try { reduce(modelRef.current, JSON.parse(data) as FactoryEvent); } catch { return; }
        bump();
      },
    });
    return () => { if (raf !== null) cancelAnimationFrame(raf); stop(); };
  }, [ws]);
  return [modelRef.current, tick, connected];
}

/**
 * A polling interval started from an event handler (Send, Test, Plan) that is
 * ALWAYS cleared on unmount — closing the modal mid-poll must not keep hitting
 * the server and calling setState on an unmounted tree. The tick receives a
 * `stop()` to end the poll itself when its work is done.
 */
function useManagedInterval(): (tick: (stop: () => void) => void, ms: number) => void {
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (ref.current) { clearInterval(ref.current); ref.current = null; }
  }, []);
  useEffect(() => stop, [stop]); // clear on unmount
  return useCallback((tick, ms) => {
    stop();
    ref.current = setInterval(() => tick(stop), ms);
  }, [stop]);
}

/** A ticking clock so running timers re-render each second. */
function useNow(activeOrPaused: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activeOrPaused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeOrPaused]);
  return now;
}

/** Polls whether a dispatcher is really alive for the shown run. */
function useRunActive(tick: number): boolean {
  const [active, setActive] = useState(true);
  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const s = await fetchJSON<{ run: { state: string } }>("/api/status");
        if (alive) setActive(s.run.state === "running");
      } catch { /* keep last */ }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tick === 0 ? 0 : 1]); // (re)start once the stream is live
  return active;
}

/** Close-on-Escape for any overlay. Cheap re-subscribe per render is fine. */
function useEsc(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

/**
 * Dialog focus management: move focus into the container on open, keep Tab inside
 * it (so keyboard users can't wander behind the modal), and restore focus to the
 * element that opened it on close. Returns a ref to attach to the dialog root.
 */
function useFocusTrap<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusable = (): HTMLElement[] =>
      [...node.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.offsetParent !== null);
    (focusable()[0] ?? node).focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!, last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      opener?.focus?.(); // restore focus to the trigger
    };
  }, []);
  return ref;
}

/** Browser-notification opt-in, persisted and gated on the OS permission. */
function useNotifyPref(): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem("factory.notify") === "1"
        && "Notification" in window && Notification.permission === "granted";
    } catch { return false; }
  });
  const toggle = (): void => {
    if (on) {
      setOn(false);
      try { localStorage.setItem("factory.notify", "0"); } catch { /* */ }
      return;
    }
    if (!("Notification" in window)) { toast("This browser has no notifications.", true); return; }
    void Notification.requestPermission().then((perm) => {
      if (perm === "granted") {
        setOn(true);
        try { localStorage.setItem("factory.notify", "1"); } catch { /* */ }
        toast("Notifications on — I'll ping you when a task needs you or a run ends.");
      } else {
        toast("Notifications are blocked in the browser settings.", true);
      }
    });
  };
  return { on, toggle };
}

function sendNotification(title: string, body: string): void {
  try { new Notification(title, { body, tag: "agent-factory" }); } catch { /* not permitted */ }
}

/** Terminal states worth interrupting a human for. */
const ALERT_STATES: Partial<Record<TaskState, { msg: string; error: boolean }>> = {
  DONE: { msg: "merged", error: false },
  FAILED: { msg: "failed", error: true },
  BLOCKED: { msg: "needs you — it asked a question", error: true },
};

/**
 * Toasts (C2) and browser notifications (C1) on real state changes. The run's
 * replay-on-connect is swallowed by a short grace window so history doesn't
 * fire a burst of stale alerts; browser notifications only fire when the tab is
 * in the background (a toast already covers the focused case).
 */
function useStateAlerts(model: Model, notifyEnabled: boolean): void {
  const prev = useRef<Map<string, TaskState>>(new Map());
  const readyAt = useRef(0);
  const lastRun = useRef<string | null>(null);
  const endedSeen = useRef(false);
  useEffect(() => {
    if (model.run !== lastRun.current) {
      lastRun.current = model.run;
      readyAt.current = Date.now() + 3500; // let the connect-time replay settle
      prev.current = new Map();
      endedSeen.current = false;
    }
    const ready = Date.now() > readyAt.current;
    for (const [id, t] of model.tasks) {
      const was = prev.current.get(id);
      if (ready && was && was !== t.state) {
        const a = ALERT_STATES[t.state];
        if (a) {
          toast(`${id} ${a.msg}`, a.error);
          if (notifyEnabled && document.hidden) sendNotification("Agent Factory", `${t.title}: ${a.msg}`);
        }
      }
      prev.current.set(id, t.state);
    }
    if (ready && model.endedTs && !endedSeen.current) {
      endedSeen.current = true;
      const merged = [...model.tasks.values()].filter((t) => t.state === "DONE").length;
      toast(`Run finished — ${merged} merged.`);
      if (notifyEnabled && document.hidden) sendNotification("Agent Factory", `Run finished — ${merged} merged.`);
    }
  });
}

/* --------------------------------- companion --------------------------------- */


/**
 * The companion timeline for a workspace: the narrated, persistent record of
 * "what happened in this project". Loads history from the server (a fold over
 * every run's events) and appends live observations from the SSE `companion`
 * channel, deduped by id. Independent of the board model so it survives run
 * switches and shows cross-run history.
 */
function useCompanion(ws: string): { obs: Observation[]; latestId: string | null } {
  const [obs, setObs] = useState<Observation[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const [latestId, setLatestId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    seen.current = new Set();
    setObs([]);
    const add = (incoming: Observation[]): void => {
      if (!alive || incoming.length === 0) return;
      const fresh = incoming.filter((o) => !seen.current.has(o.id));
      if (fresh.length === 0) return;
      for (const o of fresh) seen.current.add(o.id);
      setObs((prev) => [...prev, ...fresh]);
      setLatestId(fresh[fresh.length - 1]!.id);
    };
    fetchJSON<{ observations: Observation[] }>("/api/companion")
      .then((r) => add(r.observations)).catch(() => { /* empty timeline is fine */ });
    const unsub = subscribeEvents(ws, {
      onCompanion: (data) => { try { add([JSON.parse(data) as Observation]); } catch { /* skip */ } },
    });
    return () => { alive = false; unsub(); };
  }, [ws]);
  return { obs, latestId };
}

interface WorkspaceInfo { name: string; workdir: string; repo: string | null; currentRun: string | null }

/* --------------------------------- status meta --------------------------------- */

/** Per-state pill: human label + icon + colour family (drives the oklch CSS vars). */
const STATE_META: Record<TaskState, { label: string; Icon: LucideIcon; fam: string }> = {
  QUEUED: { label: "Up next", Icon: Circle, fam: "upnext" },
  RUNNING: { label: "Working", Icon: Play, fam: "working" },
  VERIFYING: { label: "Tests", Icon: FlaskConical, fam: "checking" },
  REVIEWING: { label: "Review", Icon: Search, fam: "reviewing" },
  AWAITING_APPROVAL: { label: "To review", Icon: Eye, fam: "approval" },
  MERGE_QUEUED: { label: "Merging", Icon: GitMerge, fam: "merging" },
  MERGING: { label: "Merging", Icon: GitMerge, fam: "merging" },
  DONE: { label: "Merged", Icon: Check, fam: "merged" },
  BLOCKED: { label: "Question", Icon: CircleHelp, fam: "blocked" },
  FAILED: { label: "Failed", Icon: TriangleAlert, fam: "failed" },
};

/** Headline tone → status colour family, for the synthesis dot. */
const TONE_FAM: Record<string, string> = { good: "merged", warning: "blocked", critical: "failed", accent: "working" };

function StatusPill({ state, live }: { state: TaskState; live?: boolean }): JSX.Element {
  const m = STATE_META[state];
  return (
    <span className={`pill fam-${m.fam}`}>
      {live ? <span className="live-dot" /> : <span className="glyph"><m.Icon size={12} /></span>}
      {m.label}
    </span>
  );
}

/* --------------------------------- widgets --------------------------------- */

/** A right slide-in drawer, for settings & supervisor (mockup: calm side panels). */
function Drawer(
  { title, live, onClose, foot, children }:
  { title: ReactNode; live?: boolean; onClose: () => void; foot?: ReactNode; children: ReactNode },
): JSX.Element {
  useEsc(onClose);
  const trap = useFocusTrap<HTMLElement>();
  return (
    <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" ref={trap} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Panel"}>
        <div className="panel-head">
          <div className="panel-title-row">
            <h3>{title}</h3>
            {live && <span className="live-tag"><span className="live-dot" />live</span>}
          </div>
          <button className="btn icon" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </div>
        {children}
        {foot && <div className="panel-foot spread">{foot}</div>}
      </aside>
    </div>
  );
}

function ConfirmButton(
  { label, confirm, onConfirm, className = "danger-soft", plain }:
  { label: ReactNode; confirm: string; onConfirm: () => void; className?: string; plain?: boolean },
): JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      className={`${plain ? "" : "btn "}${className}${armed ? " armed" : ""}`}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
    >
      {armed ? confirm : label}
    </button>
  );
}

function Modal(
  { title, onClose, wide, children }:
  { title: string; onClose: () => void; wide?: boolean; children: ReactNode },
): JSX.Element {
  useEsc(onClose);
  const trap = useFocusTrap<HTMLDivElement>();
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`panel${wide ? " wide" : ""}`} ref={trap} role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          <h3>{title}</h3>
          <button className="btn icon" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}

/** Human label for a plan rate-limit window ("five_hour" → "5h window"). */
interface UsageLimit {
  kind: string; group: string; percent: number; severity: string; resets_at: string | null;
  is_active?: boolean; scope?: { model?: { display_name?: string | null } | null } | null;
}
interface UsageResp { limits?: UsageLimit[]; error?: string }

/** Poll the real subscription plan usage (5h session + weekly, per model) — the data
 *  Claude's own /usage screen shows, fetched server-side via the account's OAuth token. */
function usePlanLimits(active: boolean): UsageLimit[] {
  const [u, setU] = useState<UsageResp | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = (): void => {
      void fetchJSON<UsageResp>("/api/usage").then((d) => { if (alive) setU(d); }).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 120_000); // the endpoint is itself rate-limited; poll gently
    return () => { alive = false; clearInterval(id); };
  }, [active]);
  return (u?.limits ?? []).filter((l) => ["session", "weekly_all", "weekly_scoped"].includes(l.kind));
}

/** The project's pending backlog (tickets drafted but not yet run), with a manual
 *  refresh. Drives the Up-next draft cards and the Deps-button visibility, and
 *  polls gently so a ticket added elsewhere (phone, planner) shows up. */
function useBacklog(ws: string): { tickets: Ticket[]; refresh: () => void } {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const load = useCallback((): void => {
    void fetchJSON<{ tickets: Ticket[] }>("/api/backlog")
      .then((r) => setTickets(r.tickets ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [ws, load]);
  return { tickets, refresh: load };
}

/** Ticket ids the operator removed from the board (reversible hide). Server-backed
 *  per workspace; history and files are untouched. */
function useHidden(ws: string): { ids: Set<string>; hide: (id: string) => Promise<void>; unhide: (id: string) => Promise<void> } {
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

/** The full plan-usage bars (session + weekly + per-model), rendered from fetched limits. */
function PlanLimits({ limits }: { limits: UsageLimit[] }): JSX.Element | null {
  if (!limits.length) return null;
  const label = (l: UsageLimit): string =>
    l.kind === "session" ? "Current session"
      : l.kind === "weekly_all" ? "Weekly · all models"
      : l.kind === "weekly_scoped" ? `Weekly · ${l.scope?.model?.display_name ?? "top model"}`
      : l.kind;
  const resets = (iso: string | null): string => {
    if (!iso) return "";
    const s = (Date.parse(iso) - Date.now()) / 1000;
    return s > 0 ? `resets in ${fmtDuration(s)}` : "";
  };
  return (
    <div className="plan-limits">
      {limits.map((l) => (
        <div key={l.kind} className={`pl-row sev-${l.severity}`}>
          <div className="pl-top">
            <span className="pl-label">{label(l)}</span>
            <span className="pl-pct tnum">{Math.round(l.percent)}%</span>
          </div>
          <div className="pl-bar"><div className="pl-fill" style={{ width: `${Math.min(100, Math.max(2, l.percent))}%` }} /></div>
          <span className="pl-reset">{resets(l.resets_at)}</span>
        </div>
      ))}
    </div>
  );
}

/** Session cost/tokens + (on a subscription) the real plan usage limits.
 *  Collapsible — the plan bars are handy but not always wanted taking header room. */
function UsageCard(
  { mode, tokens, spent, budgetUsd, budgetPct, budgetColor, onAnalytics }:
  { mode: "subscription" | "api"; tokens: number; spent: number; budgetUsd: number | null;
    budgetPct: number; budgetColor: string; onAnalytics: () => void },
): JSX.Element {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("factory.usageCollapsed") === "1"; } catch { return false; }
  });
  const toggle = (): void => setCollapsed((c) => {
    const n = !c;
    try { localStorage.setItem("factory.usageCollapsed", n ? "1" : "0"); } catch { /* */ }
    return n;
  });
  const limits = usePlanLimits(mode !== "api");
  return (
    <div className={`usage-card${collapsed ? " collapsed" : ""}`} role="button" tabIndex={0}
      onClick={onAnalytics} title="Cost & activity over time"
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAnalytics(); } }}>
      <div className="u-top">
        <span className="u-cap">This session's usage · {mode === "api" ? "API" : "Subscription"}</span>
        <span className="u-tok">{fmtTokens(tokens)} tokens</span>
        <button className="u-collapse" onClick={(e) => { e.stopPropagation(); toggle(); }} aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand usage" : "Collapse usage"} title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>
      <div className="u-row">
        <span className="u-fig">{fmtUsd(spent)}</span>
        <span className="u-bud">
          {mode === "api"
            ? <>/ {budgetUsd ? fmtUsd(budgetUsd) : "no cap"} · billed</>
            : "API-equivalent · not charged"}
        </span>
      </div>
      {mode === "api" && (
        <div className="budget-bar"><div className="budget-fill" style={{ width: `${budgetPct}%`, background: budgetColor }} /></div>
      )}
      {/* Collapsed keeps just the session bar; expanded shows every limit + the trend link. */}
      {mode !== "api" && (
        <PlanLimits limits={collapsed ? limits.filter((l) => l.kind === "session") : limits} />
      )}
      {!collapsed && (
        <span className="u-hint">
          {mode === "api" ? "Real dollars · turns amber at 70% · red at 90% · cost trend" : "Cost & activity across runs"}
          <ArrowRight size={13} />
        </span>
      )}
    </div>
  );
}

/** The shipped tickets, chip-listed in the completed-run hero. "+N more" opens the
 *  full list in a modal (the tickets themselves — not cost). */
function ShippedChips({ merged, onMore }: { merged: TaskModel[]; onMore: () => void }): JSX.Element | null {
  if (merged.length === 0) return null;
  return (
    <ul className="synth-chips">
      {merged.slice(0, 5).map((t) => <li key={t.id} title={t.title}>{t.title}</li>)}
      {merged.length > 5 && (
        <li className="more"><button onClick={onMore}>+{merged.length - 5} more <ArrowRight size={12} /></button></li>
      )}
    </ul>
  );
}

/** Every shipped ticket with its cost/tokens — opened from the hero's "+N more". */
function ShippedModal({ merged, onOpenLog, onClose }: {
  merged: TaskModel[]; onOpenLog: (t: TaskModel) => void; onClose: () => void;
}): JSX.Element {
  return (
    <Modal title={`Shipped — ${merged.length} ticket${merged.length === 1 ? "" : "s"}`} onClose={onClose} wide>
      <div className="shipped-list">
        {merged.map((t) => (
          <button key={t.id} className="shipped-row" onClick={() => { onClose(); onOpenLog(t); }}>
            <span className="shipped-id tnum">{t.id}</span>
            <span className="shipped-title">{t.title}</span>
            <span className="shipped-meta tnum">
              {t.costUsd > 0 && <span className="cost">{fmtUsd(t.costUsd)}</span>}
              {t.tokens > 0 && <span className="tok">{fmtTokens(t.tokens)}</span>}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* --------------------------- command palette (Cmd-K) --------------------------- */

interface Command { id: string; label: string; hint?: string; group: string; run: () => void }

/** Fuzzy-ish filter: every query char appears in order somewhere in the haystack. */
function fuzzyMatch(query: string, hay: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase(), h = hay.toLowerCase();
  let i = 0;
  for (const ch of h) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return false;
}

/** One-keystroke launcher (Cmd/Ctrl+K): search every action and jump to it. */
function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }): JSX.Element {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trap = useFocusTrap<HTMLDivElement>();
  useEsc(onClose);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const shown = commands.filter((c) => fuzzyMatch(q, `${c.group} ${c.label} ${c.hint ?? ""}`));
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(".cmdk-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const runAt = (i: number): void => { const c = shown[i]; if (c) { onClose(); c.run(); } };
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); runAt(sel); }
  };

  // Group headers in list order, preserving the commands array order.
  const groups: string[] = [];
  for (const c of shown) if (!groups.includes(c.group)) groups.push(c.group);

  return (
    <div className="overlay cmdk-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" ref={trap} role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef} className="cmdk-input" placeholder="Type a command or search…"
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
        />
        <div className="cmdk-list" ref={listRef}>
          {shown.length === 0 && <div className="cmdk-empty">No matching command.</div>}
          {groups.map((g) => (
            <div key={g} className="cmdk-group">
              <div className="cmdk-grouphead">{g}</div>
              {shown.map((c, i) => c.group === g && (
                <button
                  key={c.id} className={`cmdk-row${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)} onClick={() => runAt(i)}
                >
                  <span className="cmdk-label">{c.label}</span>
                  {c.hint && <kbd className="cmdk-hint">{c.hint}</kbd>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="cmdk-foot">
          <span><kbd><ArrowUp size={12} /></kbd><kbd><ArrowDown size={12} /></kbd> navigate</span>
          <span><kbd><CornerDownLeft size={12} /></kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- controls --------------------------------- */

async function sendControl(op: string, taskId?: string, text?: string): Promise<void> {
  try {
    await postJSON("/api/control", { op, task: taskId, ...(text ? { text } : {}) });
    const messages: Record<string, string> = {
      pause: "Pausing — running agents finish, no new ones start.",
      resume: "Resuming.",
      stop: "Stopping — running agents finish, the rest stays queued.",
      kill: `Cancelling ${taskId} — it won't merge.`,
      retry: `${taskId} is back in the queue with a fresh budget.`,
      approve: `${taskId} approved — merging now.`,
      changes: `${taskId} sent back to the agent with your note.`,
    };
    toast(messages[op] ?? "Sent.");
  } catch (err) { toast(`Could not send the command: ${String(err)}`, true); }
}

/** Reply to a blocked agent: the answer is threaded to the agent on re-run. */
async function sendAnswer(taskId: string, text: string): Promise<void> {
  try {
    await postJSON("/api/control", { op: "answer", task: taskId, text });
    toast(`Answer sent — ${taskId} restarts with it.`);
  } catch (err) { toast(`Could not send the answer: ${String(err)}`, true); }
}

async function quickRun(): Promise<void> {
  try {
    await postJSON("/api/run", {});
    toast("New run starting — remaining tickets replay with the current config.");
  } catch (err) { toast(String(err), true); }
}

/* --------------------------------- board --------------------------------- */

type Screen = "projects" | "cockpit" | "memory";

type ModalState =
  | null
  | { type: "settings" }
  | { type: "newwork"; tab?: "one" | "goal" }
  | { type: "editticket"; ticket: BoardTicket }
  | { type: "repo" }
  | { type: "preview" }
  | { type: "cockpit" }
  | { type: "removed" }
  | { type: "answer"; taskId: string; title: string; question: string; context: BlockedContext | null }
  | { type: "lesson"; draft: { text: string; ticketId: string } }
  | { type: "runguard" }
  | { type: "appearance" }
  | { type: "diff"; taskId: string; title: string; diff: { repo: string; from: string; to: string } }
  | { type: "review"; taskId: string }
  | { type: "analytics" }
  | { type: "depgraph" }
  | { type: "cmdk" }
  | { type: "docs" }
  | { type: "shipped" }
  | { type: "aireview"; file: string; title: string }
  | { type: "log"; taskId: string; title: string };

function headline(model: Model, runActive: boolean): { text: string; tone: string } {
  if (!model.run) return { text: "No run yet — describe some work to begin.", tone: "warning" };
  if (!model.endedTs && !runActive) {
    return {
      text: "This run is no longer active — its process has stopped. Start a new run to finish the rest.",
      tone: "warning",
    };
  }
  const tasks = [...model.tasks.values()];
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

/** Post-run integration check (DevOps): the full suite on the merged branch. */
function IntegrationBanner({ integ }: { integ: Model["integration"] }): JSX.Element | null {
  const { running, results } = integ;
  if (!running && results.length === 0) return null;
  const failed = results.filter((r) => !r.ok);
  const tone = running ? "run" : failed.length ? "fail" : "pass";
  return (
    <div className={`integ-banner integ-${tone}`}>
      <span className="integ-icon">{running ? <RotateCw size={13} /> : failed.length ? <X size={13} /> : <Check size={13} />}</span>
      <div className="integ-body">
        {running
          ? <strong>Integration check running… (the full suite on the merged branch)</strong>
          : failed.length
            ? <strong>Integration check failed — the merged tickets don't hold together</strong>
            : <strong>Integration check passed — the merged tickets hold together</strong>}
        {failed.map((r, i) => (
          <div key={i} className="integ-fail">
            <span className="mono">{r.repo.split(/[\\/]/).pop()}</span>
            <ul>{r.failures.map((f, j) => <li key={j}>{f}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The payoff panel a finished run deserves — what shipped, in numbers, above the
 *  board. Without it the completed state is an empty Kanban under a green bar. */
function RunSummary(
  { tasks, startedTs, endedTs, spent, tokens, mode, onAnalytics }:
  { tasks: TaskModel[]; startedTs: string | null; endedTs: string | null; spent: number; tokens: number;
    mode?: "subscription" | "api"; onAnalytics?: () => void },
): JSX.Element | null {
  const merged = tasks.filter((t) => t.state === "DONE");
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const blocked = tasks.filter((t) => t.state === "BLOCKED" || t.state === "AWAITING_APPROVAL").length;
  if (merged.length === 0 && failed === 0) return null;
  const clean = failed === 0 && blocked === 0;
  const dur = startedTs && endedTs ? (Date.parse(endedTs) - Date.parse(startedTs)) / 1000 : null;
  const title = clean
    ? `Run complete — ${merged.length} ticket${merged.length === 1 ? "" : "s"} shipped`
    : `Run finished — ${merged.length} shipped${failed ? `, ${failed} failed` : ""}${blocked ? `, ${blocked} waiting on you` : ""}`;
  return (
    <section className={`run-summary${clean ? " clean" : ""}`} aria-label="Run summary">
      <div className="rs-head">
        <span className="rs-badge" aria-hidden="true">{clean ? <Check size={16} /> : <CircleDot size={16} />}</span>
        <div>
          <div className="rs-title">{title}</div>
          <div className="rs-sub">{clean ? "Merged into your base branch and verified." : "Some tickets need a look before they're done."}</div>
        </div>
      </div>
      <div className="rs-stats">
        <div className="rs-stat"><span className="rs-n tnum">{merged.length}</span><span className="rs-k">shipped</span></div>
        {dur !== null && <div className="rs-stat"><span className="rs-n tnum">{fmtDuration(dur)}</span><span className="rs-k">wall time</span></div>}
        <div className="rs-stat"><span className="rs-n tnum">{fmtUsd(spent)}</span><span className="rs-k">{mode === "api" ? "cost" : "est. cost"}</span></div>
        <div className="rs-stat"><span className="rs-n tnum">{fmtTokens(tokens)}</span><span className="rs-k">tokens</span></div>
        {onAnalytics && (
          <button className="rs-trend" onClick={onAnalytics}>Cost &amp; activity across runs <ArrowRight size={13} /></button>
        )}
      </div>
      {merged.length > 0 && (
        <ul className="rs-list">
          {merged.slice(0, 6).map((t) => <li key={t.id}>{t.title}</li>)}
          {merged.length > 6 && <li className="rs-more">+{merged.length - 6} more</li>}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------ cost analytics (D8) ------------------------------ */

interface RunPoint { run: string; ts: string | null; spend: number; tokens: number; merged: number; needs: number; total: number; mode?: "subscription" | "api" }

/** A dependency-free SVG bar chart, theme-aware via currentColor + CSS vars.
 *  A bar reveals its value + run on hover (desktop) or tap (mobile). */
function BarChart(
  { data, fmt, height = 120 }:
  { data: Array<{ label: string; value: number; hint: string }>; fmt: (n: number) => string; height?: number },
): JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const n = Math.max(1, data.length);
  const bw = 100 / n;
  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img"
        aria-label={data.length ? `Bar chart, ${data.length} point${data.length === 1 ? "" : "s"}, latest ${fmt(data[data.length - 1]!.value)}` : "Bar chart, no data"}>
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 18);
          return (
            <rect key={i} className={`bar${active === i ? " on" : ""}`} x={i * bw + bw * 0.15} y={height - 14 - h}
              width={bw * 0.7} height={Math.max(0.5, h)} rx={0.6}
              onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive((a) => (a === i ? null : a))}
              onClick={() => setActive((a) => (a === i ? null : i))} />
          );
        })}
      </svg>
      {active !== null && data[active] && (
        <div className="chart-tip" style={{ left: `${Math.min(88, Math.max(12, (active + 0.5) * bw))}%` }}>
          <span className="chart-tip-v">{data[active]!.hint}</span>
          <span className="chart-tip-l">{data[active]!.label}</span>
        </div>
      )}
    </div>
  );
}

/** A run id like "2026-07-17_203726" → a human date+time, from the timestamp when
 *  present (falls back to parsing the id). */
function humanRun(r: RunPoint): string {
  const d = r.ts ? new Date(r.ts) : null;
  if (d && !Number.isNaN(d.getTime())) {
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }
  return r.run.replace(/^\d{4}-/, "").replace("_", " · ");
}

function AnalyticsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [series, setSeries] = useState<RunPoint[] | null>(null);
  useEffect(() => {
    void fetchJSON<{ series: RunPoint[] }>("/api/analytics").then((r) => setSeries(r.series)).catch(() => setSeries([]));
  }, []);
  const runs = series ?? [];
  const totalSpend = runs.reduce((a, r) => a + r.spend, 0);
  const totalTokens = runs.reduce((a, r) => a + r.tokens, 0);
  const totalMerged = runs.reduce((a, r) => a + r.merged, 0);
  const peakSpend = Math.max(0, ...runs.map((r) => r.spend));
  const peakTokens = Math.max(0, ...runs.map((r) => r.tokens));
  const costCaption = runs.every((r) => r.mode !== "api") ? "estimated · not billed"
    : runs.every((r) => r.mode === "api") ? "billed to your API key" : "estimated · some billed";
  return (
    <Modal title="Cost & activity over time" onClose={onClose} wide>
      {series === null ? <Skeleton lines={4} />
        : runs.length === 0 ? <p className="hint">No runs yet — this fills in once you've run some work.</p>
        : (
          <div className="analytics">
            <p className="an-intro">Every run you've done — what it cost, how many tokens it used, and how many tickets it shipped.</p>
            <div className="an-tiles">
              <div className="an-tile"><span className="an-fig">{fmtUsd(totalSpend)}</span><span className="an-cap">{costCaption}</span></div>
              <div className="an-tile"><span className="an-fig">{fmtTokens(totalTokens)}</span><span className="an-cap">tokens used</span></div>
              <div className="an-tile"><span className="an-fig">{totalMerged}</span><span className="an-cap">tickets shipped · {runs.length} run{runs.length > 1 ? "s" : ""}</span></div>
            </div>

            <div className="an-chart-block">
              <div className="an-chart-head"><h4 className="an-h">What each run cost</h4>{peakSpend > 0 && <span className="an-peak">most expensive: {fmtUsd(peakSpend)}</span>}</div>
              <BarChart data={runs.map((r) => ({ label: humanRun(r), value: r.spend, hint: fmtUsd(r.spend) }))} fmt={fmtUsd} />
            </div>
            <div className="an-chart-block">
              <div className="an-chart-head"><h4 className="an-h">Tokens each run used</h4>{peakTokens > 0 && <span className="an-peak">busiest: {fmtTokens(peakTokens)}</span>}</div>
              <BarChart data={runs.map((r) => ({ label: humanRun(r), value: r.tokens, hint: fmtTokens(r.tokens) }))} fmt={fmtTokens} />
            </div>

            <div className="an-table">
              <div className="an-row an-head">
                <span>Run</span><span>Cost</span><span>Tokens</span><span>Result</span>
              </div>
              {[...runs].reverse().map((r) => (
                <div key={r.run} className="an-row">
                  <span className="an-when">{humanRun(r)}</span>
                  <span className="an-spend">{fmtUsd(r.spend)}</span>
                  <span className="an-tok">{fmtTokens(r.tokens)}</span>
                  <span className="an-result">
                    {r.merged > 0
                      ? <span className="ok">{r.merged} shipped</span>
                      : <span className="none">nothing shipped</span>}
                    {r.needs > 0 && <span className="warn"> · {r.needs} need you</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
    </Modal>
  );
}

/* ------------------------------ dependency graph (D7) ------------------------------ */

interface DepNode { id: string; title: string; deps: string[] }

function parseTicketDeps(content: string): { id: string; title: string; deps: string[] } {
  const id = content.match(/^id:\s*["']?([\w.-]+)["']?/m)?.[1] ?? "?";
  const title = ticketTitle(content);
  const depLine = content.match(/^depends_on:\s*(.+)$/m)?.[1] ?? "";
  const deps = [...depLine.matchAll(/["']?([\w.-]+)["']?/g)].map((m) => m[1]!).filter((d) => d && d !== "[]");
  return { id, title, deps };
}

/** Longest-path layering → columns; simple, no crossing-minimisation, but enough
 *  to read what blocks what and the critical path. */
function layerNodes(nodes: DepNode[]): DepNode[][] {
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

function DepGraphModal({ stateOf, onClose }: { stateOf: (id: string) => TaskState | undefined; onClose: () => void }): JSX.Element {
  const [nodes, setNodes] = useState<DepNode[] | null>(null);
  useEffect(() => {
    void fetchJSON<{ tickets: Array<{ content: string }> }>("/api/backlog")
      .then((r) => setNodes(r.tickets.map((t) => parseTicketDeps(t.content))))
      .catch(() => setNodes([]));
  }, []);
  if (nodes === null) return <Modal title="Ticket dependencies" onClose={onClose} wide><Skeleton lines={4} /></Modal>;
  if (nodes.length === 0) return <Modal title="Ticket dependencies" onClose={onClose} wide><p className="hint">No pending tickets — the graph shows the current backlog (merged tickets are archived).</p></Modal>;

  const layers = layerNodes(nodes);
  const COL = 210, ROW = 92, NW = 168, NH = 58, PAD = 24;
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, ci) => layer.forEach((n, ri) => pos.set(n.id, { x: PAD + ci * COL, y: PAD + ri * ROW })));
  const width = PAD * 2 + Math.max(1, layers.length) * COL;
  const height = PAD * 2 + Math.max(1, ...layers.map((l) => l.length)) * ROW;
  const fam = (id: string): string => {
    const st = stateOf(id);
    return st ? (STATE_META[st]?.fam ?? "upnext") : "upnext";
  };
  return (
    <Modal title="Ticket dependencies" onClose={onClose} wide>
      <p className="hint dep-legend">Arrows point from a ticket to what it depends on. Columns are the execution order (leftmost runs first).</p>
      <div className="depgraph-scroll">
        <svg className="depgraph" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="dep-arrowhead" />
            </marker>
          </defs>
          {nodes.flatMap((n) => n.deps.map((d) => {
            const a = pos.get(n.id), b = pos.get(d);
            if (!a || !b) return null;
            const x1 = a.x, y1 = a.y + NH / 2, x2 = b.x + NW, y2 = b.y + NH / 2;
            const mx = (x1 + x2) / 2;
            return <path key={`${n.id}-${d}`} className="dep-edge" markerEnd="url(#arrow)" d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} />;
          }))}
          {nodes.map((n) => {
            const p = pos.get(n.id)!;
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                <rect className={`dep-node fam-${fam(n.id)}`} width={NW} height={NH} rx={8} />
                <text className="dep-id" x={10} y={20}>{n.id}</text>
                <text className="dep-title" x={10} y={38}>{n.title.length > 26 ? n.title.slice(0, 25) + "…" : n.title}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </Modal>
  );
}

/** Remote sync outcome at run start (PR mode keeps the base fresh). */
function SyncNote({ sync }: { sync: Model["sync"] }): JSX.Element | null {
  if (!sync || (sync.behind === 0 && sync.ahead === 0)) return null;
  const msg = sync.pulled
    ? `Base was ${sync.behind} commit${sync.behind > 1 ? "s" : ""} behind the remote — pulled to catch up.`
    : sync.behind > 0
      ? `Base is ${sync.behind} behind and ${sync.ahead} ahead of the remote (diverged) — not pulled; reconcile by hand.`
      : `Base is ${sync.ahead} commit${sync.ahead > 1 ? "s" : ""} ahead of the remote (unpushed).`;
  return (
    <div className={`sync-note ${sync.pulled ? "sync-pulled" : "sync-warn"}`}>
      <span className="sync-icon">{sync.pulled ? <ArrowDownToLine size={13} /> : <ArrowUpFromLine size={13} />}</span>
      <span>{msg}</span>
    </div>
  );
}

/* --------------------------------- kanban --------------------------------- */

/** States a new run would actually (re-)execute — what "Run again (N)" counts.
 *  Excludes DONE (merged), AWAITING_APPROVAL (finished, needs your approval — not a
 *  re-run) and MERGE_QUEUED/MERGING (already succeeded, about to land). */
const RERUNNABLE: ReadonlySet<TaskState> = new Set<TaskState>([
  "QUEUED", "RUNNING", "VERIFYING", "REVIEWING", "FAILED", "BLOCKED",
] as TaskState[]);

const COLUMNS: Array<{ key: string; title: string; states: TaskState[]; tone: string }> = [
  { key: "queued", title: "Up next", states: ["QUEUED"], tone: "neutral" },
  { key: "working", title: "Working", states: ["RUNNING"], tone: "accent" },
  { key: "checking", title: "Checking", states: ["VERIFYING", "REVIEWING"], tone: "accent" },
  { key: "approval", title: "To review", states: ["AWAITING_APPROVAL"], tone: "critical" },
  { key: "merging", title: "Merging", states: ["MERGE_QUEUED", "MERGING"], tone: "accent" },
  { key: "done", title: "Merged", states: ["DONE"], tone: "good" },
  { key: "attention", title: "Needs you", states: ["FAILED", "BLOCKED"], tone: "critical" },
];

/** Inline actions for a card, mirroring the prototype's per-status button set. */
function CardActions(
  { t, live, onLog, onAnswer, onLesson, onDiff }:
  { t: TaskModel; live: boolean; onLog: () => void; onAnswer: () => void; onLesson: () => void; onDiff: () => void },
): JSX.Element {
  const attention = t.state === "FAILED" || t.state === "BLOCKED";
  return (
    <div className="kcard-actions" onClick={(e) => e.stopPropagation()}>
      {t.state === "BLOCKED" && live && (
        <button className="act primary" onClick={onAnswer}>Answer</button>
      )}
      {attention && !(t.state === "BLOCKED" && live) && (live
        ? <Button kind="act" variant="primary" autoPending onClick={() => sendControl("retry", t.id)}>Try again</Button>
        : <button className="act primary" onClick={() => void quickRun()}>Run again</button>)}
      {(t.state === "RUNNING" || t.state === "VERIFYING" || t.state === "REVIEWING") && live && (
        <Button kind="act" variant="danger" autoPending onClick={() => sendControl("kill", t.id)}>Stop</Button>
      )}
      {t.state === "AWAITING_APPROVAL" && (
        <Button kind="act" variant="primary" autoPending onClick={() => sendControl("approve", t.id)}>Approve</Button>
      )}
      {t.state === "AWAITING_APPROVAL" && (
        <button className="act ghost" onClick={onDiff}>Review</button>
      )}
      {t.state === "AWAITING_APPROVAL" && live && (
        <ConfirmButton label="Discard" confirm="Discard before merge?" plain className="act danger"
          onConfirm={() => void sendControl("kill", t.id)} />
      )}
      {t.state === "QUEUED" && live && (
        <ConfirmButton label="Cancel" confirm="Remove before it runs?" plain className="act danger"
          onConfirm={() => void sendControl("kill", t.id)} />
      )}
      {attention && (
        <button className="act ghost" onClick={onLesson} title="Record what went wrong as a lesson for next time">Save lesson</button>
      )}
      {t.state === "DONE" && t.prUrl && (
        <a className="act ghost" href={t.prUrl} target="_blank" rel="noreferrer">View PR <ExternalLink size={13} /></a>
      )}
      {t.state === "DONE" && t.diff && (
        <button className="act ghost" onClick={onDiff}>View diff</button>
      )}
      {t.diff?.repo && (
        <a className="act ghost" title="Open the repo in your IDE"
          href={`vscode://file/${t.diff.repo.replace(/\\/g, "/")}`}>Open in IDE</a>
      )}
      {t.state !== "AWAITING_APPROVAL" && (
        <button className="act ghost" onClick={onLog}>{inFlight(t.state) ? "Watch live" : "History"}</button>
      )}
    </div>
  );
}

/** The measures band: live timer (chip-coloured) · cost · tokens · attempt. */
function CardMeasures({ t, now }: { t: TaskModel; now: number }): JSX.Element | null {
  const running = t.state === "RUNNING" && t.runningSince !== null;
  const hasTimer = running || t.wallS !== null;
  const liveTokens = running && t.liveTokens > 0;
  if (!hasTimer && t.costUsd === 0 && t.retries === 0) return null;
  return (
    <div className="meas">
      {running
        ? <span className="timer"><span className="d" />{fmtDuration((now - t.runningSince!) / 1000)}</span>
        : t.wallS !== null ? <span className="cost">{fmtDuration(t.wallS)}</span> : null}
      {/* While running, show the live turn/token count (C6); after, the final cost. */}
      {running && t.liveTurns > 0 && <span className="tok" title="Turns so far">turn {t.liveTurns}</span>}
      {liveTokens && <span className="tok live" title="Tokens so far (live)">{fmtTokens(t.liveTokens)}</span>}
      {!running && t.costUsd > 0 && <span className="cost" title="Cost">{fmtUsd(t.costUsd)}</span>}
      {!running && t.tokens > 0 && <span className="tok" title="Tokens">{fmtTokens(t.tokens)}</span>}
      {t.retries > 0 && <span className="try">attempt {t.retries + 1}</span>}
    </div>
  );
}

function KanbanCard(
  { t, live, now, onLog, onAnswer, onLesson, onDiff, onDelete }:
  { t: TaskModel; live: boolean; now: number; onLog: () => void; onAnswer: () => void; onLesson: () => void; onDiff: () => void; onDelete?: () => void },
): JSX.Element {
  const attention = t.state === "FAILED" || t.state === "BLOCKED";
  const running = t.state === "RUNNING";
  return (
    <div className={`kcard state-${t.state.toLowerCase()}`} onClick={onLog}
      role="button" tabIndex={0} aria-label={`${t.id} ${t.title} — ${STATE_META[t.state].label}. Open its history`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onLog(); } }}
      title="Open its history">
      <div className="kcard-head">
        <span className="kcard-id">{t.id}</span>
        {t.model && <span className="model-badge" title="Model pinned for this ticket">{t.model}</span>}
        {t.effort && <span className="model-badge" title="Reasoning effort pinned for this ticket"><Brain size={12} /> {t.effort}</span>}
        <StatusPill state={t.state} live={running} />
        {onDelete && (
          <button className="btn icon kcard-del" aria-label="Remove from board" title="Remove from the board (keeps run history — restore it from “Removed”)"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
        )}
      </div>
      <div className="kcard-title">{t.title}</div>
      <div className="kcard-activity">
        {running && <span className="pulse" />}
        <span>{t.note && !attention ? t.note : ACTIVITY[t.state]}</span>
      </div>
      {attention && t.note && <div className="kcard-note"><span className="flag"><Flag size={12} /></span><span>{t.note}</span></div>}
      <CardMeasures t={t} now={now} />
      <CardActions t={t} live={live} onLog={onLog} onAnswer={onAnswer} onLesson={onLesson} onDiff={onDiff} />
    </div>
  );
}

interface BoardTicket {
  file: string; content: string; id: string; title: string;
  assignee: "ai" | "human"; status: string; hold: boolean;
}

/** Removed tickets: hidden from the board (history + files intact), restorable. */
function RemovedModal(
  { removed, onRestore, onClose }:
  { removed: Array<{ id: string; title: string }>; onRestore: (id: string) => Promise<void>; onClose: () => void },
): JSX.Element {
  return (
    <Modal title="Removed tickets" onClose={onClose}>
      <p className="phone-sub" style={{ marginTop: 0 }}>
        These are hidden from the board only — their run history and files are untouched. Restore any of them below.
      </p>
      {removed.length === 0 ? (
        <div className="kcol-empty">Nothing removed.</div>
      ) : (
        <div className="removed-list">
          {removed.map((r) => (
            <div key={r.id} className="removed-row">
              <span className="kcard-id">{r.id}</span>
              <span className="removed-title">{r.title}</span>
              <Button kind="btn" variant="ghost" autoPending onClick={() => onRestore(r.id)}>
                <RotateCw size={13} /> Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** The "+ Add a ticket" affordance that lives in the Up-next column (and Focus). */
function AddTicketCard({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button className="add-ticket-card" onClick={onClick}>
      <Plus size={16} /> <span>Add a ticket</span>
    </button>
  );
}

/** An AI backlog ticket drafted but not yet run — a light "queued" card in Up
 *  next. It can be paused (hold), handed to the developer, edited or deleted. */
function DraftCard(
  { draft, onEdit, onDelete, onAssign, onHold }:
  { draft: BoardTicket; onEdit: () => void; onDelete: () => void; onAssign: () => void; onHold: () => void },
): JSX.Element {
  return (
    <div className={`kcard draft-card${draft.hold ? " is-held" : ""}`} role="button" tabIndex={0} onClick={onEdit}
      onKeyDown={(e) => { if (e.key === "Enter") onEdit(); }}>
      <div className="kcard-head">
        <span className="kcard-id">{draft.id}</span>
        <span className="draft-chip">{draft.hold ? "held" : "draft"}</span>
        <button className="btn icon draft-edit" aria-label="Edit ticket" title="Edit this ticket" onClick={(e) => { e.stopPropagation(); onEdit(); }}><Pencil size={13} /></button>
        <button className="btn icon draft-del" aria-label="Delete ticket" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
      </div>
      <div className="kcard-title">{draft.title}</div>
      <div className="kcard-actions" onClick={(e) => e.stopPropagation()}>
        <button className="act ghost" title={draft.hold ? "Let a run pick this up again" : "Pause: a run will skip this ticket"}
          onClick={(e) => { e.stopPropagation(); onHold(); }}>{draft.hold ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Hold</>}</button>
        <button className="act ghost" title="Take it yourself — the AI won't run it"
          onClick={(e) => { e.stopPropagation(); onAssign(); }}><Laptop size={13} /> Do it myself</button>
      </div>
    </div>
  );
}

/** A human-owned ticket: the developer's own work, dragged across the board and
 *  never touched by the AI. Drag it between columns to set its status; hand it to
 *  the AI to drop it back into the automated pipeline. */
function ManualCard(
  { ticket, onDragStart, onDragEnd, onEdit, onAssignAi, onDelete, onReview }:
  { ticket: BoardTicket; onDragStart: () => void; onDragEnd: () => void; onEdit: () => void; onAssignAi: () => void;
    onDelete: () => void; onReview: () => void },
): JSX.Element {
  return (
    <div className="kcard manual-card" draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", ticket.file); e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd} title="Drag me between columns">
      <div className="kcard-head">
        <span className="kcard-id">{ticket.id}</span>
        <span className="you-chip"><Laptop size={11} /> You</span>
        <button className="btn icon draft-edit" aria-label="Edit ticket" title="Edit this ticket" onClick={(e) => { e.stopPropagation(); onEdit(); }}><Pencil size={13} /></button>
        <button className="btn icon draft-del" aria-label="Delete ticket" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
      </div>
      <div className="kcard-title">{ticket.title}</div>
      <div className="kcard-actions">
        {(ticket.status === "review" || ticket.status === "done") && (
          <button className="act primary" title="Optional: let the AI review the work you just finished"
            onClick={(e) => { e.stopPropagation(); onReview(); }}><Sparkles size={13} /> Ask AI to review</button>
        )}
        <button className="act ghost" title="Hand this ticket to the AI agents" onClick={(e) => { e.stopPropagation(); onAssignAi(); }}><Bot size={13} /> Give to AI</button>
      </div>
    </div>
  );
}

/** Opt-in companion review: the AI reads the diff of a manual ticket the dev just
 *  finished, against the ticket's intent, and gives concise feedback. Purely a
 *  choice — nothing runs unless the operator asks for it from a done manual card. */
function AiReviewModal(
  { file, title, onClose, onSendToAi }:
  { file: string; title: string; onClose: () => void; onSendToAi: (review: string) => Promise<void> },
): JSX.Element {
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [text, setText] = useState("");
  useEffect(() => {
    void (async () => {
      try {
        const r = await postJSON<{ review?: string; error?: string }>("/api/ticket/review", { file });
        const body = r.review?.trim();
        if (body) { setText(body); setState("done"); }
        else { setText(r.error || "The reviewer returned nothing — try again in a moment."); setState("error"); }
      } catch (err) { setText(String(err)); setState("error"); }
    })();
  }, [file]);
  return (
    <Modal title={`AI review — ${title}`} onClose={onClose}>
      {state === "loading"
        ? <div className="ai-review-wait"><span className="spinner" /> Reading your changes and reviewing…</div>
        : <div className={`ai-review${state === "error" ? " is-error" : ""}`}>{text}</div>}
      {state === "done" && (
        <div className="ai-review-actions">
          <button className="btn ghost" onClick={onClose}>Looks good — close</button>
          <Button kind="btn" variant="primary" autoPending onClick={() => onSendToAi(text)}>
            <Bot size={14} /> Hand to AI to fix
          </Button>
        </div>
      )}
    </Modal>
  );
}

/** Which board column a manual ticket's status lives in, and the reverse: the
 *  status a manual ticket takes when dropped in a given column. Manual work only
 *  ever sits in these three human-meaningful lanes. */
const MANUAL_COL: Record<string, string> = { todo: "queued", doing: "working", review: "approval", done: "done" };
const COL_STATUS: Record<string, string> = { queued: "todo", working: "doing", approval: "review", done: "done" };

function Kanban(
  { tasks, live, now, onLog, onAnswer, onLesson, onDiff, focus, pending, manual,
    onAddTicket, onEditTicket, onRemoveTicket, onRemoveTask, onMoveManual, onSetAssignee, onSetHold, onReviewManual }:
  { tasks: TaskModel[]; live: boolean; now: number; onLog: (t: TaskModel) => void;
    onAnswer: (t: TaskModel) => void; onLesson: (t: TaskModel) => void; onDiff: (t: TaskModel) => void; focus?: boolean;
    pending: BoardTicket[]; manual: BoardTicket[]; onAddTicket: () => void; onEditTicket: (bt: BoardTicket) => void;
    onRemoveTicket: (bt: BoardTicket) => void; onRemoveTask: (id: string) => void; onMoveManual: (bt: BoardTicket, status: string) => void;
    onSetAssignee: (bt: BoardTicket, toHuman: boolean) => void; onSetHold: (bt: BoardTicket, on: boolean) => void;
    onReviewManual: (bt: BoardTicket) => void },
): JSX.Element {
  const [drag, setDrag] = useState<string | null>(null); // file of the manual card being dragged
  const boardRef = useRef<HTMLElement>(null);
  // Pin every column that FITS the board so it never scrolls; only a column taller
  // than the viewport stays unpinned and scrolls (as a whole) with the board. CSS
  // alone can't tell short from tall, so measure after each render (7 cols = cheap).
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const measure = (): void => {
      const bh = board.clientHeight;
      board.querySelectorAll<HTMLElement>(".kcol").forEach((col) => {
        col.classList.remove("kcol-pinned");                 // measure natural height unpinned
        col.classList.toggle("kcol-pinned", col.offsetHeight <= bh);
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  const byState = (states: TaskState[]) => tasks.filter((t) => states.includes(t.state));
  const manualIn = (colKey: string) => manual.filter((m) => (MANUAL_COL[m.status] ?? "queued") === colKey);
  // Focus view keeps only the columns that need a human, attention first.
  const cols = focus
    ? COLUMNS.filter((c) => c.key === "attention" || c.key === "working")
        .sort((a) => (a.key === "attention" ? -1 : 1))
    : COLUMNS;

  const draftCard = (d: BoardTicket) => (
    <DraftCard key={d.file} draft={d} onEdit={() => onEditTicket(d)} onDelete={() => onRemoveTicket(d)}
      onAssign={() => onSetAssignee(d, true)} onHold={() => onSetHold(d, !d.hold)} />
  );
  const manualCard = (m: BoardTicket) => (
    <ManualCard key={m.file} ticket={m} onDragStart={() => setDrag(m.file)} onDragEnd={() => setDrag(null)}
      onEdit={() => onEditTicket(m)} onAssignAi={() => onSetAssignee(m, false)}
      onDelete={() => onRemoveTicket(m)} onReview={() => onReviewManual(m)} />
  );
  const taskCard = (t: TaskModel) => (
    <KanbanCard key={t.id} t={t} live={live} now={now} onDelete={() => onRemoveTask(t.id)}
      onLog={() => onLog(t)} onAnswer={() => onAnswer(t)} onLesson={() => onLesson(t)} onDiff={() => onDiff(t)} />
  );

  // The Up-next body: the Add affordance, then running QUEUED cards, AI drafts and
  // manual "to do" cards. Keep the "No tasks" placeholder when the column is empty.
  const queuedBody = (items: TaskModel[]): JSX.Element => {
    const mine = manualIn("queued");
    return (
      <>
        <AddTicketCard onClick={onAddTicket} />
        {items.map(taskCard)}
        {pending.map(draftCard)}
        {mine.map(manualCard)}
        {items.length === 0 && pending.length === 0 && mine.length === 0 && <div className="kcol-empty">No tasks</div>}
      </>
    );
  };

  return (
    <main className={`board${focus ? " focus" : ""}`} ref={boardRef}>
      <div className="board-track">
        {cols.map((col) => {
          const items = byState(col.states);
          const mine = manualIn(col.key);
          const isQueued = col.key === "queued";
          const dropStatus = COL_STATUS[col.key]; // set only on the three human lanes
          const canDrop = !!dropStatus && drag !== null;
          const count = (isQueued ? items.length + pending.length : items.length) + mine.length;
          const isEmpty = items.length === 0 && mine.length === 0 && !isQueued;
          return (
            <section key={col.key}
              className={`kcol kcol-${col.key} tone-${col.tone}${isEmpty ? " is-empty" : ""}${canDrop ? " kcol-drop" : ""}`}
              onDragOver={canDrop ? (e) => e.preventDefault() : undefined}
              onDrop={dropStatus ? (e) => {
                e.preventDefault();
                const file = e.dataTransfer.getData("text/plain") || drag;
                const bt = manual.find((m) => m.file === file);
                if (bt && bt.status !== dropStatus) onMoveManual(bt, dropStatus);
                setDrag(null);
              } : undefined}>
              <div className="kcol-head">
                <span className="kcol-title">{col.title}</span>
                <span className="kcol-count">{count}</span>
              </div>
              <div className="kcol-body">
                {isQueued
                  ? queuedBody(items)
                  : items.length === 0 && mine.length === 0
                    ? <div className="kcol-empty">No tasks</div>
                    : <>{items.map(taskCard)}{mine.map(manualCard)}</>}
              </div>
            </section>
          );
        })}
        {/* Focus hides the queued column, but you can still add work from here. */}
        {focus && (
          <section className="kcol kcol-queued tone-neutral">
            <div className="kcol-head">
              <span className="kcol-title">Up next</span>
              <span className="kcol-count">{pending.length + manualIn("queued").length}</span>
            </div>
            <div className="kcol-body">{queuedBody([])}</div>
          </section>
        )}
      </div>
    </main>
  );
}

/* --------------------------------- App --------------------------------- */

function App(): JSX.Element {
  const [ws, setWsState] = useState(getWs());
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [boardQuery, setBoardQuery] = useState("");
  const [view, setViewState] = useState<"kanban" | "focus">(() => {
    try { return (localStorage.getItem("factory.view") as "kanban" | "focus") || "kanban"; }
    catch { return "kanban"; }
  });
  const setView = (v: "kanban" | "focus"): void => {
    setViewState(v);
    try { localStorage.setItem("factory.view", v); } catch { /* */ }
  };
  const [screen, setScreenState] = useState<Screen>(() => {
    try { return (localStorage.getItem("factory.screen") as Screen) || "projects"; }
    catch { return "projects"; }
  });
  const setScreen = (s: Screen): void => {
    setScreenState(s);
    try { localStorage.setItem("factory.screen", s); } catch { /* */ }
  };
  const theme = useTheme();
  const notify = useNotifyPref();
  const [model, tick, connected] = useEventStream(ws);
  const runActive = useRunActive(tick);
  const backlog = useBacklog(ws);
  const hidden = useHidden(ws);
  const hasDeps = backlog.tickets.some((t) => parseTicketDeps(t.content).deps.length > 0);
  useStateAlerts(model, notify.on);
  const companion = useCompanion(ws);
  const [railOpen, setRailOpenState] = useState(() => {
    // Respect an explicit choice; with none, keep the board as the primary surface
    // on a phone (the rail is a full-screen overlay there) and open it on desktop.
    let pref: string | null = null;
    try { pref = localStorage.getItem("factory.rail"); } catch { /* private mode */ }
    if (pref === "0") return false;
    if (pref === "1") return true;
    return typeof window !== "undefined" ? window.innerWidth >= 900 : true;
  });
  const setRailOpen = (v: boolean): void => {
    setRailOpenState(v);
    try { localStorage.setItem("factory.rail", v ? "1" : "0"); } catch { /* */ }
  };
  // Desktop ping on an attention-level observation (failure, blocked, budget)
  // when the tab is backgrounded. Same OS tag as the board alerts, so they
  // collapse instead of double-notifying.
  const lastNotified = useRef<string | null>(null);
  useEffect(() => {
    const latest = companion.obs[companion.obs.length - 1];
    if (!latest || latest.id === lastNotified.current) return;
    lastNotified.current = latest.id;
    if (latest.level === "attention" && notify.on && document.hidden) {
      sendNotification("Agent Factory", latest.text);
    }
  }, [companion.obs, notify.on]);
  const anyRunning = [...model.tasks.values()].some((t) => t.runningSince !== null);
  const now = useNow(anyRunning || model.ratePause !== null || model.planLimit !== null);

  const loadWorkspaces = async (): Promise<void> => {
    try {
      const { workspaces: list } = await fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
      setWorkspaces(list);
      if (!list.some((w) => w.name === ws)) { setWs(list[0]?.name ?? ""); setWsState(list[0]?.name ?? ""); }
    } catch { /* offline */ }
  };
  useEffect(() => { void loadWorkspaces(); }, []);

  // Keyboard shortcuts (Escape-to-close lives on each overlay). Cockpit only,
  // never while a modal is up or a field is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (screen !== "cockpit") return;
      // Cmd/Ctrl+K is a chord — fires even from inside inputs or over a modal.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setModal((m) => (m && m.type === "cmdk" ? null : { type: "cmdk" }));
        return;
      }
      if (modal) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.key === "n") { e.preventDefault(); setModal({ type: "newwork" }); }
      else if (e.key === "f") { setView(view === "focus" ? "kanban" : "focus"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, screen, view]);

  const tasks = [...model.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  const head = headline(model, runActive);
  const live = Boolean(model.run) && !model.endedTs && runActive;
  const done = tasks.filter((t) => t.state === "DONE");
  const attention = tasks.filter((t) => t.state === "BLOCKED" || t.state === "FAILED");
  const working = tasks.filter((t) => inFlight(t.state));
  const queued = tasks.filter((t) => t.state === "QUEUED");
  const openLog = (t: TaskModel) => setModal({ type: "log", taskId: t.id, title: t.title });
  const openAnswer = (t: TaskModel) =>
    setModal({ type: "answer", taskId: t.id, title: t.title, question: t.note ?? "",
               context: t.blockedContext });
  const openLesson = (t: TaskModel) =>
    setModal({ type: "lesson", draft: { text: t.note ? `${t.note}\n\nLesson: ` : "", ticketId: t.id } });
  const openDiff = (t: TaskModel) => {
    if (!t.diff) return;
    // In control mode, reviewing a ticket awaiting approval opens the richer
    // review flow (inline comments that loop back to the agent); elsewhere the
    // diff is read-only.
    if (t.state === "AWAITING_APPROVAL") setModal({ type: "review", taskId: t.id });
    else setModal({ type: "diff", taskId: t.id, title: t.title, diff: t.diff });
  };

  const openProject = (name: string): void => {
    setWs(name); setWsState(name); setScreen("cockpit");
  };

  const switchWs = (name: string): void => { setWs(name); setWsState(name); };
  const runnableCount = [...model.tasks.values()].filter((t) => RERUNNABLE.has(t.state)).length;

  // Command palette (Cmd-K): every navigation + action reachable by keyboard.
  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "newwork", group: "Actions", label: "New work", hint: "n", run: () => setModal({ type: "newwork" }) },
      { id: "settings", group: "Open", label: "Settings", run: () => setModal({ type: "settings" }) },
      { id: "docs", group: "Open", label: "Knowledge base", run: () => setModal({ type: "docs" }) },
      { id: "repo", group: "Open", label: "Repo explorer", run: () => setModal({ type: "repo" }) },
      { id: "deps", group: "Open", label: "Dependency graph", run: () => setModal({ type: "depgraph" }) },
      { id: "analytics", group: "Open", label: "Cost analytics", run: () => setModal({ type: "analytics" }) },
      { id: "supervisor", group: "Open", label: "Supervisor", run: () => setRailOpen(true) },
      { id: "preview", group: "Open", label: "View result (preview)", run: () => setModal({ type: "preview" }) },
      { id: "cockpit", group: "Open", label: "Project cockpit (run / build / install)", run: () => setModal({ type: "cockpit" }) },
      { id: "appearance", group: "Open", label: "Appearance", run: () => setModal({ type: "appearance" }) },
    ];
    if (runnableCount > 0) {
      nav.splice(1, 0, { id: "runagain", group: "Actions", label: `Run again (${runnableCount} ticket${runnableCount > 1 ? "s" : ""})`, run: () => setModal({ type: "runguard" }) });
    }
    const toggles: Command[] = [
      { id: "view", group: "Toggle", label: view === "focus" ? "Switch to Kanban view" : "Switch to Focus view", hint: "f", run: () => setView(view === "focus" ? "kanban" : "focus") },
      { id: "theme", group: "Toggle", label: theme.dark ? "Light theme" : "Dark theme", run: theme.toggle },
      { id: "notify", group: "Toggle", label: notify.on ? "Mute notifications" : "Enable notifications", run: notify.toggle },
    ];
    const screens: Command[] = [
      { id: "projects", group: "Go to", label: "All projects", run: () => setScreen("projects") },
      { id: "memory", group: "Go to", label: "Memory", run: () => setScreen("memory") },
    ];
    const wsCmds: Command[] = workspaces
      .filter((w) => w.name !== ws)
      .map((w) => ({ id: `ws-${w.name}`, group: "Switch project", label: w.name, run: () => switchWs(w.name) }));
    return [...nav, ...toggles, ...screens, ...wsCmds];
  }, [view, theme.dark, notify.on, runnableCount, workspaces, ws]);

  // Board search (C5): filter what the Kanban shows without touching the header
  // synthesis, which always reflects the whole run.
  const queryTasks = boardQuery.trim()
    ? tasks.filter((t) => `${t.id} ${t.title} ${t.note ?? ""}`.toLowerCase().includes(boardQuery.trim().toLowerCase()))
    : tasks;
  // Removed tickets are hidden from the board (reversible) — kept out of every
  // column and the runnable count, restorable from the Removed section.
  const shownTasks = queryTasks.filter((t) => !hidden.ids.has(t.id));
  const runnable = tasks.filter((t) => RERUNNABLE.has(t.state) && !hidden.ids.has(t.id)).length;

  // The shared board: every backlog ticket, tagged by who owns it and its state.
  // AI drafts (not yet a live task) show in Up next; manual tickets are the dev's
  // own, placed by their status; a live run task masks its draft so it isn't shown
  // twice (only a still-active task — a merged one must not mask a fresh reuse).
  const runIds = new Set(tasks.filter((t) => t.state !== "DONE").map((t) => t.id));
  const boardTickets: BoardTicket[] = backlog.tickets.map((t) => ({
    file: t.file, content: t.content,
    id: parseTicketDeps(t.content).id, title: ticketTitle(t.content),
    assignee: fmGet(t.content, "assignee") === "human" ? "human" : "ai",
    status: fmGet(t.content, "status") || "todo",
    hold: fmGet(t.content, "hold") === "true",
  }));
  const pending = boardTickets.filter((t) => t.assignee === "ai" && !runIds.has(t.id) && !hidden.ids.has(t.id));
  const manual = boardTickets.filter((t) => t.assignee === "human" && !hidden.ids.has(t.id));
  // Everything the operator removed, for the Removed section (run tasks first,
  // then backlog-only tickets with no live task of the same id).
  const removed = [
    ...tasks.filter((t) => hidden.ids.has(t.id)).map((t) => ({ id: t.id, title: t.title })),
    ...boardTickets.filter((bt) => hidden.ids.has(bt.id) && !tasks.some((t) => t.id === bt.id))
      .map((bt) => ({ id: bt.id, title: bt.title })),
  ];
  // Remove = reversible board hide. For an AI draft, also hold it so a run skips
  // it; restore clears the hold. Run history and files are never touched.
  const setHoldSilent = (bt: BoardTicket, on: boolean): Promise<unknown> =>
    postJSON(`/api/backlog/${encodeURIComponent(bt.file)}`, { content: fmSet(bt.content, "hold", on ? "true" : "") });
  const removeTicket = async (bt: BoardTicket): Promise<void> => {
    await hidden.hide(bt.id);
    if (bt.assignee === "ai") { try { await setHoldSilent(bt, true); backlog.refresh(); } catch { /* hidden anyway */ } }
    toast(`${bt.id} removed — restore it from “Removed”.`);
  };
  const removeTask = async (id: string): Promise<void> => {
    await hidden.hide(id);
    const bt = boardTickets.find((b) => b.id === id);
    if (bt?.assignee === "ai") { try { await setHoldSilent(bt, true); backlog.refresh(); } catch { /* ok */ } }
    toast(`${id} removed — restore it from “Removed”.`);
  };
  const restoreTicket = async (id: string): Promise<void> => {
    await hidden.unhide(id);
    const bt = boardTickets.find((b) => b.id === id);
    if (bt?.assignee === "ai" && bt.hold) { try { await setHoldSilent(bt, false); backlog.refresh(); } catch { /* ok */ } }
    toast(`${id} restored.`);
  };
  const patchTicket = async (bt: BoardTicket, content: string, note: string): Promise<void> => {
    try {
      await postJSON(`/api/backlog/${encodeURIComponent(bt.file)}`, { content });
      toast(note); backlog.refresh();
    } catch (err) { toast(String(err), true); }
  };
  // A manual ticket dropped in a column takes that column's human status.
  const moveManual = (bt: BoardTicket, status: string): Promise<void> =>
    patchTicket(bt, fmSet(bt.content, "status", status), `${bt.id} moved to ${status}.`);
  // Hand a ticket to the dev (AI leaves it alone) or back to the AI.
  const setAssignee = (bt: BoardTicket, toHuman: boolean): Promise<void> =>
    patchTicket(bt, fmSet(fmSet(bt.content, "assignee", toHuman ? "human" : ""), "status", toHuman ? "todo" : ""),
      toHuman ? `${bt.id} is yours now — the AI won't touch it.` : `${bt.id} handed to the AI.`);
  // Pause / resume an AI draft (skipped by a run while held).
  const setHold = (bt: BoardTicket, on: boolean): Promise<void> =>
    patchTicket(bt, fmSet(bt.content, "hold", on ? "true" : ""),
      on ? `${bt.id} on hold — a run will skip it.` : `${bt.id} back in the queue.`);
  // Close the loop: hand a reviewed manual ticket to the AI to APPLY the fixes —
  // append the reviewer's notes to the ticket body as instructions, flip it back
  // to AI, and drop its manual status so it re-enters the pipeline as a draft.
  const handToAiWithFeedback = async (file: string, review: string): Promise<void> => {
    const bt = boardTickets.find((t) => t.file === file);
    if (!bt) { toast("Ticket not found.", true); return; }
    const body = `${bt.content.replace(/\s*$/, "")}\n\n## Reviewer feedback (address this)\n${review.trim()}\n`;
    const content = fmSet(fmSet(body, "assignee", ""), "status", "");
    try {
      await postJSON(`/api/backlog/${encodeURIComponent(file)}`, { content });
      toast(`${bt.id} handed to the AI with the review notes — start a run to apply them.`);
      backlog.refresh();
      setModal(null);
    } catch (err) { toast(String(err), true); }
  };
  // How many tickets a run would launch now: re-runnable run tasks, or — before any
  // run exists — the drafted backlog waiting in Up next (held ones won't run).
  // Drives the board's own "Start run" without reopening the New-work modal.
  const willRun = runnable || pending.filter((p) => !p.hold).length;

  // Row-2 header data: segmented progress + usage/budget.
  const spent = model.spentUsd || tasks.reduce((s, t) => s + t.costUsd, 0);
  const tokens = tasks.reduce((s, t) => s + t.tokens, 0);
  const budgetPct = model.budgetUsd ? Math.min(100, (spent / model.budgetUsd) * 100) : 0;
  const budgetColor = budgetPct >= 90 ? "var(--st-failed-dot)" : budgetPct >= 70 ? "var(--st-merging-dot)" : "var(--st-merged-dot)";
  const total = tasks.length || 1;
  const segs = [
    { label: "Merged", n: done.length, color: "var(--st-merged-dot)" },
    { label: "Working", n: working.length, color: "var(--st-working-dot)" },
    { label: "Needs you", n: attention.length, color: "var(--st-failed-dot)" },
    { label: "Up next", n: queued.length, color: "var(--st-upnext-dot)" },
  ].filter((s) => s.n > 0);
  const synthFam = TONE_FAM[head.tone] ?? "working";

  if (screen === "projects") {
    return (
      <>
        <ProjectsScreen theme={theme} onOpen={openProject} onMemory={() => setScreen("memory")} />
        <Toaster />
      </>
    );
  }
  if (screen === "memory") {
    return (
      <>
        <MemoryScreen ws={ws} tasks={tasks} theme={theme} onProjects={() => setScreen("projects")} />
        <Toaster />
      </>
    );
  }

  return (
    <div className="cockpit-shell">
      <div className={`cockpit-main${railOpen ? " with-rail" : ""}`}>
      {!connected && (
        <div className="conn-banner" role="status">
          <span className="conn-dot" aria-hidden="true" /> Connection lost — is the dashboard server still running? Reconnecting…
        </div>
      )}
      <header className="cockpit-head">
        <div className="cockpit-row1">
          <div className="brand">
            <button className="brand-logo" title="All projects" onClick={() => setScreen("projects")}><i /></button>
            <div className="brand-txt">
              <span className="brand-name">Agent Factory</span>
              <span className="brand-sub">Local execution</span>
            </div>
          </div>
          <button className="hbtn" title="All projects" onClick={() => setScreen("projects")}>‹ Projects</button>
          {workspaces.length > 0 && (
            <div className="proj-select">
              <span className="sq" />
              <select value={ws} onChange={(e) => { setWs(e.target.value); setWsState(e.target.value); }}>
                {workspaces.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
            </div>
          )}
          <div className="spacer" />
          <button className={`mode-badge mode-${model.mode}`} onClick={() => setModal({ type: "settings" })}
            title={model.mode === "api" ? "API mode — real dollars billed. Click to change." : "Subscription mode — draws from your plan, no real charge. Click to change."}>
            {model.mode === "api" ? <><Key size={13} /> API</> : <><InfinityIcon size={14} /> Subscription</>}
          </button>
          <button className="hbtn cmdk-trigger" onClick={() => setModal({ type: "cmdk" })} title="Command palette">
            <span className="cmdk-keys"><Command size={13} />K</span>
          </button>
          <button className={`hbtn icon-btn${notify.on ? " on" : ""}`} onClick={notify.toggle}
            title={notify.on ? "Notifications on — click to mute" : "Notify me when a task needs me or a run ends"}>
            {notify.on ? <Bell size={16} /> : <BellOff size={16} />}
          </button>
          <AppearanceButton onOpen={() => setModal({ type: "appearance" })} />
          <button className="hbtn" onClick={() => setModal({ type: "settings" })}>Settings</button>
          <button className="hbtn" title="Global lessons across every project" onClick={() => setScreen("memory")}>Memory</button>
          <button className="hbtn" onClick={() => setRailOpen(true)}>Supervisor</button>
          <button className="hbtn accent" onClick={() => setModal({ type: "newwork" })}><span className="plus">+</span> New work</button>
        </div>

        <div className="cockpit-row2">
          <div className="synth-block">
            <div className={`synth-line tone-${head.tone}`}>
              <span className="dot" aria-hidden="true" style={{ background: `var(--st-${synthFam}-dot)`, boxShadow: `0 0 0 4px var(--st-${synthFam}-bg)` }} />
              <span className="synth-text">{head.text}</span>
              {model.startedTs && <span className="synth-upd">· started {ago(model.startedTs)}</span>}
            </div>
            <div className="synth-bar">
              {segs.map((s) => <div key={s.label} style={{ width: `${(s.n / total) * 100}%`, background: s.color }} title={s.label} />)}
            </div>
            <div className="synth-legend">
              {segs.map((s) => (
                <span key={s.label} className="leg">
                  <span className="sq" style={{ background: s.color }} />{s.label} <span className="n">{s.n}</span>
                </span>
              ))}
            </div>
            {model.endedTs && <ShippedChips merged={tasks.filter((t) => t.state === "DONE")}
              onMore={() => setModal({ type: "shipped" })} />}
          </div>

          <UsageCard mode={model.mode} tokens={tokens} spent={spent} budgetUsd={model.budgetUsd}
            budgetPct={budgetPct} budgetColor={budgetColor} onAnalytics={() => setModal({ type: "analytics" })} />

          <div className="transport">
            <div className="transport-row">
              {live ? (
                <>
                  {(model.manualPause || model.ratePause)
                    ? <Button kind="hbtn" autoPending onClick={() => sendControl("resume")}><Play size={14} /> Resume</Button>
                    : <Button kind="hbtn" autoPending onClick={() => sendControl("pause")}><Pause size={14} /> Pause</Button>}
                  <ConfirmButton label={<><Square size={13} /> Stop all</>} confirm="Sure? Click again" plain className="hbtn" onConfirm={() => void sendControl("stop")} />
                </>
              ) : willRun > 0 ? (
                <button className="hbtn accent" onClick={() => setModal({ type: "runguard" })}>
                  <Play size={14} /> {model.run ? "Run again" : "Start run"} ({willRun})
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <SyncNote sync={model.sync} />
      <IntegrationBanner integ={model.integration} />

      <div className="board-filter">
        {tasks.length > 6 && (
          <>
            <input className="input" placeholder="Filter tickets by id, title or note…"
              value={boardQuery} onChange={(e) => setBoardQuery(e.target.value)} />
            {boardQuery.trim() && (
              <span className="board-filter-n">{shownTasks.length} of {tasks.length}
                <button className="btn link" onClick={() => setBoardQuery("")}>clear</button>
              </span>
            )}
          </>
        )}
        <div className="board-tools">
          <button className="board-tool" onClick={() => setModal({ type: "preview" })}>View result</button>
          <button className="board-tool" title="Run, build, verify and install this project — whatever its stack" onClick={() => setModal({ type: "cockpit" })}>Cockpit</button>
          <button className="board-tool" onClick={() => setModal({ type: "repo" })}>Repo</button>
          {hasDeps && (
            <button className="board-tool" title="Ticket dependency graph" onClick={() => setModal({ type: "depgraph" })}>Deps</button>
          )}
          <button className="board-tool" title="This project's docs your agents can read" onClick={() => setModal({ type: "docs" })}>Knowledge</button>
          {removed.length > 0 && (
            <button className="board-tool" title="Tickets you removed from the board — restore them here" onClick={() => setModal({ type: "removed" })}>Removed ({removed.length})</button>
          )}
          {(tasks.length > 0 || pending.length > 0 || manual.length > 0) && (
            <div className="nav-pills">
              <button className={`nav-pill${view === "kanban" ? " on" : ""}`} onClick={() => setView("kanban")}>Kanban</button>
              <button className={`nav-pill${view === "focus" ? " on" : ""}`} onClick={() => setView("focus")}>Focus</button>
            </div>
          )}
        </div>
      </div>
      {tasks.length === 0 && pending.length === 0 && manual.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-art" aria-hidden="true"><Sparkles size={28} /></div>
          <p className="empty-state-lead">Let's get some work going.</p>
          <p className="empty-state-sub">Add a ticket to do yourself or hand to the AI — or describe a goal and let it draft the plan for you.</p>
          <div className="empty-state-actions">
            <button className="btn primary" onClick={() => setModal({ type: "newwork", tab: "one" })}><Plus size={14} /> Add a ticket</button>
            <button className="btn ghost" onClick={() => setModal({ type: "newwork", tab: "goal" })}><Sparkles size={14} /> Draft several with AI</button>
          </div>
        </div>
      ) : (
        <Kanban tasks={shownTasks} live={live} now={now} onLog={openLog}
          onAnswer={openAnswer} onLesson={openLesson} onDiff={openDiff} focus={view === "focus"}
          pending={pending} manual={manual} onAddTicket={() => setModal({ type: "newwork", tab: "one" })}
          onEditTicket={(bt) => setModal({ type: "editticket", ticket: bt })}
          onRemoveTicket={removeTicket} onRemoveTask={removeTask}
          onMoveManual={moveManual} onSetAssignee={setAssignee} onSetHold={setHold}
          onReviewManual={(bt) => setModal({ type: "aireview", file: bt.file, title: bt.title })} />
      )}

      {modal?.type === "settings" && <SettingsModal onClose={() => setModal(null)} />}
      {modal?.type === "newwork" && <NewWorkModal onClose={() => setModal(null)} onWorkspaceAdded={loadWorkspaces} onBacklogChange={backlog.refresh} takenIds={tasks.map((t) => t.id)} initialTab={modal.tab ?? "one"} />}
      {modal?.type === "editticket" && (
        <EditTicketModal ticket={modal.ticket} onClose={() => setModal(null)}
          onSave={(content) => patchTicket(modal.ticket, content, `Ticket ${modal.ticket.id} updated.`)} />
      )}
      {modal?.type === "repo" && <RepoModal onClose={() => setModal(null)} />}
      {modal?.type === "preview" && <PreviewModal onClose={() => setModal(null)} onFiles={() => setModal({ type: "repo" })} />}
      {modal?.type === "cockpit" && <CockpitModal onClose={() => setModal(null)} />}
      {modal?.type === "removed" && (
        <RemovedModal removed={removed} onRestore={restoreTicket} onClose={() => setModal(null)} />
      )}
      {modal?.type === "appearance" && (
        <AppearanceModal theme={theme} onClose={() => setModal(null)} />
      )}
      {modal?.type === "runguard" && (
        <RunGuardModal runnable={willRun} budgetUsd={model.budgetUsd}
          avgCost={done.length > 0 && spent > 0 ? spent / done.length : null}
          onClose={() => setModal(null)}
          onConfirm={async () => { await quickRun(); setModal(null); }}
          onSettings={() => setModal({ type: "settings" })} />
      )}
      {modal?.type === "diff" && (
        <DiffModal taskId={modal.taskId} title={modal.title} diff={modal.diff}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "review" && model.tasks.get(modal.taskId)?.diff && (
        <ReviewModal task={model.tasks.get(modal.taskId)!} onClose={() => setModal(null)} />
      )}
      {modal?.type === "analytics" && <AnalyticsModal onClose={() => setModal(null)} />}
      {modal?.type === "shipped" && (
        <ShippedModal merged={tasks.filter((t) => t.state === "DONE")} onOpenLog={openLog} onClose={() => setModal(null)} />
      )}
      {modal?.type === "docs" && <DocsModal onClose={() => setModal(null)} />}
      {modal?.type === "aireview" && <AiReviewModal file={modal.file} title={modal.title} onClose={() => setModal(null)}
        onSendToAi={(review) => handToAiWithFeedback(modal.file, review)} />}
      {modal?.type === "cmdk" && <CommandPalette commands={commands} onClose={() => setModal(null)} />}
      {modal?.type === "depgraph" && (
        <DepGraphModal stateOf={(id) => model.tasks.get(id)?.state} onClose={() => setModal(null)} />
      )}
      {modal?.type === "answer" && (
        <AnswerModal taskId={modal.taskId} title={modal.title} question={modal.question}
          context={modal.context} onClose={() => setModal(null)} />
      )}
      {modal?.type === "lesson" && (
        <FactEditor fact="new" draft={modal.draft} tasks={tasks}
          onClose={() => setModal(null)} onSaved={() => setModal(null)} />
      )}
      {modal?.type === "log" && (
        <LogModal taskId={modal.taskId} title={modal.title} ws={ws} live={live} now={now}
          getTask={() => model.tasks.get(modal.taskId)}
          onAnswer={() => {
            const t = model.tasks.get(modal.taskId);
            setModal({ type: "answer", taskId: modal.taskId, title: modal.title,
                       question: t?.note ?? "", context: t?.blockedContext ?? null });
          }}
          onDiff={() => {
            const t = model.tasks.get(modal.taskId);
            if (t?.diff) setModal({ type: "diff", taskId: modal.taskId, title: modal.title, diff: t.diff });
          }}
          onClose={() => setModal(null)} />
      )}
      <Toaster />
      </div>
      {railOpen
        ? <CompanionRail obs={companion.obs} feed={model.feed} onClose={() => setRailOpen(false)} now={now}
            currentRun={model.run} live={live}
            needsYou={tasks.filter((t) => t.state === "BLOCKED" || t.state === "FAILED" || t.state === "AWAITING_APPROVAL")}
            onAnswer={openAnswer} onReview={openDiff} />
        : <button className="companion-open" onClick={() => setRailOpen(true)} title="Open the supervisor"><MessageCircle size={18} /></button>}
    </div>
  );
}

function describe(event: FactoryEvent): string {
  const tag = event.task ? `[${event.task}] ` : "";
  const e = event as unknown as Record<string, unknown>;
  switch (event.event) {
    case "state": return `${tag}${e["from"]} → ${e["to"]}`;
    case "agent_result": return `${tag}agent ${e["status"]} (${e["turns"] ?? "?"} turns${e["cost_usd"] ? `, ${fmtUsd(e["cost_usd"] as number)}` : ""})`;
    case "verify": return `${tag}verify ${e["ok"] ? "ok" : "FAILED: " + (e["failures"] as string[]).join("; ")}`;
    case "retry": return `${tag}retry #${e["attempt"]}: ${e["reason"]}`;
    case "failure": return `${tag}failed: ${e["reason"]}`;
    case "blocked": return `${tag}blocked: ${e["question"]}`;
    case "answered": return `${tag}answered by the operator — back in the queue`;
    case "lessons": return `${tag}${e["count"]} lesson${e["count"] === 1 ? "" : "s"} recalled into the prompt`;
    case "review": return `${tag}review ${e["verdict"]}`;
    case "budget_exceeded": return `budget reached (${fmtUsd(e["spent_usd"] as number)} / ${fmtUsd(e["budget_usd"] as number)})`;
    case "paused_ratelimit": return `rate limit — pause #${e["pause_n"]}`;
    case "merged": return `${tag}merged into base`;
    case "run_start": return `run started (${e["slots"]} slots)`;
    case "run_end": return `run ${e["stopped"] ? "stopped" : "finished"}`;
    default: return `${tag}${event.event}`;
  }
}

/* --------------------------------- Log modal (live) --------------------------------- */

/** Icon + label for each kind of story step, shown as a timeline node. */
const STORY_NODE: Record<StoryItem["kind"], { Icon: LucideIcon; kind: string }> = {
  say: { Icon: Lightbulb, kind: "Thinking" },
  act: { Icon: ChevronRight, kind: "Action" },
  subresult: { Icon: CornerDownRight, kind: "Sub-agent result" },
  delegate: { Icon: GitBranch, kind: "Delegated" },
  final: { Icon: Check, kind: "Result" },
};

function StoryView({ story }: { story: StoryItem[] }): JSX.Element {
  if (!story.length) return <p className="story-say">No activity recorded yet.</p>;
  return (
    <div className="tl">
      {story.map((s, i) => {
        const n = STORY_NODE[s.kind];
        const text = s.kind === "delegate"
          ? `Delegated to ${s.who}${s.mission ? ` — ${s.mission}` : ""}`
          : s.text;
        return (
          <div key={i} className="tl-node">
            <span className="tl-glyph"><n.Icon size={13} /></span>
            <div className="tl-kind">{n.kind}</div>
            <div className="tl-text">{text}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Measures row for the history modal: timer · cost · tokens · attempt. */
function ModalMeasures({ t, now }: { t: TaskModel; now: number }): JSX.Element {
  const running = t.state === "RUNNING" && t.runningSince !== null;
  return (
    <div className="log-meas mono">
      <span><Timer size={13} /> {running ? fmtDuration((now - t.runningSince!) / 1000) : t.wallS !== null ? fmtDuration(t.wallS) : "—"}</span>
      {t.costUsd > 0 && <span>{fmtUsd(t.costUsd)}</span>}
      {t.tokens > 0 && <span>{fmtTokens(t.tokens)} tokens</span>}
      <span className="faint">attempt {t.retries + 1}</span>
    </div>
  );
}

function LogModal(
  { taskId, title, ws, live, getTask, now, onAnswer, onDiff, onClose }:
  { taskId: string; title: string; ws: string; live: boolean;
    getTask: () => TaskModel | undefined; now: number; onAnswer: () => void; onDiff: () => void; onClose: () => void },
): JSX.Element {
  const [raw, setRaw] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [addLesson, setAddLesson] = useState(false);
  const [reqChanges, setReqChanges] = useState(false);
  const [feedback, setFeedback] = useState("");
  const t = getTask();
  const { facts, reload } = useFacts(ws);
  const taskFacts = (facts ?? []).filter((f) => f.ticketId === taskId);
  const attention = t?.state === "FAILED" || t?.state === "BLOCKED";
  const [following, setFollowing] = useState(inFlight(t?.state));
  const bodyRef = useRef<HTMLDivElement>(null);
  useEsc(() => { if (addLesson) setAddLesson(false); else onClose(); });

  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      const text = await getText(`/api/log?task=${encodeURIComponent(taskId)}`);
      if (!alive) return;
      if (text !== null) setRaw(text);
      if (!inFlight(getTask()?.state)) setFollowing(false);
    };
    void refresh();
    if (!inFlight(getTask()?.state)) return;
    const id = setInterval(refresh, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [taskId]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [raw]);

  const story = useMemo(() => (raw ? narrate(raw) : []), [raw]);
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel">
        <div className="log-head">
          <div className="log-head-top">
            <span className="kcard-id">{t?.id ?? taskId}</span>
            {t && <StatusPill state={t.state} live={t.state === "RUNNING"} />}
            {following && <span className="live-tag"><span className="live-dot" />live</span>}
            <button className="btn icon" onClick={onClose}><X size={15} /></button>
          </div>
          <div className="log-title">{title}</div>
          {t && <ModalMeasures t={t} now={now} />}
        </div>
        <div className="panel-body log-body" ref={bodyRef}>
          {raw === null ? <Skeleton lines={4} />
            : rawMode ? <pre className="log-pre">{raw}</pre>
            : <StoryView story={story} />}

          <section className="log-lessons">
            <div className="log-lessons-head">
              <h4>Learned from this task</h4>
              <button className="btn link" onClick={() => setAddLesson(true)}>+ Add a lesson</button>
            </div>
            {taskFacts.length === 0
              ? <p className="log-lessons-empty">No lesson recorded yet. Capture what went wrong so the next agent avoids it.</p>
              : <div className="fact-list">{taskFacts.map((f) => (
                  <div key={f.id} className="fact-card">
                    <div className="fact-text">{f.text}</div>
                    <div className="fact-foot">
                      <span className={`pill fam-${f.scope === "global" ? "working" : "upnext"}`}>
                        {f.scope === "global" ? "Global" : "This project"}
                      </span>
                      {f.applied ? <span className="fact-used">used {f.applied}×</span> : null}
                      <span className="fact-when">{ago(f.createdTs)}</span>
                    </div>
                  </div>
                ))}</div>}
          </section>
        </div>
        {t?.state === "AWAITING_APPROVAL" && reqChanges && (
          <div className="approval-changes">
            <label htmlFor="changes-text">What needs to change? The agent will restart with this note.</label>
            <textarea id="changes-text" autoFocus value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g. the validation is wrong, also handle the empty case…" />
          </div>
        )}
        <div className="panel-foot spread">
          <div className="log-actions">
            {t?.state === "BLOCKED" && live && (
              <button className="btn primary" onClick={onAnswer}>Answer</button>
            )}
            {t?.state === "AWAITING_APPROVAL" && !reqChanges && (
              <>
                <button className="btn primary"
                  onClick={() => { void sendControl("approve", taskId); onClose(); }}>
                  Approve and merge
                </button>
                <button className="btn danger" onClick={() => setReqChanges(true)}>
                  Request changes
                </button>
                {t.diff && <button className="btn ghost" onClick={onDiff}>View diff</button>}
              </>
            )}
            {t?.state === "AWAITING_APPROVAL" && reqChanges && (
              <>
                <button className="btn primary" disabled={!feedback.trim()}
                  onClick={() => { void sendControl("changes", taskId, feedback.trim()); onClose(); }}>
                  Send back to the agent
                </button>
                <button className="btn ghost" onClick={() => { setReqChanges(false); setFeedback(""); }}>
                  Cancel
                </button>
              </>
            )}
            {attention && !(t?.state === "BLOCKED" && live) && (live
              ? <button className="btn primary" onClick={() => void sendControl("retry", taskId)}>Try again</button>
              : <button className="btn primary" onClick={() => void quickRun()}>Run again</button>)}
            {t?.state === "RUNNING" && live && (
              <button className="btn danger" onClick={() => void sendControl("kill", taskId)}>Stop</button>
            )}
            {t?.state === "DONE" && t.diff && (
              <button className="btn ghost" onClick={onDiff}>View diff</button>
            )}
          </div>
          <button className="btn link" onClick={() => setRawMode((v) => !v)}>
            {rawMode ? "Show as story" : "Show raw log"}
          </button>
        </div>
      </div>
      {addLesson && (
        <FactEditor fact="new" tasks={t ? [t] : []}
          draft={{ text: attention && t?.note ? `${t.note}\n\nLesson: ` : "", ticketId: taskId }}
          onClose={() => setAddLesson(false)}
          onSaved={() => { setAddLesson(false); reload(); }} />
      )}
    </div>
  );
}

/* --------------------------------- Settings modal --------------------------------- */

interface DockerStatus {
  engine: boolean; image: boolean; proxy: boolean; ready: boolean;
  detail?: string; building?: boolean; buildOk?: boolean | null; buildLog?: string;
}

/** Direct/Sandbox toggle with a live Docker preflight + one-click image build.
 *  Polls /api/docker only while Sandbox is selected, so a Direct project pays nothing. */
function SandboxControl({ value, onChange }: {
  value: "direct" | "sandbox"; onChange: (v: "direct" | "sandbox") => void;
}): JSX.Element {
  const [st, setSt] = useState<DockerStatus | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (value !== "sandbox") { setSt(null); setErr(false); return; }
    let alive = true;
    const tick = (): void => {
      void fetchJSON<DockerStatus>("/api/docker")
        .then((s) => { if (alive) { setSt(s); setErr(false); } })
        .catch(() => { if (alive) setErr(true); });
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [value]);

  const build = async (): Promise<void> => {
    try { await postJSON("/api/docker/build", {}); toast("Building the sandbox image — runs once (~1–3 min)."); }
    catch (err) { toast(String(err), true); }
  };
  const dot = (ok: boolean) => <span className={`sbx-dot ${ok ? "on" : "off"}`} aria-hidden="true" />;

  return (
    <div className="sbx-control">
      <div className="seg">
        <button className={value !== "sandbox" ? "on" : ""} onClick={() => onChange("direct")}><Laptop size={14} /> Direct</button>
        <button className={value === "sandbox" ? "on" : ""} onClick={() => onChange("sandbox")}><Lock size={14} /> Sandbox</button>
      </div>
      {value === "sandbox" && (
        <div className="sbx-status">
          {!st && err ? (
            <span className="sbx-hint">Couldn't reach the dashboard server to check Docker — is it still running? Retrying…</span>
          ) : !st ? (
            <span className="sbx-line">checking Docker…</span>
          ) : (
            <>
              <span className="sbx-line">{dot(st.engine)} Docker engine {st.engine ? "ready" : "off"}</span>
              <span className="sbx-line">{dot(st.image)} Sandbox image {st.image ? "built" : "missing"}</span>
              {st.engine && st.image ? (
                <span className="sbx-ready"><Check size={13} /> Confined runs ready — only the worktree is visible, egress limited to Anthropic. The proxy auto-starts on your first run.</span>
              ) : st.building ? (
                <span className="sbx-line">building image… {st.buildLog?.split("\n").filter(Boolean).slice(-1)[0] ?? ""}</span>
              ) : !st.engine ? (
                <span className="sbx-hint">{st.detail || "Start Docker Desktop — this refreshes automatically."}</span>
              ) : (
                <button className="btn ghost sm" onClick={() => void build()}>Build sandbox image</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Hoisted OUT of SettingsModal on purpose: a component defined inside a render
// gets a fresh identity every render, so React remounts its subtree — which wipes
// the native <details> open state, snapping expanded sections shut on any re-render
// (a config poll, a field toggle). Module-scope keeps the identity stable.
function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }): JSX.Element {
  return (
    <div className="setting-row">
      <div className="setting-text"><div className="setting-label">{label}</div><div className="setting-hint">{hint}</div></div>
      {children}
    </div>
  );
}

// A folded "advanced" card: title + a live one-line summary of its current values,
// so nothing is hidden — you scan your config, expand only what you want to change.
function Fold({ title, summary, children }: { title: string; summary: string; children: ReactNode }): JSX.Element {
  return (
    <details className="settings-fold">
      <summary className="settings-fold-head">
        <span className="settings-fold-title">{title}</span>
        <span className="settings-fold-summary">{summary}</span>
        <ChevronDown size={16} className="settings-fold-chev" />
      </summary>
      <div className="settings-fold-body">{children}</div>
    </details>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const pollDoctor = useManagedInterval();
  const set = (patch: Partial<Settings>) => setS((cur) => cur ? { ...cur, ...patch } : cur);

  useEffect(() => {
    void fetchJSON<{ content: string }>("/api/config").then(({ content }) => setS(parseSettings(content)));
    // The repo is a project property, persisted server-side — not in factory.yaml.
    void fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces").then(({ workspaces }) => {
      const active = workspaces.find((w) => w.name === getWs()) ?? workspaces[0];
      setRepo(active?.repo ?? "");
    }).catch(() => { /* leave blank */ });
  }, []);

  const saveRepoPath = async (): Promise<void> => {
    try { await postJSON("/api/repo/path", { path: repo.trim() }); }
    catch (err) { toast(String(err), true); }
  };

  const save = async (): Promise<void> => {
    if (!s) return;
    // The config endpoint writes on PUT (POST is unrouted → 404). fetchJSON scopes
    // the call to the active workspace, so the right project's factory.yaml is saved.
    await fetchJSON("/api/config", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: generateConfig(s) }),
    });
  };
  const doTest = async (): Promise<void> => {
    try { await save(); await postJSON("/api/doctor", {}); } catch (err) { toast(String(err), true); return; }
    setTesting(true); setTestOut("Testing for real — one tiny agent tries the web and your commands (~30s)…");
    pollDoctor((stop) => {
      void (async () => {
        const st = await fetchJSON<{ doctor: { state: string; output: string } }>("/api/status");
        if (st.doctor.state === "running") return;
        stop(); setTesting(false);
        setTestOut(st.doctor.output.trim() || (st.doctor.state === "error" ? "The check failed — see server logs." : "(no result)"));
      })();
    }, 2000);
  };

  if (!s) return <Drawer title="Settings" onClose={onClose}><div className="panel-body"><Skeleton lines={8} /></div></Drawer>;

  const repoName = repo.trim() ? (repo.trim().split(/[\\/]/).filter(Boolean).pop() ?? repo.trim()) : "not set";
  const foldSummary = {
    models: `plan: ${s.planModel || "same"} · effort: ${s.effort || "auto"} · reviewer: ${s.reviewer ? "on" : "off"} · web: ${s.internet ? "on" : "off"}`,
    project: `${repoName} · ${s.setupCommands || "no setup step"}`,
    safety: `${s.executionMode === "api" ? "API (real $)" : "Subscription"} · ${s.isolation === "sandbox" ? "Sandbox" : "Direct"} · ${s.prNative ? "opens a PR" : "merges locally"} · ${s.maxRetries} retr${s.maxRetries === 1 ? "y" : "ies"}`,
    notify: s.webhookUrl ? "on" : "off",
  };
  const effortChoices = [...EFFORT_CHOICES];
  if (s.effort && !effortChoices.some(([v]) => v === s.effort)) effortChoices.push([s.effort, `${s.effort} (expensive)`]);
  const planChoices: Array<[string, string]> = [["", "Same as coders"], ["haiku", "Haiku (cheapest)"], ["sonnet", "Sonnet"]];
  if (s.planModel && !planChoices.some(([v]) => v === s.planModel)) planChoices.push([s.planModel, s.planModel]);
  const modelChoices = [...MODEL_CHOICES];
  if (s.model && !modelChoices.some(([v]) => v === s.model)) modelChoices.push([s.model, s.model]);

  return (
    <Drawer title="Settings" onClose={onClose} foot={
      <>
        <button className="btn ghost" disabled={testing} onClick={() => void doTest()}><FlaskConical size={14} /> Test these settings</button>
        <button className="btn primary" onClick={async () => {
          try { await save(); toast("Saved. Your next run uses these settings."); onClose(); }
          catch (err) { toast(String(err), true); }
        }}>Save</button>
      </>
    }>
      <div className="panel-body settings-form">
        <p className="settings-intro">Sensible defaults are already set — you can run without changing a thing. Tweak these only if you want to.</p>

        {/* Essentials — the few things you might reasonably want to set, always visible. */}
        <div className="settings-essentials">
          <Row label="Project type" hint="Picks the matching build tools and the default dependency install.">
            <div className="chip-choice">
              {(["node", "python", "other"] as const).map((v) => (
                <button key={v} className={`btn choice${s.project === v ? " on" : ""}`}
                  onClick={() => set({ project: v, setupCommands: v === "node" ? "npm install" : v === "python" ? "uv sync" : "" })}>
                  {v === "node" ? "Node / JS" : v === "python" ? "Python" : "Other"}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Coding model" hint="The model every coding agent uses. A ticket can still pin its own.">
            <select className="picker" value={s.model} onChange={(e) => set({ model: e.target.value })}>
              {modelChoices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
          <Row label="Parallel agents" hint="How many agents work at once. 2 is a calm default on a subscription plan.">
            <input type="number" min="1" className="input num" value={s.slots} onChange={(e) => set({ slots: Math.max(1, Number(e.target.value) || 2) })} />
          </Row>
          <Row label="Review before merge" hint="Approve every change yourself. Finished work waits in “To review” instead of merging on its own.">
            <input type="checkbox" className="switch" checked={s.manualApproval} onChange={(e) => set({ manualApproval: e.target.checked })} />
          </Row>
          <Row label="Run budget (USD)" hint="Stop launching new agents once estimated spend crosses this. Empty = no cap.">
            <input type="number" min="0" step="0.5" className="input num" placeholder="none" value={s.budgetUsd} onChange={(e) => set({ budgetUsd: e.target.value.trim() })} />
          </Row>
        </div>

        <div className="settings-advanced-label">Advanced — the defaults below are safe</div>

        <Fold title="Models & thinking" summary={foldSummary.models}>
          <Row label="Planning model" hint="The ticket-maker explores the repo once and saves a reusable map. A cheaper tier here cuts planning cost. Default matches the coding model.">
            <select className="picker" value={s.planModel} onChange={(e) => set({ planModel: e.target.value })}>
              {planChoices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
          <Row label="Reasoning effort" hint="How hard each agent thinks. Higher digs deeper but is slower and costs more. Default lets the agent decide.">
            <select className="picker" value={s.effort} onChange={(e) => set({ effort: e.target.value })}>
              {effortChoices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
          <Row label="Code reviewer" hint="A second AI double-checks every change before merge: scope, gamed tests, obvious bugs.">
            <input type="checkbox" className="switch" checked={s.reviewer} onChange={(e) => set({ reviewer: e.target.checked })} />
          </Row>
          <Row label="Internet access" hint="Agents may search and read the web. Needed for research; adds exposure to web content.">
            <input type="checkbox" className="switch" checked={s.internet} onChange={(e) => set({ internet: e.target.checked })} />
          </Row>
        </Fold>

        <Fold title="Project & repository" summary={foldSummary.project}>
          <Row label="Repository path" hint="The git repo your agents work in. New tickets default to it and the planner explores it. Set once per project.">
            <input className="input" placeholder="C:\\path\\to\\your\\repo" value={repo}
              onChange={(e) => setRepo(e.target.value)} onBlur={() => void saveRepoPath()} />
          </Row>
          <Row label="GitHub" hint="Turn this folder into a git repo, publish it, or flip its visibility. Needs git and the gh CLI logged in.">
            <RepoTools repo={repo} />
          </Row>
          <Row label="Install dependencies" hint="Run in every agent's fresh copy of the repo, before work starts. Comma-separated.">
            <input className="input" value={s.setupCommands} placeholder="npm install" onChange={(e) => set({ setupCommands: e.target.value })} />
          </Row>
          <Row label="Integration check" hint="After every ticket merges, run this suite once to prove the merged changes still hold together. Empty = off. Comma-separated.">
            <input className="input" value={s.integrationCommands} placeholder="npm run build, npm test" onChange={(e) => set({ integrationCommands: e.target.value })} />
          </Row>
        </Fold>

        <Fold title="Execution & safety" summary={foldSummary.safety}>
          <Row label="Execution mode" hint="Subscription draws from your Claude plan (no real charge; the cost shown is an estimate). API uses the key in your environment and bills real dollars. The key is never stored — only whether to pass it to the agent.">
            <div className="seg">
              <button className={s.executionMode !== "api" ? "on" : ""} onClick={() => set({ executionMode: "subscription" })}><InfinityIcon size={14} /> Subscription</button>
              <button className={s.executionMode === "api" ? "on" : ""} onClick={() => set({ executionMode: "api" })}><Key size={14} /> API</button>
            </div>
          </Row>
          <Row label="Sandboxing" hint="Direct runs agents as normal processes — fast, full access to your machine (the default). Sandbox boxes each agent in a hardened container: only its own copy of the repo is visible, network limited to Anthropic, privileges dropped. For untrusted work or a client demo.">
            <SandboxControl value={s.isolation} onChange={(v) => set({ isolation: v })} />
          </Row>
          <Row label="Open a pull request" hint="Instead of merging locally, push each verified ticket and open a GitHub PR — review and merge on GitHub. Needs a connected GitHub repo.">
            <input type="checkbox" className="switch" checked={s.prNative} onChange={(e) => set({ prNative: e.target.checked })} />
          </Row>
          <Row label="Retries per task" hint="How many times a failing ticket is re-attempted. Each retry is a full agent run — keep low for costly tasks.">
            <input type="number" min="0" className="input num" value={s.maxRetries} onChange={(e) => set({ maxRetries: Math.max(0, Number(e.target.value) || 0) })} />
          </Row>
        </Fold>

        <Fold title="Notifications" summary={foldSummary.notify}>
          <Row label="Notify me" hint="Get pinged when a run finishes or a ticket needs you. Paste a Slack, Discord, or any incoming-webhook URL. Empty = off. Fires server-side, so it works with the browser closed.">
            <input className="input" type="url" value={s.webhookUrl} placeholder="https://hooks.slack.com/services/…" onChange={(e) => set({ webhookUrl: e.target.value })} />
          </Row>
        </Fold>

        {testOut !== null && <pre className="doctor-result">{testOut}</pre>}
      </div>
    </Drawer>
  );
}

/* --------------------------------- Knowledge (docs) modal --------------------------------- */

interface KnowledgeDoc {
  id: string; name: string; size: number; addedTs: string; chunks: number | null; error?: string;
}

function DocsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const r = await fetchJSON<{ enabled: boolean; docs: KnowledgeDoc[] }>("/api/knowledge");
    setEnabled(r.enabled); setDocs(r.docs);
  };
  useEffect(() => { void load(); }, []);

  const toggle = async (on: boolean): Promise<void> => {
    setEnabled(on); // optimistic
    try { await postJSON("/api/knowledge/enable", { enabled: on }); }
    catch (err) { setEnabled(!on); toast(String(err), true); }
  };
  const add = async (): Promise<void> => {
    if (!name.trim() || !content.trim()) { toast("Give the note a name and some content.", true); return; }
    setBusy(true);
    try {
      const r = await postJSON<{ ok: boolean; doc: KnowledgeDoc; error?: string }>("/api/knowledge", { name, content });
      if (!r.ok) throw new Error(r.doc?.error || r.error || "ingest failed");
      setName(""); setContent(""); await load();
      toast(`Added “${r.doc.name}” (${r.doc.chunks ?? 0} chunks). Agents can now search it.`);
    } catch (err) { toast(String(err), true); }
    finally { setBusy(false); }
  };
  const remove = async (d: KnowledgeDoc): Promise<void> => {
    setDocs((cur) => cur?.filter((x) => x.id !== d.id) ?? cur); // optimistic
    try { await fetchJSON(`/api/knowledge/${encodeURIComponent(d.id)}`, { method: "DELETE" }); await load(); }
    catch (err) { toast(String(err), true); void load(); }
  };
  const pickFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setContent(String(reader.result ?? "")); if (!name.trim()) setName(f.name); };
    reader.readAsText(f); // text/markdown notes; binary formats (PDF) aren't supported yet
  };

  return (
    <Drawer title="Knowledge base" onClose={onClose} foot={
      <button className="btn primary" disabled={busy || !name.trim() || !content.trim()} onClick={() => void add()}>
        {busy ? "Ingesting…" : "Add to knowledge"}
      </button>
    }>
      <div className="panel-body docs-form">
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">Give agents your docs</div>
            <div className="setting-hint">
              Company knowledge that isn’t in the code — business rules, domain notes, a Confluence export.
              Agents search it (locally, offline) while they work, so they honour the “why”, not just the code.
            </div>
          </div>
          <input type="checkbox" className="switch" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
        </div>
        {!enabled && <div className="docs-note">Turn this on to wire the knowledge base into your agents’ next run.</div>}

        <label className="docs-label">Name</label>
        <input className="input" value={name} placeholder="tva-belgique.md" onChange={(e) => setName(e.target.value)} />
        <label className="docs-label">Content
          <span className="docs-file"><input type="file" accept=".md,.txt,.csv,.json,text/*" onChange={pickFile} /> or pick a text file</span>
        </label>
        <textarea className="input docs-text" rows={7} value={content}
          placeholder="Paste a business rule, a domain note, a runbook…"
          onChange={(e) => setContent(e.target.value)} />

        <div className="docs-list">
          {docs === null && <Skeleton lines={3} />}
          {docs?.length === 0 && <div className="docs-empty">No documents yet. Add your first note above.</div>}
          {docs?.map((d) => (
            <div key={d.id} className="docs-item">
              <div className="docs-item-main">
                <div className="docs-item-name">{d.name}</div>
                <div className="docs-item-meta">
                  {d.error ? <span className="docs-err">ingest failed</span>
                    : <span>{d.chunks ?? 0} chunk{d.chunks === 1 ? "" : "s"}</span>}
                  <span> · {Math.max(1, Math.round(d.size / 1024))} KB</span>
                </div>
              </div>
              <button className="btn icon" aria-label={`Remove ${d.name}`} onClick={() => void remove(d)}><X size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  );
}

/* --------------------------------- Preview modal --------------------------------- */

function PreviewModal({ onClose, onFiles }: { onClose: () => void; onFiles: () => void }): JSX.Element {
  const [status, setStatus] = useState("Detecting the project…");
  const [out, setOut] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const opened = useRef(false);

  useEffect(() => {
    const repo = repoPath();
    if (!repo) { setStatus("Set a repository path in New work first."); return; }
    let alive = true, timer: ReturnType<typeof setInterval> | null = null;
    (async () => {
      let det: { kind: string };
      try { det = await fetchJSON(`/api/preview/detect?repo=${encodeURIComponent(repo)}`); }
      catch (err) { setStatus(String(err)); return; }
      if (det.kind === "none") { toast("Not a web project — opening the files instead."); onFiles(); return; }
      setStatus(det.kind === "web" ? "Booting the dev server… first start can take a moment." : "Serving the site…");
      try { await postJSON("/api/preview", { repo }); } catch (err) { setStatus(String(err)); return; }
      timer = setInterval(async () => {
        let p: { state: string; url: string | null; output: string };
        try { p = await fetchJSON("/api/preview"); } catch { return; }
        if (!alive) return;
        if (p.output.trim()) setOut(p.output.slice(-1500));
        if (p.state === "ready" && p.url) {
          setUrl(p.url); setStatus(`Ready — live at ${p.url}`);
          if (!opened.current) { opened.current = true; window.open(p.url, "_blank"); }
          if (timer) clearInterval(timer);
        } else if (p.state === "error") { setStatus("Could not start the preview — see output."); if (timer) clearInterval(timer); }
        else if (p.state === "idle") { setStatus("The preview server stopped."); if (timer) clearInterval(timer); }
      }, 1500);
    })();
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, []);

  return (
    <Modal title="Live preview" onClose={onClose}>
      <div className="preview-status">{status}</div>
      <div className="card-actions">
        {url && <>
          <button className="btn primary" onClick={() => window.open(url, "_blank")}><ExternalLink size={14} /> Open the site</button>
          <ConfirmButton label="Stop the preview server" confirm="Sure? Click again"
            onConfirm={async () => { try { await postJSON("/api/preview/stop", {}); toast("Preview server stopped."); } catch (err) { toast(String(err), true); } onClose(); }} />
        </>}
      </div>
      {out && <pre className="log-pre preview-out">{out}</pre>}
    </Modal>
  );
}

/* --------------------------------- Cockpit (capsule) ---------------------------------
 * A generic, app-agnostic project cockpit driven entirely by the project's capsule.
 * The factory renders a FIXED palette (doctor chips, action buttons, log-stream,
 * device-install, preview, consent cards); the capsule (data) decides what appears.
 * Nothing here knows "mobile" or any app type — mobile is just one capsule. */

/** Safe icon allow-list — the capsule references names, never emits UI code. */
function capsuleIcon(name: string | undefined, size = 14): JSX.Element {
  switch (name) {
    case "smartphone": case "phone": return <Smartphone size={size} />;
    case "external": case "link": case "download": return <ExternalLink size={size} />;
    case "eye": case "preview": return <Eye size={size} />;
    default: return <Play size={size} />;
  }
}

/** A host-mutation approval: the user sees the RAW facts (URLs, checksums, paths,
 *  env, commands) verbatim — never the agent's paraphrase. Anti-injection contract. */
function ConsentCard({ consent, onApprove }: { consent: CapsuleConsent; onApprove: () => void }): JSX.Element {
  const f = consent.facts;
  const list = (label: string, items: JSX.Element[]): JSX.Element | null =>
    items.length ? <div className="consent-group"><b>{label}</b><ul>{items}</ul></div> : null;
  return (
    <div className="consent-card">
      <div className="consent-title"><TriangleAlert size={15} /> {consent.title}</div>
      {consent.summary && <p className="phone-sub">{consent.summary}</p>}
      <div className="consent-facts">
        {list("Downloads", (f.downloads ?? []).map((d, i) => (
          <li key={i}><code>{d.url}</code>{d.sha256 && <span className="consent-sha"> · sha256 {d.sha256.slice(0, 16)}…</span>}</li>
        )))}
        {list("Writes", (f.writes ?? []).map((w, i) => <li key={i}><code>{w}</code></li>))}
        {list("Env", Object.entries(f.env ?? {}).map(([k, v]) => <li key={k}><code>{k}={v}</code></li>))}
        {list("Commands", (f.commands ?? []).map((c, i) => <li key={i}><code>{c}</code></li>))}
      </div>
      <div className="card-actions">
        <Button kind="btn" variant="primary" autoPending onClick={onApprove}><Check size={14} /> Approve &amp; run</Button>
      </div>
    </div>
  );
}

/** The device-install surface: QR to sideload over the LAN + download + per-device
 *  one-click install. Fully generic — the capsule declares the artifact and the
 *  list/install commands as data. */
function DeviceInstall(
  { action, devices, lanBase }: { action: CapsuleAction; devices: string[]; lanBase: string },
): JSX.Element {
  const artifactUrl = lanBase
    ? `${lanBase}/api/capsule/artifact?ws=${encodeURIComponent(getWs())}&id=${encodeURIComponent(action.id)}`
    : null;
  const qr = artifactUrl ? qrSvg(artifactUrl, { ec: "M", scale: 5, border: 2, dark: "#0b0b0c", light: "#ffffff" }) : "";
  return (
    <div className="mobile-ready">
      {qr && <div className="mobile-qr"><div className="phone-qr" dangerouslySetInnerHTML={{ __html: qr }} /></div>}
      <div className="mobile-ready-body">
        <div className="mobile-ready-title"><Smartphone size={15} /> Install on a device</div>
        <p className="phone-sub">Scan the code with a device on the same Wi-Fi, download, then open it (allow “install from unknown sources”).</p>
        <div className="mobile-actions">
          <button className="btn" onClick={() => window.open(api(`/api/capsule/artifact?id=${encodeURIComponent(action.id)}`), "_blank")}>
            <ExternalLink size={14} /> Download
          </button>
          {devices.map((d) => (
            <Button key={d} kind="btn" variant="primary" autoPending onClick={async () => {
              try {
                const r = await postJSON<{ output: string }>("/api/capsule/install", { id: action.id, device: d });
                toast(`Installed on ${d}.`);
                if (r.output) toast(r.output.slice(-160));
              } catch (e) { toast(String(e), true); }
            }}>
              <Smartphone size={14} /> Install to {d}
            </Button>
          ))}
        </div>
        {devices.length === 0 && (
          <p className="phone-sub subtle">No device detected over USB — plug one in (debugging on) to install directly, or just use the QR.</p>
        )}
      </div>
    </div>
  );
}

/** A read-only metrics/info panel: runs its declared command and shows the output. */
function PanelCard({ panel }: { panel: CapsulePanel }): JSX.Element {
  const [out, setOut] = useState<string | null>(null);
  const load = (): void => {
    if (panel.html !== undefined) return; // html panels are static, nothing to fetch
    setOut(null);
    void fetchJSON<{ output: string }>(`/api/capsule/panel?id=${encodeURIComponent(panel.id)}`)
      .then((r) => setOut(r.output.trim() || "(no output)")).catch((e) => setOut(String(e)));
  };
  useEffect(load, [panel.id]);
  return (
    <div className="cockpit-panel">
      <div className="cockpit-panel-head">
        <span>{panel.title}</span>
        {panel.html === undefined && <button className="btn icon" title="Refresh" onClick={load}><RotateCw size={12} /></button>}
      </div>
      {panel.html !== undefined
        // Sandboxed: scripts run but no same-origin — isolated from the dashboard.
        ? <iframe className="cockpit-panel-html" sandbox="allow-scripts" srcDoc={panel.html} title={panel.title} />
        : <pre className="cockpit-panel-body">{out ?? "…"}</pre>}
    </div>
  );
}

function CockpitModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [view, setView] = useState<CapsuleView | null>(null);
  const [net, setNet] = useState<NetInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [openLog, setOpenLog] = useState<Record<string, boolean>>({});
  const [gen, setGen] = useState<{ state: string; output: string } | null>(null);
  const [prov, setProv] = useState<{ state: string; output: string } | null>(null);
  const [svc, setSvc] = useState<Record<string, { state: string; url: string | null }>>({});
  const [svcOut, setSvcOut] = useState<Record<string, string>>({});
  const [chatMsg, setChatMsg] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [draft, setDraft] = useState<Array<{ t: "ctx" | "add" | "del"; s: string }> | null>(null);
  const [judge, setJudge] = useState<Record<string, { state: string; verdict: string | null; confidence: number | null; reasons: string[]; hasShot: boolean }>>({});
  const poll = useManagedInterval();
  const judgePoll = useManagedInterval();
  const genPoll = useManagedInterval();
  const provPoll = useManagedInterval();
  const svcPoll = useManagedInterval();
  const chatPoll = useManagedInterval();

  const refresh = (): void => {
    void fetchJSON<CapsuleView>("/api/capsule").then(setView).catch((e) => toast(String(e), true));
  };
  const loadDraft = (): void => {
    void fetchJSON<{ has: boolean; diff: Array<{ t: "ctx" | "add" | "del"; s: string }> }>("/api/capsule/chat/draft")
      .then((d) => setDraft(d.has ? d.diff : null)).catch(() => {});
  };
  useEffect(() => {
    refresh();
    loadDraft();
    void fetchJSON<NetInfo>("/api/netinfo").then(setNet).catch(() => {});
  }, []);

  // Conversational edit: an agent rewrites capsule.json → a reviewable diff draft.
  const sendChat = async (): Promise<void> => {
    const message = chatMsg.trim();
    if (!message) return;
    try { await postJSON("/api/capsule/chat", { message }); }
    catch (e) { toast(String(e), true); return; }
    setChatMsg(""); setChatBusy(true);
    chatPoll((stop) => {
      void fetchJSON<{ state: string }>("/api/capsule/status?id=__chat__").then((s) => {
        if (s.state === "ok" || s.state === "error") {
          stop(); setChatBusy(false);
          if (s.state === "ok") { loadDraft(); toast("Proposed an edit — review the diff."); }
          else toast("Couldn't edit the capsule — try rephrasing.", true);
        }
      }).catch(() => {});
    }, 1500);
  };
  // Agent-judge: look at the running app (screenshot) / output → verdict vs criteria.
  const runJudge = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/judge", { id: a.id }); }
    catch (e) { toast(String(e), true); return; }
    setJudge((m) => ({ ...m, [a.id]: { state: "running", verdict: null, confidence: null, reasons: [], hasShot: false } }));
    judgePoll((stop) => {
      void fetchJSON<{ state: string; verdict: string | null; confidence: number | null; reasons: string[]; hasShot: boolean }>(`/api/capsule/judge?id=${encodeURIComponent(a.id)}`)
        .then((s) => {
          setJudge((m) => ({ ...m, [a.id]: s }));
          if (s.state === "done" || s.state === "error") {
            stop();
            if (s.state === "done") toast(`${a.label}: ${s.verdict === "pass" ? "passes" : "fails"} the behavioral check.`, s.verdict !== "pass");
            else toast(`Judge failed on ${a.label}.`, true);
          }
        }).catch(() => {});
    }, 1500);
  };

  const applyChat = async (): Promise<void> => {
    try { await postJSON("/api/capsule/chat/apply", {}); setDraft(null); toast("Applied."); refresh(); }
    catch (e) { toast(String(e), true); }
  };
  const discardChat = async (): Promise<void> => {
    try { await postJSON("/api/capsule/chat/discard", {}); } catch { /* ignore */ }
    setDraft(null);
  };

  const runAction = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/action", { id: a.id }); }
    catch (e) { toast(String(e), true); return; }
    setBusy(a.id);
    setOpenLog((o) => ({ ...o, [a.id]: true }));
    poll((stop) => {
      void fetchJSON<{ state: string; output: string }>(`/api/capsule/status?id=${encodeURIComponent(a.id)}`)
        .then((s) => {
          setLogs((l) => ({ ...l, [a.id]: s.output }));
          if (s.state === "ok" || s.state === "error") {
            stop(); setBusy(null); refresh();
            if (s.state === "ok") { toast(`${a.label} — done.`); setOpenLog((o) => ({ ...o, [a.id]: false })); }
            else toast(`${a.label} failed — see the output.`, true);
          }
        }).catch(() => {});
    }, 1200);
  };

  const grant = async (c: CapsuleConsent): Promise<void> => {
    try { await postJSON("/api/capsule/consent", { id: c.id }); toast(`${c.title} — provisioned.`); refresh(); }
    catch (e) { toast(String(e), true); }
  };

  // Ask AI to fix a failing action: an editing agent runs, then the engine
  // re-verifies the action's own commands (green only if the re-run passes).
  const fixAction = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/fix", { id: a.id }); }
    catch (e) { toast(String(e), true); return; }
    setBusy(a.id);
    setOpenLog((o) => ({ ...o, [a.id]: true }));
    poll((stop) => {
      void fetchJSON<{ state: string; output: string }>(`/api/capsule/status?id=${encodeURIComponent(a.id)}`)
        .then((s) => {
          setLogs((l) => ({ ...l, [a.id]: s.output }));
          if (s.state === "ok" || s.state === "error") {
            stop(); setBusy(null); refresh();
            toast(s.state === "ok" ? `${a.label} fixed — it passes now.` : `Couldn't fix ${a.label} — see the output.`, s.state !== "ok");
          }
        }).catch(() => {});
    }, 1500);
  };

  // Long-running service actions (dev servers): start → capture URL → embed live.
  const startSvc = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/service", { id: a.id }); }
    catch (e) { toast(String(e), true); return; }
    setSvc((m) => ({ ...m, [a.id]: { state: "starting", url: null } }));
    svcPoll((stop) => {
      void fetchJSON<{ state: string; url: string | null; output: string }>(`/api/capsule/service?id=${encodeURIComponent(a.id)}`)
        .then((s) => {
          setSvc((m) => ({ ...m, [a.id]: { state: s.state, url: s.url } }));
          setSvcOut((o) => ({ ...o, [a.id]: s.output }));
          if (s.state === "live") { stop(); toast(`${a.label} is live.`); }
          else if (s.state === "error" || s.state === "stopped") { stop(); if (s.state === "error") toast(`${a.label} failed — see output.`, true); }
        }).catch(() => {});
    }, 1200);
  };
  const stopSvc = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/service/stop", { id: a.id }); } catch (e) { toast(String(e), true); }
    setSvc((m) => ({ ...m, [a.id]: { state: "stopped", url: null } }));
  };

  // Auto-provision: an agent diagnoses the failing doctor checks and proposes
  // install consents (raw facts) — the user approves before anything runs.
  const provision = async (): Promise<void> => {
    try { await postJSON("/api/capsule/provision", {}); }
    catch (e) { toast(String(e), true); return; }
    setProv({ state: "running", output: "" });
    provPoll((stop) => {
      void fetchJSON<{ state: string; output: string }>("/api/capsule/status?id=__provision__")
        .then((s) => {
          setProv(s);
          if (s.state === "ok" || s.state === "error") {
            stop();
            if (s.state === "ok") { toast("Install plan ready — review the facts and approve."); refresh(); }
            else toast("Provisioning diagnosis failed — see the output.", true);
          }
        }).catch(() => {});
    }, 1500);
  };

  // Onboarding agent: inspects the repo (read-only) and writes a capsule.json.
  const generate = async (): Promise<void> => {
    try { await postJSON("/api/capsule/generate", {}); }
    catch (e) { toast(String(e), true); return; }
    setGen({ state: "running", output: "" });
    genPoll((stop) => {
      void fetchJSON<{ state: string; output: string }>("/api/capsule/status?id=__generate__")
        .then((s) => {
          setGen(s);
          if (s.state === "ok" || s.state === "error") {
            stop();
            if (s.state === "ok") { toast("Cockpit generated — review it."); refresh(); }
            else toast("Generation failed — see the output.", true);
          }
        }).catch(() => {});
    }, 1500);
  };

  const capsule = view?.capsule ?? null;
  const grants = new Set(view?.grants ?? []);
  const lanBase = net?.url ?? "";
  const pending = (capsule?.consents ?? []).filter((c) => !grants.has(c.id));
  const granted = (capsule?.consents ?? []).filter((c) => grants.has(c.id));

  const judgeUI = (a: CapsuleAction): JSX.Element | null => {
    if (!a.judge) return null;
    const j = judge[a.id];
    return (
      <div className="judge-block">
        <button className="btn" disabled={j?.state === "running"} onClick={() => runJudge(a)}>
          <Eye size={14} /> {j?.state === "running" ? "Judging…" : "Judge (AI)"}
        </button>
        {j && j.state === "done" && j.verdict && (
          <div className="judge-result">
            <span className={`judge-badge ${j.verdict}`}>
              {j.verdict === "pass" ? <Check size={13} /> : <X size={13} />} {j.verdict.toUpperCase()}
              {j.confidence != null ? ` · ${Math.round(j.confidence * 100)}%` : ""}
            </span>
            {j.reasons.length > 0 && <ul className="judge-reasons">{j.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
            {j.hasShot && <img className="judge-shot" src={api(`/api/capsule/judge/shot?id=${encodeURIComponent(a.id)}`)} alt="what the judge saw" />}
          </div>
        )}
      </div>
    );
  };

  return (
    <Modal title={capsule?.name ? `Cockpit · ${capsule.name}` : "Project cockpit"} onClose={onClose} wide>
      {view && !capsule && (
        <div className="cockpit-empty">
          <div className="preview-status">No capsule for this project yet. The onboarding agent will inspect the repo (read-only) and generate one — the build / test / run recipe plus the controls to render here.</div>
          <div className="card-actions">
            <Button kind="btn" variant="primary" autoPending disabled={gen?.state === "running"} onClick={generate}>
              <Sparkles size={14} /> {gen?.state === "running" ? "Inspecting the repo…" : "Generate cockpit"}
            </Button>
          </div>
        </div>
      )}
      {gen && (gen.state === "running" || gen.state === "error") && gen.output && (
        <details className="mobile-log" open>
          <summary><ChevronDown size={13} /> Onboarding agent</summary>
          <pre className="log-pre">{gen.output}</pre>
        </details>
      )}
      {capsule?.summary && <p className="phone-sub" style={{ marginTop: 0 }}>{capsule.summary}</p>}

      {capsule?.doctor?.length ? (
        <div className="mobile-doctor">
          {capsule.doctor.map((d) => {
            const ok = view?.doctor?.[d.id];
            return <span key={d.id} title={`${ok ? "present" : "missing"} · probe: ${d.probe}`} className={`mobile-chip ${ok ? "ok" : "warn"}`}>{ok ? <Check size={12} /> : "!"} {d.label}</span>;
          })}
          {(capsule.doctor ?? []).some((d) => view?.doctor?.[d.id] === false) && (
            <Button kind="btn" variant="primary" autoPending className="doctor-fix" disabled={prov?.state === "running"} onClick={provision}>
              <Sparkles size={13} /> {prov?.state === "running" ? "Diagnosing…" : "Fix with AI"}
            </Button>
          )}
        </div>
      ) : null}
      {prov && (prov.state === "running" || prov.state === "error") && prov.output && (
        <details className="mobile-log" open>
          <summary><ChevronDown size={13} /> Provisioning agent</summary>
          <pre className="log-pre">{prov.output}</pre>
        </details>
      )}

      {pending.map((c) => <ConsentCard key={c.id} consent={c} onApprove={() => grant(c)} />)}

      <div className="cockpit-actions">
        {(capsule?.actions ?? []).map((a) => {
          const gated = !!a.consent && !grants.has(a.consent);

          // Long-running service: Start/Stop + captured URL + embedded live preview.
          if (a.service) {
            const s = svc[a.id] ?? view?.services?.[a.id] ?? { state: "stopped", url: null };
            const on = s.state === "live" || s.state === "starting";
            return (
              <div key={a.id} className="cockpit-action">
                <div className="cockpit-action-head">
                  {on ? (
                    <Button kind="btn" variant="danger-soft" autoPending onClick={() => stopSvc(a)}>
                      <Square size={13} /> Stop {a.label}
                    </Button>
                  ) : (
                    <Button kind="btn" variant={a.primary ? "primary" : undefined} autoPending disabled={gated} onClick={() => startSvc(a)}>
                      {capsuleIcon(a.icon)} {a.label}
                    </Button>
                  )}
                  {s.state === "starting" && <span className="cockpit-gate">starting…</span>}
                  {s.url && (
                    <button className="btn" onClick={() => window.open(s.url!, "_blank")}><ExternalLink size={14} /> Open</button>
                  )}
                  {gated && <span className="cockpit-gate">approve “{a.consent}” above first</span>}
                </div>
                {a.description && <p className="cockpit-desc">{a.description}</p>}
                {s.state === "live" && s.url && (
                  <iframe className="cockpit-preview" src={s.url} title={a.label} />
                )}
                {(s.state === "starting" || s.state === "error") && svcOut[a.id] && (
                  <details className="mobile-log" open>
                    <summary><ChevronDown size={13} /> Server log</summary>
                    <pre className="log-pre">{svcOut[a.id]}</pre>
                  </details>
                )}
                {judgeUI(a)}
              </div>
            );
          }

          const rs = view?.runs?.[a.id];
          const running = busy === a.id || rs?.state === "running";
          const out = logs[a.id] ?? rs?.output ?? "";
          return (
            <div key={a.id} className="cockpit-action">
              <div className="cockpit-action-head">
                <Button kind="btn" variant={a.primary ? "primary" : undefined} autoPending
                  disabled={running || gated} onClick={() => runAction(a)}>
                  {capsuleIcon(a.icon)} {running ? `${a.label}…` : a.label}
                </Button>
                {a.surface === "preview" && a.url && (
                  <button className="btn" onClick={() => window.open(a.url!.replace("${lan}", lanBase), "_blank")}>
                    <Eye size={14} /> Open
                  </button>
                )}
                {rs?.state === "error" && !running && (
                  <Button kind="btn" variant="primary" autoPending onClick={() => fixAction(a)}>
                    <Sparkles size={14} /> Ask AI to fix
                  </Button>
                )}
                {gated && <span className="cockpit-gate">approve “{a.consent}” above first</span>}
              </div>
              {a.description && <p className="cockpit-desc">{a.description}</p>}

              {a.surface === "device-install" && rs?.artifactReady && (
                <DeviceInstall action={a} devices={view?.devices?.[a.id] ?? []} lanBase={lanBase} />
              )}

              {out && (
                <details className="mobile-log" open={openLog[a.id] ?? false}
                  onToggle={(e) => setOpenLog((o) => ({ ...o, [a.id]: (e.currentTarget as HTMLDetailsElement).open }))}>
                  <summary><ChevronDown size={13} /> Output</summary>
                  <pre className="log-pre">{out}</pre>
                </details>
              )}
              {judgeUI(a)}
            </div>
          );
        })}
      </div>

      {(capsule?.panels ?? []).length > 0 && (
        <div className="cockpit-panels">
          {capsule!.panels!.map((p) => <PanelCard key={p.id} panel={p} />)}
        </div>
      )}

      {(granted.length > 0 || capsule) && (
        <div className="cockpit-granted">
          {granted.map((c) => <span key={c.id} className="mobile-chip ok"><Check size={12} /> {c.title}</span>)}
          {capsule && (
            <button className="btn ghost cockpit-regen" title="Re-run the onboarding agent to regenerate this capsule"
              disabled={gen?.state === "running"} onClick={generate}>
              <Sparkles size={13} /> {gen?.state === "running" ? "Regenerating…" : "Regenerate"}
            </button>
          )}
        </div>
      )}

      {capsule && (
        <div className="cockpit-chat">
          {draft && (
            <div className="chat-draft">
              <div className="chat-draft-head"><Sparkles size={14} /> Proposed edit — review then apply</div>
              <pre className="chat-diff">
                {draft.filter((l) => l.t !== "ctx").length === 0
                  ? <span className="dl-ctx">No change.</span>
                  : draft.map((l, i) => (
                    <div key={i} className={`dl-${l.t}`}>{l.t === "add" ? "+" : l.t === "del" ? "-" : " "} {l.s}</div>
                  ))}
              </pre>
              <div className="card-actions">
                <Button kind="btn" variant="primary" autoPending onClick={applyChat}><Check size={14} /> Apply</Button>
                <button className="btn ghost" onClick={discardChat}><X size={14} /> Discard</button>
              </div>
            </div>
          )}
          <div className="chat-row">
            <input className="chat-input" value={chatMsg} placeholder="Edit the cockpit in plain English — e.g. “add a lint action” or “dev server is on port 3000”"
              onChange={(e) => setChatMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !chatBusy) void sendChat(); }} disabled={chatBusy} />
            <Button kind="btn" variant="primary" autoPending disabled={chatBusy || !chatMsg.trim()} onClick={sendChat}>
              <Sparkles size={14} /> {chatBusy ? "Editing…" : "Edit"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------- Repo modal --------------------------------- */

interface TreeNode { name: string; path: string; isFile: boolean; children: Map<string, TreeNode> }

/** Fold flat repo paths ("src/components/Nav.tsx") into a nested folder tree. */
function buildFileTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isFile: false, children: new Map() };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), isFile, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

/** Folders first, then files; alphabetical within each. */
function sortedEntries(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) =>
    a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1);
}

function TreeFolder(
  { node, depth, onOpen, activePath }:
  { node: TreeNode; depth: number; onOpen: (p: string) => void; activePath: string | null },
): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button className="tree-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tree-chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="tree-ic" aria-hidden="true">{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {open && sortedEntries(node).map((e) => e.isFile
        ? <button key={e.path} className={`tree-file${activePath === e.path ? " on" : ""}`}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }} onClick={() => onOpen(e.path)}>
            <span className="tree-ic" aria-hidden="true"><FileText size={14} /></span><span className="tree-name">{e.name}</span>
          </button>
        : <TreeFolder key={e.path} node={e} depth={depth + 1} onOpen={onOpen} activePath={activePath} />)}
    </>
  );
}

/** The repo files as a collapsible folder tree. */
function FileTree({ paths, onOpen, activePath }: { paths: string[]; onOpen: (p: string) => void; activePath: string | null }): JSX.Element {
  const root = buildFileTree(paths);
  return (
    <div className="tree">
      {sortedEntries(root).map((e) => e.isFile
        ? <button key={e.path} className={`tree-file${activePath === e.path ? " on" : ""}`} style={{ paddingLeft: 8 }} onClick={() => onOpen(e.path)}>
            <span className="tree-ic" aria-hidden="true"><FileText size={14} /></span><span className="tree-name">{e.name}</span>
          </button>
        : <TreeFolder key={e.path} node={e} depth={0} onOpen={onOpen} activePath={activePath} />)}
    </div>
  );
}

function RepoModal({ onClose }: { onClose: () => void }): JSX.Element {
  const repo = repoPath();
  const [tab, setTab] = useState<"files" | "history">("files");
  const [files, setFiles] = useState<string[]>([]);
  const [commits, setCommits] = useState<Array<{ hash: string; date: string; author: string; subject: string }>>([]);
  const [branches, setBranches] = useState<{ branches: string[]; current: string }>({ branches: [], current: "" });
  const [mainView, setMainView] = useState<ReactNode>(<p className="hint">Pick a file to preview it, or a commit to see its diff.</p>);
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    void repoGet<{ branches: string[]; current: string }>("branches").then(setBranches).catch(() => {});
    void repoGet<{ files: string[] }>("tree").then((r) => setFiles(r.files)).catch(() => {});
  }, []);
  useEffect(() => {
    if (tab === "history") void repoGet<{ commits: typeof commits }>("log").then((r) => setCommits(r.commits)).catch(() => {});
  }, [tab]);

  if (!repo) return <Modal title="Repo" onClose={onClose}><p className="hint">Set a repository path in the New work panel first.</p></Modal>;

  const openFile = async (path: string): Promise<void> => {
    setActivePath(path);
    try {
      const { content } = await repoGet<{ content: string }>("file", { path });
      setMainView(
        <>
          <div className="repo-file-bar"><span className="card-title">{path}</span>
            <button className="btn ghost" onClick={() => { window.location.href = `vscode://file/${repo.replace(/\\/g, "/")}/${path}`; }}>Open in IDE</button></div>
          <CodeBlock content={content} path={path} />
        </>,
      );
    } catch (err) { toast(String(err), true); }
  };
  const openDiff = async (hash: string): Promise<void> => {
    const { diff } = await repoGet<{ diff: string }>("diff", { commit: hash });
    setMainView(<><div className="repo-file-bar">Commit {hash}</div><Diff text={diff} /></>);
  };

  return (
    <Modal title={`Repo — ${repo.split(/[\\/]/).pop()}`} onClose={onClose} wide>
      <div className="repo-toolbar">
        <select className="picker" value={branches.current}
          onChange={async (e) => {
            try { await postJSON("/api/repo/switch", { path: repo, branch: e.target.value }); toast(`Now on ${e.target.value}.`);
              const r = await repoGet<{ branches: string[]; current: string }>("branches"); setBranches(r); }
            catch (err) { toast(String(err), true); }
          }}>
          {branches.branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <div className="repo-tabs">
          <button className={`btn link${tab === "files" ? " on" : ""}`} onClick={() => setTab("files")}>Files</button>
          <button className={`btn link${tab === "history" ? " on" : ""}`} onClick={() => setTab("history")}>History</button>
        </div>
      </div>
      <div className="repo-body">
        <div className="repo-side">
          {tab === "files"
            ? <FileTree paths={files} onOpen={(p) => void openFile(p)} activePath={activePath} />
            : commits.map((c) => (
              <button key={c.hash} className="commit-row" onClick={() => void openDiff(c.hash)}>
                <div className="commit-subject">{c.subject}</div>
                <div className="commit-meta">{c.hash} · {c.author} · {c.date}</div>
              </button>
            ))}
        </div>
        <div className="repo-main">{mainView}</div>
      </div>
    </Modal>
  );
}

/** One source line rendered as coloured tokens (syntax highlighting). */
function CodeLine({ code, lang }: { code: string; lang: string }): JSX.Element {
  const toks = tokenizeLine(code, lang);
  return <>{toks.map((t, i) => <span key={i} className={t.cls || undefined}>{t.text}</span>)}</>;
}

/** A whole file preview with line numbers and syntax highlighting. */
function CodeBlock({ content, path }: { content: string; path: string }): JSX.Element {
  const lang = langFromPath(path);
  return (
    <pre className="code-pre">
      {content.split("\n").map((ln, i) => (
        <div key={i} className="code-line">
          <span className="code-gutter">{i + 1}</span>
          <span className="code-text"><CodeLine code={ln} lang={lang} /></span>
        </div>
      ))}
    </pre>
  );
}

/** An operator's note pinned to one diff line (the pépite: it loops back to the
 *  agent as "changes" feedback). */
interface ReviewComment { id: number; file: string; key: string; line: number | null; snippet: string; text: string }
let commentSeq = 0;

interface ReviewProps {
  comments: ReviewComment[];
  composingKey: string | null;
  onStart: (file: string, key: string, line: number | null, snippet: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  onRemove: (id: number) => void;
}

/** Inline textarea to compose a comment on one diff line. Cmd/Ctrl+Enter saves. */
function CommentComposer({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (t: string) => void }): JSX.Element {
  const [t, setT] = useState("");
  return (
    <div className="diff-composer" onClick={(e) => e.stopPropagation()}>
      <textarea autoFocus className="input" placeholder="What's wrong with this line?" value={t}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && t.trim()) { e.preventDefault(); onSubmit(t.trim()); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }} />
      <div className="composer-actions">
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="btn primary sm" disabled={!t.trim()} onClick={() => onSubmit(t.trim())}>Add</button>
      </div>
    </div>
  );
}

/** A unified diff: one collapsible section per file, syntax-highlighted, with a
 *  jump bar when several files changed. With `review`, each line takes an inline
 *  comment thread. */
function Diff({ text, review }: { text: string; review?: ReviewProps }): JSX.Element {
  const { files } = useMemo(() => parseDiff(text), [text]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (p: string): void =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  if (files.length === 0) return <pre className="diff-pre">{text}</pre>;
  const jump = (path: string): void =>
    document.getElementById(`df-${path}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  return (
    <div className="diff-view">
      {files.length > 1 && (
        <div className="diff-filebar">
          {files.map((f) => (
            <button key={f.path} className="diff-filechip" onClick={() => jump(f.path)}>
              <span className="chip-path">{f.path.split("/").pop()}</span>
              <span className="chip-add">+{f.adds}</span><span className="chip-del">−{f.dels}</span>
            </button>
          ))}
        </div>
      )}
      {files.map((f) => {
        const lang = langFromPath(f.path);
        const shut = collapsed.has(f.path);
        return (
          <section key={f.path} id={`df-${f.path}`} className="diff-file">
            <button className="diff-filehead" onClick={() => toggle(f.path)}>
              <span className={`chev${shut ? " closed" : ""}`}><ChevronDown size={14} /></span>
              <span className="dfh-path">{f.path}</span>
              <span className="dfh-counts"><span className="chip-add">+{f.adds}</span><span className="chip-del">−{f.dels}</span></span>
            </button>
            {!shut && (
              <pre className="diff-pre">
                {f.lines.map((l, i) => {
                  if (l.kind === "hunk") return <div key={i} className="diff-line diff-hunk">{l.text}</div>;
                  const lineKey = `${f.path}#${i}`;
                  const threads = review ? review.comments.filter((c) => c.key === lineKey) : [];
                  return (
                    <div key={i}>
                      <div className={`diff-line diff-${l.kind}${review ? " commentable" : ""}`}>
                        <span className="diff-mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                        <span className="diff-code"><CodeLine code={l.text} lang={lang} /></span>
                        {review && (
                          <button className="diff-add-comment" title="Comment on this line"
                            onClick={() => review.onStart(f.path, lineKey, l.n ?? null, l.text)}>+</button>
                        )}
                      </div>
                      {threads.map((c) => (
                        <div key={c.id} className="diff-comment">
                          <span className="dc-text">{c.text}</span>
                          <button className="dc-del" title="Remove" onClick={() => review!.onRemove(c.id)}>×</button>
                        </div>
                      ))}
                      {review?.composingKey === lineKey && (
                        <CommentComposer onCancel={review.onCancel} onSubmit={review.onSubmit} />
                      )}
                    </div>
                  );
                })}
              </pre>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* --------------------------------- New work modal --------------------------------- */

interface Ticket { file: string; content: string }
/* ---- ticket front-matter helpers: read/patch one scalar key without touching
   the rest of the file, so the per-ticket pickers below can tune `model:` and
   `effort:` while hand-written YAML stays intact. ---- */

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function fmGet(content: string, key: string): string {
  const fm = FM_RE.exec(content)?.[1] ?? "";
  return new RegExp(`^${key}:\\s*["']?([\\w.-]+)["']?\\s*$`, "m").exec(fm)?.[1] ?? "";
}

function fmSet(content: string, key: string, value: string): string {
  const m = FM_RE.exec(content);
  if (!m) return content;
  const kept = m[1]!.split(/\r?\n/).filter((l) => !l.startsWith(`${key}:`));
  if (value) kept.push(`${key}: ${value}`);
  return content.replace(m[0], `---\n${kept.join("\n")}\n---`);
}

/** Per-ticket model + effort pickers: patch the ticket's front matter in place
 *  and save immediately. These pin THIS ticket only, overriding the run-wide
 *  defaults chosen in Settings. */
function TicketTune(
  { ticket, onSaved }: { ticket: Ticket; onSaved: () => void },
): JSX.Element {
  const save = async (key: "model" | "effort", value: string): Promise<void> => {
    try {
      await postJSON(`/api/backlog/${encodeURIComponent(ticket.file)}`,
        { content: fmSet(ticket.content, key, value) });
      toast(value ? `Ticket pinned to ${key} “${value}”.` : `Ticket back to the default ${key}.`);
      onSaved();
    } catch (err) { toast(String(err), true); }
  };
  const saveFlag = async (key: "skip_verify" | "skip_review", on: boolean): Promise<void> => {
    try {
      await postJSON(`/api/backlog/${encodeURIComponent(ticket.file)}`,
        { content: fmSet(ticket.content, key, on ? "true" : "") });
      toast(on
        ? `This ticket will skip ${key === "skip_verify" ? "verification" : "the AI reviewer"}.`
        : `This ticket back to the default ${key === "skip_verify" ? "verification" : "review"}.`);
      onSaved();
    } catch (err) { toast(String(err), true); }
  };
  const model = fmGet(ticket.content, "model");
  const effort = fmGet(ticket.content, "effort");
  const skipVerify = fmGet(ticket.content, "skip_verify") === "true";
  const skipReview = fmGet(ticket.content, "skip_review") === "true";
  const modelChoices = [...MODEL_CHOICES];
  if (model && !modelChoices.some(([v]) => v === model)) modelChoices.push([model, model]);
  const effortChoices = [...EFFORT_CHOICES];
  if (effort && !effortChoices.some(([v]) => v === effort)) effortChoices.push([effort, effort]);
  return (
    <div className="ticket-tune" title="Model, effort and checks pinned for THIS ticket — they override the run-wide defaults from Settings.">
      <select className="picker mini" value={model} onChange={(e) => void save("model", e.target.value)}>
        {modelChoices.map(([v, l]) => <option key={v} value={v}>{v ? l.split(" — ")[0] : "Model: default"}</option>)}
      </select>
      <select className="picker mini" value={effort} onChange={(e) => void save("effort", e.target.value)}>
        {effortChoices.map(([v, l]) => <option key={v} value={v}>{v ? l : "Effort: default"}</option>)}
      </select>
      <label className="tune-flag" title="Skip the automated test/verify step for this ticket — for a change small enough that you'll just check it yourself.">
        <input type="checkbox" checked={skipVerify} onChange={(e) => void saveFlag("skip_verify", e.target.checked)} /> Skip tests
      </label>
      <label className="tune-flag" title="Skip the AI code reviewer for this ticket — saves a whole review agent's tokens on a low-risk change like a title tweak.">
        <input type="checkbox" checked={skipReview} onChange={(e) => void saveFlag("skip_review", e.target.checked)} /> Skip review
      </label>
    </div>
  );
}

function ticketTitle(content: string): string {
  const m = content.match(/^title:\s*(.+)$/m);
  return m ? m[1]!.replace(/^["']|["']$/g, "") : "(untitled)";
}

/** The ticket body — everything after the front matter block. */
function ticketBody(content: string): string {
  const m = FM_RE.exec(content);
  return (m ? content.slice(m[0].length) : content).replace(/^\r?\n/, "");
}

/** Rewrite a ticket's title (front matter) and body, preserving every other flag
 *  already on it (assignee, status, hold, model, effort, skip_*). */
function withTitleAndBody(content: string, title: string, body: string): string {
  const q = `"${title.replace(/"/g, "'")}"`;
  const m = FM_RE.exec(content);
  if (!m) return `---\ntitle: ${q}\n---\n${body.trim()}\n`;
  const kept = m[1]!.split(/\r?\n/).filter((l) => !/^title:\s*/.test(l));
  const idIdx = kept.findIndex((l) => /^id:\s*/.test(l));
  kept.splice(idIdx >= 0 ? idIdx + 1 : 0, 0, `title: ${q}`);
  return `---\n${kept.join("\n")}\n---\n${body.trim()}\n`;
}

/** Relative "2m ago" style stamp for a companion observation. */
function agoShort(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * The always-on companion rail: a chat-style thread of what happened in the
 * project. Reads oldest-to-newest — newest at the bottom by the input, scroll up
 * for history — with the supervisor's replies and briefings inline in the same
 * thread. "Show every detail" reveals every degree so the full history is always
 * reachable. Attention-level items carry a one-click action (retry, stop…) wired
 * to the same control channel as the board.
 */

/** Zone 2 — exactly what's on the operator's plate, with safe one-click actions. */
function NeedsYou(
  { tasks, live, onAnswer, onReview }:
  { tasks: TaskModel[]; live: boolean; onAnswer: (t: TaskModel) => void; onReview: (t: TaskModel) => void },
): JSX.Element {
  const why = (t: TaskModel): string =>
    t.state === "BLOCKED" ? (t.note ? t.note : "needs an answer")
      : t.state === "AWAITING_APPROVAL" ? "ready for your review"
      : "failed — needs a retry or a look";
  return (
    <div className="needs">
      <div className="needs-head">Needs you <span className="needs-n">{tasks.length}</span></div>
      {tasks.map((t) => (
        <div key={t.id} className={`needs-row needs-${t.state.toLowerCase()}`}>
          <div className="needs-info">
            <div className="needs-t"><span className="needs-id">{t.id}</span> {t.title}</div>
            <div className="needs-why">{why(t)}</div>
          </div>
          <div className="needs-acts">
            {t.state === "BLOCKED" && live && <button className="needs-act primary" onClick={() => onAnswer(t)}>Answer</button>}
            {t.state === "AWAITING_APPROVAL" && (
              <>
                <button className="needs-act" onClick={() => onReview(t)}>Review</button>
                <Button kind="act" variant="primary" autoPending onClick={() => sendControl("approve", t.id)}>Approve</Button>
              </>
            )}
            {t.state === "FAILED" && live && (
              <Button kind="act" variant="primary" autoPending onClick={() => sendControl("retry", t.id)}>Retry</Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One run's chapter in the timeline: a headed, collapsible group of event nodes,
 *  read top-to-bottom in chronological order (oldest first, newest last). */
function RunChapter(
  { events, defaultOpen, now, currentRun }:
  { events: Observation[]; defaultOpen: boolean; now: number; currentRun: string | null },
): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const first = events[0]!; // events are oldest-first: the first marks the run's start
  const d = first ? new Date(first.ts) : null;
  const when = d && !Number.isNaN(d.getTime())
    ? `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : first?.run ?? "";
  const shipped = events.filter((o) => o.icon === "✅").length;
  return (
    <div className="tl-chapter">
      <button className="tl-chapter-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tl-chevron">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className="tl-run">Run · {when}</span>
        {shipped > 0 && <span className="tl-shipped">{shipped} shipped</span>}
      </button>
      {open && (
        <div className="tl-nodes">
          {events.map((o) => (
            o.kind === "chat" ? (
              <div key={o.id} className="tl-you"><span className="tl-you-text">{o.text}</span><span className="tl-ago">{agoShort(o.ts, now)}</span></div>
            ) : o.kind === "briefing" ? (
              <div key={o.id} className="tl-brief-wrap">
                <div className="tl-brief"><span className="tl-ic"><Bot size={14} /></span><span className="tl-text">{o.text}</span><span className="tl-ago">{agoShort(o.ts, now)}</span></div>
                {!!o.suggestions?.length && o.run === currentRun && (
                  <div className="tl-brief-acts">
                    {o.suggestions.map((s, i) => (
                      <button key={i} className="asst-act" onClick={() => void sendControl(s.op, s.task)}>{s.label}</button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div key={o.id} className={`tl-node lvl-${o.level}`}>
                <span className="tl-node-dot" aria-hidden="true" />
                <span className="tl-ic"><CompanionIcon emoji={o.icon} /></span>
                <span className="tl-text">{o.text}</span>
                <span className="tl-ago">{agoShort(o.ts, now)}</span>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}

function CompanionRail(
  { obs, feed, onClose, now, currentRun, live, needsYou, onAnswer, onReview }:
  {
    obs: Observation[]; feed: FactoryEvent[]; onClose: () => void; now: number; currentRun: string | null; live: boolean;
    needsYou: TaskModel[]; onAnswer: (t: TaskModel) => void; onReview: (t: TaskModel) => void;
  },
): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [raw, setRaw] = useState(false); // raw event log (folds in what used to be the bottom "Activity log")
  const [msg, setMsg] = useState("");
  const [thinking, setThinking] = useState(false);
  const [progress, setProgress] = useState("");
  const pollChat = useManagedInterval();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedBottom = useRef(true);

  // The rail reads like a chat: everything the supervisor says (chat replies AND
  // proactive briefings) lives in the timeline — oldest at the top, newest at the
  // bottom beside the input. One continuous thread, no separately pinned card.
  const storyObs = obs.filter((o) => showAll || o.degree <= 1);
  const chapterOrder: string[] = [];
  const byRun = new Map<string, Observation[]>();
  for (const o of storyObs) {
    if (!byRun.has(o.run)) { byRun.set(o.run, []); chapterOrder.push(o.run); }
    byRun.get(o.run)!.push(o);
  }
  // Chronological: oldest run first, events oldest-first within each chapter.
  const chapters = chapterOrder.map((run) => ({ run, events: byRun.get(run)! }));

  // Keep the view stuck to the newest message unless the operator scrolled up to
  // read history — the messaging-app convention the operator expects.
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el) pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedBottom.current) el.scrollTop = el.scrollHeight;
  }, [obs.length, thinking, progress, raw, feed.length]);

  const send = async (): Promise<void> => {
    const text = msg.trim();
    if (!text || thinking) return;
    setMsg(""); setThinking(true); setProgress("");
    try {
      await postJSON("/api/chat", { message: text });
      pollChat((stop) => {
        void (async () => {
          try {
            const st = await fetchJSON<{ chat: { state: string; progress?: string } }>("/api/status");
            setProgress(st.chat.progress ?? "");
            if (st.chat.state === "running") return;
          } catch { /* keep polling */ }
          stop(); setThinking(false); setProgress("");
        })();
      }, 1500);
    } catch (err) { setThinking(false); setProgress(""); toast(String(err), true); }
  };

  return (
    <aside className="companion">
      <div className="companion-head">
        <span className="companion-title">Supervisor</span>
        <button className="companion-x" onClick={onClose} title="Hide" aria-label="Hide supervisor">›</button>
      </div>

      {needsYou.length > 0 && (
        <NeedsYou tasks={needsYou} live={live} onAnswer={onAnswer} onReview={onReview} />
      )}

      <div className="companion-scroll" ref={scrollRef} onScroll={onScroll}>
        {(chapters.length > 0 || feed.length > 0) && (
          <div className="tl-controls">
            {!raw && (
              <button className="companion-all" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show less" : "Show every detail"}
              </button>
            )}
            <button className={`companion-all${raw ? " on" : ""}`} title="The raw, unfolded event log for this run"
              onClick={() => setRaw((v) => !v)}>{raw ? "← Story view" : "Raw log"}</button>
          </div>
        )}
        {raw ? (
          feed.length === 0
            ? <div className="companion-empty">No events yet.</div>
            : <div className="raw-log">
                {feed.map((e, i) => (
                  <div key={i} className="raw-line">
                    <span className="raw-ts">{e.ts?.slice(11, 19) ?? ""}</span>
                    <span className="raw-body">{describe(e)}</span>
                  </div>
                ))}
              </div>
        ) : chapters.length > 0 ? (
          <div className="tl">
            {chapters.map((ch, i) => (
              <RunChapter key={ch.run} events={ch.events} defaultOpen={i === chapters.length - 1}
                now={now} currentRun={currentRun} />
            ))}
          </div>
        ) : !thinking ? (
          <div className="companion-empty">I'm watching your runs. Ask me anything below, and I'll flag whatever needs you.</div>
        ) : null}
        {thinking && (
          <div className="tl-brief tl-thinking">
            <span className="tl-ic"><Bot size={14} /></span>
            <span className="asst-thinking">
              <span className="asst-dots"><span className="asst-dot" /><span className="asst-dot" /><span className="asst-dot" /></span>
              {progress && <span className="asst-progress">{progress}</span>}
            </span>
          </div>
        )}
      </div>

      <div className="companion-ask">
        <textarea className="input companion-input" placeholder="Ask your assistant…" value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="btn primary companion-send" aria-label="Send message" disabled={thinking || !msg.trim()}
          onClick={() => void send()}><Send size={16} /></button>
      </div>
    </aside>
  );
}

/** Icon for one planner activity line, keyed off the verb describe_step emits. */
function stepIcon(step: string): LucideIcon {
  if (step.startsWith("reading ")) return BookOpen;
  if (step.startsWith("searching")) return Search;
  if (step.startsWith("finding files")) return Folder;
  return Lightbulb;
}

/**
 * Live feedback while the planning agent explores the repo. Instead of a raw log
 * dump, it shows an elapsed timer and the agent's recent moves (files read,
 * searches) as a feed — so a 1-3 min wait feels alive and legible. The lines
 * come from `factory plan` stdout, each prefixed "· " by the CLI.
 */
function PlanProgress({ output, startMs }: { output: string; startMs: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const steps = output
    .split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("· ")).map((l) => l.slice(2));
  const recent = steps.slice(-5);
  const secs = startMs ? Math.max(0, Math.floor((now - startMs) / 1000)) : 0;
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="plan-progress">
      <div className="plan-progress-head">
        <span className="plan-spinner" />
        <span className="plan-phase">{recent.length ? "Exploring your repo" : "Waking the planning agent"}…</span>
        <span className="plan-timer">{mmss}</span>
      </div>
      {recent.length > 0 ? (
        <ul className="plan-steps">
          {recent.map((s, i) => {
            const StepIcon = stepIcon(s);
            return (
              <li key={`${i}-${s}`} className={i === recent.length - 1 ? "on" : ""}>
                <span className="plan-step-ic"><StepIcon size={13} /></span>{s}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="plan-hint-line">Reading your code to draft parallel-safe tickets — usually 1–3 minutes.</div>
      )}
    </div>
  );
}

/** GitHub/repo actions for a project: initialise a repo, publish it, flip its
 *  visibility. Shared by the New-project flow and Settings › Repository — the two
 *  places a project's repo is set up (it is a project property, not a ticket's). */
function RepoTools({ repo }: { repo: string }): JSX.Element {
  const [vis, setVis] = useState("private");
  const action = async (endpoint: string, withVis: boolean): Promise<void> => {
    setRepoPath(repo);
    try {
      const body: Record<string, string> = { path: repo.trim() };
      if (withVis) body.visibility = vis;
      const r = await postJSON<{ output?: string }>(endpoint, body);
      toast(r.output?.slice(-280) || "Done.");
    } catch (err) { toast(String(err), true); }
  };
  return (
    <div className="repo-tools">
      <button className="btn ghost" disabled={!repo.trim()} onClick={() => void action("/api/repo/init", false)}><FolderPlus size={14} /> Start project here</button>
      <select className="picker" value={vis} onChange={(e) => setVis(e.target.value)}>
        <option value="private">private</option><option value="public">public</option>
      </select>
      <button className="btn ghost" disabled={!repo.trim()} onClick={() => void action("/api/repo/publish", true)}><Upload size={14} /> Publish to GitHub</button>
      <ConfirmButton label="Set visibility" confirm="Sure? Click again" className="ghost" onConfirm={() => void action("/api/repo/visibility", true)} />
    </div>
  );
}

/** The single surface for creating work. One clear fork up top — author one
 *  ticket by hand (optionally fleshed out by AI) or describe a goal and let the
 *  planner draft several — then both feed the same backlog, reviewed and launched
 *  below. Repo/GitHub setup lives in Settings › Repository (it is a project
 *  property, not part of writing a ticket); the `project` variant is the one
 *  exception, prepending first-run setup where the repo must be set inline. */
function NewWorkModal(
  { onClose, onWorkspaceAdded, onBacklogChange, takenIds = [], initialTab = "one", variant = "work" }:
  { onClose: () => void; onWorkspaceAdded: () => void; onBacklogChange?: () => void;
    takenIds?: string[]; initialTab?: "one" | "goal"; variant?: "work" | "project" },
): JSX.Element {
  const isProject = variant === "project";
  const [tab, setTab] = useState<"one" | "goal">(initialTab);
  const [repo, setRepo] = useState(repoPath());
  // For a NEW project: the dedicated, isolated workspace we create for it (once).
  // Until it exists, no drafting may touch the currently-active workspace.
  const [projectWs, setProjectWs] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [slots, setSlots] = useState(3);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // "One ticket" tab.
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [completing, setCompleting] = useState(false);
  // "From a goal" tab.
  const [goal, setGoal] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planOut, setPlanOut] = useState("");
  const [planStart, setPlanStart] = useState(0);
  const pollPlan = useManagedInterval();

  const refreshBacklog = async (): Promise<void> => {
    try {
      const { tickets: t } = await fetchJSON<{ tickets: Ticket[] }>("/api/backlog");
      setTickets(t);
      onBacklogChange?.(); // keep the board's Up-next drafts live while this is open
    } catch { /* */ }
  };
  useEffect(() => { void refreshBacklog(); }, []);
  // The repo belongs to the PROJECT (server-side), not to this browser: seed it
  // from the workspace's remembered repo, falling back to the last-typed value.
  useEffect(() => {
    // A new project gets its OWN repo — never inherit the active project's, or the
    // separation the isolated workspace gives us is undone at the input.
    if (isProject) return;
    void fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces").then(({ workspaces }) => {
      const active = workspaces.find((w) => w.name === getWs()) ?? workspaces[0];
      if (active?.repo) { setRepo(active.repo); setRepoPath(active.repo); }
    }).catch(() => { /* keep the local value */ });
  }, []);

  // Next free ticket number (padded, e.g. "004"). It must clear the backlog AND
  // every run task id: after a run, the backlog is empty, so counting it alone
  // would recycle "001"… — which collides with a merged task of the same id and
  // gets the new draft filtered off the board. Take the max across both.
  const nextId = (): string => {
    const fromFiles = tickets.map((t) => Number((/^(\d+)/.exec(t.file) ?? [])[1]));
    const fromTasks = takenIds.map((id) => Number((/(\d+)/.exec(id) ?? [])[1]));
    const nums = [...fromFiles, ...fromTasks].filter((n) => !Number.isNaN(n));
    return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0");
  };

  // New project: create ONE dedicated, isolated workspace bound to this repo and
  // switch to it before any drafting, so tickets never land in — nor inherit
  // from — another project's workspace. Created at most once per modal.
  const ensureIsolatedWs = async (): Promise<boolean> => {
    if (!isProject || projectWs) return true;
    const r = repo.trim();
    if (!r) { toast("Point the project at a repository first.", true); return false; }
    try {
      const { name } = await postJSON<{ name: string }>("/api/projects", { repo: r });
      setWs(name); setProjectWs(name); setRepoPath(r);
      await refreshBacklog();   // the new workspace starts empty — resync ids/drafts
      onWorkspaceAdded();
      toast(`Isolated workspace ready for “${name}”.`);
      return true;
    } catch (err) { toast(String(err), true); return false; }
  };

  // "One ticket": expand the operator's notes into a Goal + Done-when checklist.
  const complete = async (): Promise<void> => {
    setCompleting(true);
    try {
      const r = await postJSON<{ body?: string }>("/api/ticket/complete", { title: title.trim(), notes: notes.trim() });
      if (r.body?.trim()) { setNotes(r.body.trim()); toast("Filled in by AI — tweak it, then add."); }
      else toast("The model returned nothing — try adding a bit more detail.", true);
    } catch (err) { toast(String(err), true); }
    finally { setCompleting(false); }
  };

  // "One ticket": write it to the backlog and close, so the operator immediately
  // sees the new draft land in the board's Up-next column (and can launch it from
  // there). Adding several at once is the "From a goal" tab's job.
  const addOne = async (): Promise<void> => {
    const t = title.trim();
    if (!t) { toast("Give the ticket a title.", true); return; }
    if (!(await ensureIsolatedWs())) return;
    const id = nextId();
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ticket";
    const body = notes.trim() || "## Goal\nDescribe what to build.\n\n## Done when\n- ";
    const content = `---\nid: "${id}"\ntitle: "${t.replace(/"/g, "'")}"\nrepo: ${repo.trim()}\n---\n${body}\n`;
    try {
      await postJSON(`/api/backlog/${encodeURIComponent(`${id}-${slug}.md`)}`, { content });
      toast(`Ticket ${id} added to Up next.`);
      await refreshBacklog();
      onClose();
    } catch (err) { toast(String(err), true); }
  };

  // "From a goal": kick off the AI planner and follow its progress.
  const startPlan = async (): Promise<void> => {
    if (!goal.trim()) { toast("Say what you want done first.", true); return; }
    if (!(await ensureIsolatedWs())) return;
    setRepoPath(repo);
    try { await postJSON("/api/plan", { goal, repo }); } catch (err) { toast(String(err), true); return; }
    setPlanning(true); setPlanOut(""); setPlanStart(Date.now());
    pollPlan((stop) => {
      void (async () => {
        const st = await fetchJSON<{ plan: { state: string; output: string } }>("/api/status");
        setPlanOut(st.plan.output.slice(-4000));
        if (st.plan.state === "running") return;
        stop(); setPlanning(false);
        if (st.plan.state === "done") { toast("Tickets drafted — review them below."); void refreshBacklog(); }
        else toast("Planning failed — see the output.", true);
      })();
    }, 1500);
  };

  const startRun = async (): Promise<void> => {
    try { await postJSON("/api/run", { slots: slots || undefined }); } catch (err) { toast(String(err), true); return; }
    toast("Run starting — the board follows automatically."); onClose();
  };

  return (
    <Modal title={isProject ? "New project" : "New work"} onClose={onClose} wide>
      {isProject && (
        <div className="work-form ws-first">
          <h2>Create the project</h2>
          <p className="hint">A project is one repository. Point it at a repo (or start a fresh one below) — a dedicated, isolated workspace is created for it automatically, so its backlog, runs and settings never mix with another project's.</p>
          <label className="work-label">Repository path</label>
          <input className="input" placeholder="C:\\path\\to\\your\\repo" value={repo}
            onChange={(e) => { setRepo(e.target.value); setRepoPath(e.target.value); }} />
          <RepoTools repo={repo} />
          {!projectWs ? (
            <div className="work-draft-row">
              <button className="btn primary" disabled={!repo.trim()} onClick={() => void ensureIsolatedWs()}>
                <FolderPlus size={14} /> Create project
              </button>
            </div>
          ) : (
            <p className="hint appearance-hint">Isolated workspace “{projectWs}” created — everything below stays in this project.</p>
          )}
          <div className="or-divider"><span>{projectWs ? "then draft its work below" : "create the project, then draft its work"}</span></div>
        </div>
      )}

      {(!isProject || projectWs) && (<>
      <div className="work-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "one"} className={`work-tab${tab === "one" ? " on" : ""}`} onClick={() => setTab("one")}>
          <Plus size={14} /> One ticket
        </button>
        <button role="tab" aria-selected={tab === "goal"} className={`work-tab${tab === "goal" ? " on" : ""}`} onClick={() => setTab("goal")}>
          <Sparkles size={14} /> From a goal <span className="work-tab-hint">— AI drafts several</span>
        </button>
      </div>

      {tab === "one" ? (
        <div className="work-form">
          <label className="work-label">Title</label>
          <input className="input" autoFocus placeholder="e.g. Add a dark-mode toggle to the header"
            value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addOne(); } }} />
          <label className="work-label">Details <span className="work-label-hint">— write freely, or let AI expand it</span></label>
          <textarea className="input addticket-notes" placeholder="A few notes on what to build and when it's done…"
            value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="addticket-actions">
            <Button kind="btn" autoPending onClick={complete} disabled={completing || (!title.trim() && !notes.trim())}
              title="Let the model expand your notes into a Goal + Done-when checklist">
              <Sparkles size={14} /> {completing ? "Thinking…" : "Complete with AI"}
            </Button>
            <div className="spacer" />
            <Button kind="btn" variant="primary" autoPending onClick={addOne} disabled={!title.trim()}>
              <Plus size={14} /> Add to Up next
            </Button>
          </div>
        </div>
      ) : (
        <div className="work-form">
          <label className="work-label">What do you want done?</label>
          <textarea className="input work-goal" placeholder="One or two sentences. The planner explores the repo and drafts the tickets."
            value={goal} onChange={(e) => setGoal(e.target.value)} />
          <div className="work-draft-row">
            <button className="btn primary" disabled={planning} onClick={() => void startPlan()}>
              {planning ? "Planning… (exploring your repo)" : <><Sparkles size={14} /> Draft tickets with AI</>}
            </button>
          </div>
          {planning && <PlanProgress output={planOut} startMs={planStart} />}
        </div>
      )}

      {tickets.length > 0 && (
        <div className="work-backlog">
          <h2>Tickets ready ({tickets.length})</h2>
          {tickets.map((t) => (
            <div key={t.file} className="ticket-row">
              {editing === t.file ? (
                <>
                  <textarea className="input ticket-editor" value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <button className="btn primary" onClick={async () => {
                    try { await postJSON(`/api/backlog/${encodeURIComponent(t.file)}`, { content: draft }); toast("Ticket saved."); setEditing(null); void refreshBacklog(); }
                    catch (err) { toast(String(err), true); }
                  }}>Save</button>
                </>
              ) : (
                <>
                  <div className="ticket-title">{ticketTitle(t.content)}<span className="ticket-file"> {t.file}</span></div>
                  <TicketTune ticket={t} onSaved={() => void refreshBacklog()} />
                  <div className="card-actions">
                    <button className="btn ghost" onClick={() => { setEditing(t.file); setDraft(t.content); }}>Edit</button>
                    <ConfirmButton label="Delete" confirm="Sure?" onConfirm={async () => {
                      await fetchJSON(`/api/backlog/${encodeURIComponent(t.file)}`, { method: "DELETE" }); toast("Ticket deleted."); void refreshBacklog();
                    }} />
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="work-launch">
            <label className="work-label inline">Parallel agents</label>
            <input type="number" min="1" className="input num" value={slots} onChange={(e) => setSlots(Number(e.target.value) || 3)} />
            <button className="btn primary" onClick={() => void startRun()}><Play size={14} /> Start run</button>
          </div>
        </div>
      )}
      </>)}
    </Modal>
  );
}

/** Edit a ticket that hasn't started yet — an AI draft in Up next or a manual
 *  ticket the dev owns. Both are just backlog .md files, so we edit title + body
 *  in place and keep every flag already on them. A running/merged task has no
 *  backlog file to edit, so it never reaches here. */
function EditTicketModal(
  { ticket, onSave, onClose }:
  { ticket: BoardTicket; onSave: (content: string) => Promise<void>; onClose: () => void },
): JSX.Element {
  const [title, setTitle] = useState(ticket.title === "(untitled)" ? "" : ticket.title);
  const [body, setBody] = useState(ticketBody(ticket.content));
  const save = async (): Promise<void> => {
    if (!title.trim()) { toast("Give the ticket a title.", true); return; }
    await onSave(withTitleAndBody(ticket.content, title.trim(), body));
    onClose();
  };
  return (
    <Modal title={`Edit ticket ${ticket.id}`} onClose={onClose} wide>
      <div className="work-form">
        <label className="work-label">Title</label>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
        <label className="work-label">Details</label>
        <textarea className="input addticket-notes" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="addticket-actions">
          <span className="hint">{ticket.assignee === "human"
            ? "Your ticket — the AI won't touch it."
            : "Not started yet, so it's safe to edit."}</span>
          <div className="spacer" />
          <Button kind="btn" variant="primary" autoPending onClick={save} disabled={!title.trim()}>
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------- projects landing --------------------------------- */

interface PortfolioProject {
  name: string; workdir: string; currentRun: string | null; running: boolean;
  counts: { queued: number; working: number; needs: number; merged: number };
  total: number; spend: number; tokens: number; budget: number | null; ended: boolean; updatedTs: string | null;
}

/** Derive a single at-a-glance status for a whole project from its counts. */
function projStatus(c: PortfolioProject["counts"]): { fam: string; label: string } {
  if (c.needs > 0) return { fam: "blocked", label: "Needs you" };
  if (c.working > 0) return { fam: "working", label: "Working" };
  if (c.queued > 0) return { fam: "upnext", label: "Up next" };
  if (c.merged > 0) return { fam: "merged", label: "Up to date" };
  return { fam: "upnext", label: "No run yet" };
}

type ThemeMode = "system" | "light" | "dark";

interface Appearance {
  dark: boolean;
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
  accent: string;
  setAccent: (a: string) => void;
  density: string;
  setDensity: (d: string) => void;
  compactHeader: boolean;
  setCompactHeader: (v: boolean) => void;
}

const ACCENTS: Array<[string, string]> = [
  ["indigo", "#6366f1"], ["teal", "#0d9488"], ["orange", "#ea580c"], ["violet", "#7c3aed"],
];

function readPref(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

/** Appearance: theme (light/dark/follow-OS), accent colour and density — all
 *  persisted and applied to <html> via data-attributes the CSS keys off. */
function useTheme(): Appearance {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const s = readPref("factory.theme", "system");
    return s === "dark" || s === "light" || s === "system" ? s : "system";
  });
  const [accent, setAccentState] = useState(() => readPref("factory.accent", "indigo"));
  const [density, setDensityState] = useState(() => readPref("factory.density", "comfortable"));
  const [compactHeader, setCompactHeaderState] = useState(() => readPref("factory.headerCompact", "0") === "1");
  const [sysDark, setSysDark] = useState<boolean>(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // Follow the OS live while in "system" mode.
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => setSysDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const dark = mode === "dark" || (mode === "system" && sysDark);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
    document.documentElement.setAttribute("data-density", density);
    document.documentElement.setAttribute("data-header", compactHeader ? "compact" : "full");
  }, [accent, density, compactHeader]);

  const persist = (key: string, value: string): void => {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  };
  return {
    dark, mode, accent, density, compactHeader,
    setMode: (m) => { setModeState(m); persist("factory.theme", m); },
    setAccent: (a) => { setAccentState(a); persist("factory.accent", a); },
    setDensity: (d) => { setDensityState(d); persist("factory.density", d); },
    setCompactHeader: (v) => { setCompactHeaderState(v); persist("factory.headerCompact", v ? "1" : "0"); },
    toggle: () => { const m = dark ? "light" : "dark"; setModeState(m); persist("factory.theme", m); },
  };
}

function AppearanceButton({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <button className="hbtn icon-btn" aria-label="Appearance settings" title="Appearance — theme, accent, density" onClick={onOpen}><Palette size={16} /></button>
  );
}

/** Theme mode, accent colour and density picker. Global UI prefs, not per-project. */
function AppearanceModal({ theme, onClose }: { theme: Appearance; onClose: () => void }): JSX.Element {
  const modes: Array<[ThemeMode, string]> = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
  const densities: Array<[string, string]> = [["comfortable", "Comfortable"], ["compact", "Compact"]];
  return (
    <Modal title="Appearance" onClose={onClose}>
      <div className="appearance-form">
        <div className="appearance-group">
          <span className="appearance-label">Theme</span>
          <div className="seg-choice">
            {modes.map(([v, l]) => (
              <button key={v} className={`seg-opt${theme.mode === v ? " on" : ""}`} onClick={() => theme.setMode(v)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="appearance-group">
          <span className="appearance-label">Accent</span>
          <div className="swatches">
            {ACCENTS.map(([name, color]) => (
              <button key={name} className={`swatch${theme.accent === name ? " on" : ""}`}
                style={{ background: color }} title={name} aria-label={name}
                onClick={() => theme.setAccent(name)} />
            ))}
          </div>
        </div>
        <div className="appearance-group">
          <span className="appearance-label">Density</span>
          <div className="seg-choice">
            {densities.map(([v, l]) => (
              <button key={v} className={`seg-opt${theme.density === v ? " on" : ""}`} onClick={() => theme.setDensity(v)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="appearance-group">
          <span className="appearance-label">Header</span>
          <div className="seg-choice">
            <button className={`seg-opt${!theme.compactHeader ? " on" : ""}`} onClick={() => theme.setCompactHeader(false)}>Full</button>
            <button className={`seg-opt${theme.compactHeader ? " on" : ""}`} onClick={() => theme.setCompactHeader(true)}>Compact</button>
          </div>
          <span className="appearance-hint">Compact hides the progress bar and usage panel so the board gets more room.</span>
        </div>
      </div>
    </Modal>
  );
}

/** The slim sticky bar shared by the Projects and Memory screens. */
function AppBar(
  { active, factCount, narrow, newLabel, theme, onProjects, onMemory, onNew, onAppearance }:
  {
    active: "projects" | "memory"; factCount?: number; narrow?: boolean; newLabel: string;
    theme: Appearance;
    onProjects: () => void; onMemory: () => void; onNew: () => void; onAppearance: () => void;
  },
): JSX.Element {
  return (
    <header className="appbar">
      <div className={`appbar-inner${narrow ? " narrow" : ""}`}>
        <div className="brand">
          <div className="brand-logo"><i /></div>
          <div className="brand-txt">
            <span className="brand-name">Agent Factory</span>
            <span className="brand-sub">Local execution</span>
          </div>
        </div>
        <div className="nav-pills">
          <button className={`nav-pill${active === "projects" ? " on" : ""}`} onClick={onProjects}>Projects</button>
          <button className={`nav-pill${active === "memory" ? " on" : ""}`} onClick={onMemory}>
            Memory{factCount !== undefined && <span className="nav-count">{factCount}</span>}
          </button>
        </div>
        <div className="spacer" />
        <AppearanceButton onOpen={onAppearance} />
        <button className="hbtn accent" onClick={onNew}><span className="plus">+</span> {newLabel}</button>
      </div>
    </header>
  );
}

/** Big page title + synthesis dot + optional lead text and stat tiles on the right. */
function PageHead(
  { title, synthFam, synth, lead, stats }:
  { title: string; synthFam: string; synth: string; lead?: string; stats?: ReactNode },
): JSX.Element {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        <div className="page-synth">
          <span className="halo" aria-hidden="true" style={{ background: `var(--st-${synthFam}-dot)`, boxShadow: `0 0 0 4px var(--st-${synthFam}-bg)` }} />
          <b>{synth}</b>
        </div>
        {lead && <p className="page-lead">{lead}</p>}
      </div>
      {stats && <div className="stat-tiles">{stats}</div>}
    </div>
  );
}

/** One stat tile (value + label); value colour is data-driven. */
function StatTile({ value, label, color }: { value: ReactNode; label: string; color?: string }): JSX.Element {
  return (
    <div className="stat-tile">
      <span className="st-v" style={color ? { color } : undefined}>{value}</span>
      <span className="st-l">{label}</span>
    </div>
  );
}

function SegBar({ segs }: { segs: Array<{ pct: number; color: string }> }): JSX.Element {
  return (
    <div className="seg-bar">
      {segs.map((s, i) => <div key={i} style={{ width: `${s.pct}%`, background: s.color }} />)}
    </div>
  );
}

function ProjectCard({ p, onOpen, onEdit }: { p: PortfolioProject; onOpen: () => void; onEdit: () => void }): JSX.Element {
  const c = p.counts;
  const st = projStatus(c);
  const tot = c.merged + c.working + c.needs + c.queued || 1;
  const segs = [
    { count: c.merged, color: "var(--st-merged-dot)" },
    { count: c.working, color: "var(--st-working-dot)" },
    { count: c.needs, color: "var(--st-failed-dot)" },
    { count: c.queued, color: "var(--st-upnext-dot)" },
  ].filter((x) => x.count > 0).map((x) => ({ pct: (x.count / tot) * 100, color: x.color }));
  const bpct = p.budget ? Math.min(100, (p.spend / p.budget) * 100) : 0;
  const bcls = bpct >= 90 ? "over" : bpct >= 70 ? "warn" : "";
  const metric = (n: number, label: string, fam: string) => (
    <div className="pm">
      <span className="pm-n" style={{ color: n > 0 ? `var(--st-${fam}-fg)` : "var(--faint)" }}>{n}</span>
      <span className="pm-l">{label}</span>
    </div>
  );
  return (
    <div className={`proj-card${c.needs > 0 ? " attention" : ""}`} onClick={onOpen}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      <div className="proj-head">
        <div className="proj-name">{p.name}</div>
        <button className="proj-edit" aria-label="Edit or remove this project" title="Edit or remove this project"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}><MoreHorizontal size={16} /></button>
        <span className={`pill fam-${st.fam}`}>{st.label}</span>
      </div>
      <div className="proj-repo mono">{p.workdir.split(/[\\/]/).pop()}</div>
      {segs.length > 0 ? <SegBar segs={segs} /> : <div className="seg-bar empty" />}
      <div className="proj-metrics">
        {metric(c.working, "working", "working")}
        {metric(c.needs, "attention", "failed")}
        {metric(c.queued, "up next", "upnext")}
        {metric(c.merged, "merged", "merged")}
      </div>
      {p.budget !== null && p.budget > 0 && (
        <div className="proj-budget">
          <div className="budget-bar"><div className={`budget-fill ${bcls}`} style={{ width: `${bpct}%` }} /></div>
          <span className="budget-cap">{fmtUsd(p.spend)} / {fmtUsd(p.budget)}</span>
        </div>
      )}
      <div className="proj-foot">
        <span className="proj-updated">{p.updatedTs ? `updated ${ago(p.updatedTs)}` : "no activity"}</span>
        <span className="proj-open">Open <ArrowRight size={13} /></span>
      </div>
    </div>
  );
}

/** Polls the cross-workspace portfolio digest every few seconds. */
function usePortfolio(): { projects: PortfolioProject[] | null; reload: () => void } {
  const [projects, setProjects] = useState<PortfolioProject[] | null>(null);
  const mounted = useRef(true);
  const reload = useCallback(async (): Promise<void> => {
    try { const r = await fetchJSON<{ projects: PortfolioProject[] }>("/api/portfolio"); if (mounted.current) setProjects(r.projects); }
    // A transient poll failure must NOT wipe the list — that would flip a user
    // with N projects into the onboarding wizard for one bad 4s tick. Keep the
    // last good data (or stay in the "Loading…" null state if we never loaded).
    catch { /* keep the previous projects */ }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const id = setInterval(() => void reload(), 4000);
    return () => { mounted.current = false; clearInterval(id); };
  }, [reload]);
  return { projects, reload: () => void reload() };
}

/** First-launch assistant (C4): create the very first project without a terminal
 *  — point at a repo (or start fresh), pick the stack + budget, and land in the
 *  cockpit ready to draft work. Reuses the same endpoints as the manual flow. */
function Onboarding({ onOpen, onCreated }: { onOpen: (name: string) => void; onCreated: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [fresh, setFresh] = useState(false);
  const [project, setProject] = useState<Settings["project"]>("node");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);

  const setupFor: Record<Settings["project"], string> = {
    node: "npm install", python: "uv sync", other: "",
  };
  const nameOk = /^[a-zA-Z0-9_-]+$/.test(name.trim());
  const ready = nameOk && folder.trim() && !busy;

  const create = async (): Promise<void> => {
    setBusy(true);
    const ws = name.trim(), dir = folder.trim();
    try {
      if (fresh) await postJSON("/api/repo/init", { path: dir });
      await postJSON("/api/workspaces", { name: ws, workdir: dir });
      const cfg = generateConfig({
        slots: 3, internet: false, project, setupCommands: setupFor[project],
        integrationCommands: "", reviewer: false, reviewerModel: "haiku", planModel: "",
        model: "", effort: "", maxRetries: 1, budgetUsd: budget.trim(), manualApproval: false,
        prNative: false, webhookUrl: "", executionMode: "subscription", isolation: "direct",
        knowledge: false,
      });
      await scopedJSON("/api/config", ws, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: cfg }),
      });
      setRepoPath(dir); setWs(ws);
      onCreated();
      toast(`Project “${ws}” is ready.`);
      onOpen(ws);
    } catch (err) { toast(String(err), true); setBusy(false); }
  };

  return (
    <div className="onboard">
      <div className="onboard-card">
        <h1>Welcome — let's set up your first project.</h1>
        <p className="hint">A project is a work folder the factory drives agents against. No terminal needed.</p>

        <label className="work-label">Project name</label>
        <input className="input" placeholder="my-project" value={name} onChange={(e) => setName(e.target.value)} />
        {name.trim() && !nameOk && <p className="onboard-warn">Use only letters, numbers, dashes or underscores.</p>}

        <label className="work-label">Repository / work folder</label>
        <input className="input" placeholder="C:\\path\\to\\your\\repo" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <div className="seg onboard-seg">
          <button className={!fresh ? "on" : ""} onClick={() => setFresh(false)}>Use an existing repo</button>
          <button className={fresh ? "on" : ""} onClick={() => setFresh(true)}>Start fresh here</button>
        </div>
        {fresh && <p className="hint">The folder is created and <code>git init</code>'d with a first commit.</p>}

        <label className="work-label">Stack</label>
        <div className="seg onboard-seg">
          {(["node", "python", "other"] as const).map((p) => (
            <button key={p} className={project === p ? "on" : ""} onClick={() => setProject(p)}>
              {p === "node" ? "Node / JS" : p === "python" ? "Python" : "Other"}
            </button>
          ))}
        </div>

        <label className="work-label">Budget (USD, optional)</label>
        <input className="input num" type="number" min="0" placeholder="no cap" value={budget} onChange={(e) => setBudget(e.target.value)} />

        <button className="btn primary onboard-go" disabled={!ready} onClick={() => void create()}>
          {busy ? "Setting up…" : <>Create project <ArrowRight size={14} /></>}
        </button>
      </div>
    </div>
  );
}

/** Rename a project, set its per-project budget, or remove it from the dashboard. */
function ProjectEditor(
  { p, canDelete, onClose, onChanged }:
  { p: PortfolioProject; canDelete: boolean; onClose: () => void; onChanged: () => void },
): JSX.Element {
  const [name, setName] = useState(p.name);
  const [budget, setBudget] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void scopedJSON<{ content: string }>("/api/config", p.name)
      .then(({ content }) => {
        const s = parseSettings(content);
        setBudget(s.budgetUsd ? String(s.budgetUsd) : "");
      })
      .catch(() => { /* no config yet — budget stays blank (no cap) */ })
      .finally(() => setLoaded(true));
  }, [p.name]);

  const save = async (): Promise<void> => {
    const newName = name.trim();
    if (!newName) { toast("A project needs a name.", true); return; }
    try {
      // Persist the budget into this project's own factory.yaml, then rename.
      const trimmed = budget.trim();
      const cap = trimmed === "" ? null : Number(trimmed);
      if (cap !== null && (!Number.isFinite(cap) || cap < 0)) throw new Error("budget must be a positive number");
      const { content } = await scopedJSON<{ content: string }>("/api/config", p.name);
      const s = parseSettings(content);
      await scopedJSON("/api/config", p.name, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: generateConfig({ ...s, budgetUsd: cap === null ? "" : String(cap) }) }),
      });
      if (newName !== p.name) {
        await fetchJSON(`/api/workspaces/${encodeURIComponent(p.name)}`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: newName }),
        });
      }
      toast("Project updated."); onChanged();
    } catch (err) { toast(String(err), true); }
  };

  const remove = async (): Promise<void> => {
    try {
      await fetchJSON(`/api/workspaces/${encodeURIComponent(p.name)}`, { method: "DELETE" });
      toast(`Removed ${p.name} from the dashboard. Its files stay on disk.`); onChanged();
    } catch (err) { toast(String(err), true); }
  };

  return (
    <Modal title={`Edit ${p.name}`} onClose={onClose}>
      <div className="work-form">
        <label className="work-label">Project name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="proj-edit-repo">Repository: <span className="mono">{p.workdir}</span></div>
        <label className="work-label">Budget cap (USD) — this project only</label>
        <input className="input num" type="number" min="0" step="1" value={budget}
          placeholder={loaded ? "no cap" : "loading…"} disabled={!loaded}
          onChange={(e) => setBudget(e.target.value)} />
        <p className="work-hint">The run stops launching new agents once this project's spend reaches the cap. Blank means no cap.</p>
      </div>
      <div className="panel-foot spread modal-foot">
        {canDelete
          ? <ConfirmButton label="Remove project" confirm="Sure? Click again" onConfirm={() => void remove()} />
          : <span className="work-hint">The last project can't be removed.</span>}
        <button className="btn primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

interface NetInfo { ip: string | null; port: number; url: string | null }

/**
 * "Open on your phone" card: shows a QR of the dashboard's LAN URL so the user
 * can point a phone camera at the screen and open the cockpit on the same Wi-Fi.
 * Hidden entirely when the machine has no reachable LAN address (e.g. offline).
 * The QR is drawn by our zero-dependency encoder (byte-mode, oracle-verified).
 */
function PhoneCard({ theme }: { theme: Appearance }): JSX.Element | null {
  const [net, setNet] = useState<NetInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem("factory.phonecard") === "off"; } catch { return false; }
  });
  useEffect(() => {
    let alive = true;
    fetchJSON<NetInfo>("/api/netinfo").then((n) => { if (alive) setNet(n); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (dismissed || !net?.url) return null;
  const dark = theme.dark ? "#e8eaed" : "#111";
  const svg = qrSvg(net.url, { ec: "M", scale: 5, border: 2, dark, light: "transparent" });
  const dismiss = (): void => {
    setDismissed(true);
    try { localStorage.setItem("factory.phonecard", "off"); } catch { /* ignore */ }
  };
  const copy = (): void => {
    void navigator.clipboard?.writeText(net.url!).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="phone-card">
      <div className="phone-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="phone-body">
        <div className="phone-title"><Smartphone size={16} /> Open on your phone</div>
        <div className="phone-sub">Scan with your camera on the same Wi-Fi to drive the factory from your phone.</div>
        <button className="phone-url" onClick={copy} title="Copy URL">
          <code>{net.url}</code>
          <span className="phone-copy">{copied ? <><Check size={12} /> copied</> : "copy"}</span>
        </button>
      </div>
      <button className="phone-x" onClick={dismiss} title="Dismiss" aria-label="Dismiss">×</button>
    </div>
  );
}

function ProjectsScreen(
  { theme, onOpen, onMemory }:
  { theme: Appearance; onOpen: (name: string) => void; onMemory: () => void },
): JSX.Element {
  const { projects, reload } = usePortfolio();
  const [showNew, setShowNew] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [editing, setEditing] = useState<PortfolioProject | null>(null);
  const list = projects ?? [];
  const working = list.reduce((s, p) => s + p.counts.working, 0);
  const need = list.filter((p) => p.counts.needs > 0).length;
  const spend = list.reduce((s, p) => s + p.spend, 0);
  const synth = need > 0 ? `${need} project${need > 1 ? "s need" : " needs"} you` : "Everything is under control";

  return (
    <>
      <AppBar active="projects" newLabel="New project" theme={theme} onProjects={() => {}} onMemory={onMemory} onNew={() => setShowNew(true)} onAppearance={() => setShowAppearance(true)} />
      <div className="page">
        <PageHead title="Your projects" synthFam={need > 0 ? "blocked" : "merged"} synth={synth}
          stats={<>
            <StatTile value={list.length} label="Projects" />
            <StatTile value={working} label="Agents working" color="var(--st-working-fg)" />
            <StatTile value={need} label="Need you" color={need > 0 ? "var(--st-failed-fg)" : undefined} />
            <StatTile value={fmtUsd(spend)} label="Spent" />
          </>} />

        {list.length > 0 && <PhoneCard theme={theme} />}

        {projects === null ? (
          <div className="empty-state" style={{ alignSelf: "stretch" }}><Skeleton lines={4} /></div>
        ) : list.length === 0 ? (
          <Onboarding onOpen={onOpen} onCreated={reload} />
        ) : (
          <div className="proj-grid">
            {list.map((p) => <ProjectCard key={p.name} p={p} onOpen={() => onOpen(p.name)} onEdit={() => setEditing(p)} />)}
            <button className="proj-new" onClick={() => setShowNew(true)}><span className="plus-lg">+</span> New project</button>
          </div>
        )}
      </div>
      {showNew && <NewWorkModal variant="project" onClose={() => setShowNew(false)} onWorkspaceAdded={() => { /* the portfolio poll picks it up */ }} />}
      {editing && (
        <ProjectEditor p={editing} canDelete={list.length > 1}
          onClose={() => setEditing(null)}
          onChanged={() => { setEditing(null); reload(); }} />
      )}
      {showAppearance && <AppearanceModal theme={theme} onClose={() => setShowAppearance(false)} />}
    </>
  );
}

/* --------------------------------- memory (learned facts) --------------------------------- */

interface Fact { id: string; text: string; scope: "project" | "global"; ticketId: string | null; createdTs: string; applied?: number }

/** Show exactly what an agent changed for a merged ticket (B5). The range
 *  survives the deleted branch because both commits hang off the merge commit. */
function DiffModal(
  { taskId, title, diff, onClose }:
  { taskId: string; title: string; diff: { repo: string; from: string; to: string }; onClose: () => void },
): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams({ repo: diff.repo, from: diff.from, to: diff.to });
    fetchJSON<{ diff: string }>(`/api/repo/diff?${qs}`)
      .then((r) => setText(r.diff))
      .catch((e) => setErr(String(e)));
  }, [diff.repo, diff.from, diff.to]);
  return (
    <Modal title={`Diff — ${taskId}`} onClose={onClose} wide>
      <div className="diff-title">{title}</div>
      {err ? <p className="hint">Couldn't load the diff: {err}</p>
        : text === null ? <Skeleton lines={4} />
        : text.trim() === "" ? <p className="hint">No file changes recorded for this ticket.</p>
        : <Diff text={text} />}
    </Modal>
  );
}

/** The pépite: review a ticket awaiting approval, pin comments to diff lines,
 *  then approve the merge or send every comment back to the agent as one
 *  "changes" instruction. GitHub-style review — but the reviewee is an agent. */
function ReviewModal({ task, onClose }: { task: TaskModel; onClose: () => void }): JSX.Element {
  const diff = task.diff!;
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [composing, setComposing] =
    useState<{ file: string; key: string; line: number | null; snippet: string } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    const qs = new URLSearchParams({ repo: diff.repo, from: diff.from, to: diff.to });
    fetchJSON<{ diff: string }>(`/api/repo/diff?${qs}`).then((r) => setText(r.diff)).catch((e) => setErr(String(e)));
  }, [diff.repo, diff.from, diff.to]);
  useEsc(() => { if (composing) setComposing(null); else onClose(); });

  const review: ReviewProps = {
    comments,
    composingKey: composing?.key ?? null,
    onStart: (file, key, line, snippet) => setComposing({ file, key, line, snippet }),
    onCancel: () => setComposing(null),
    onSubmit: (t) => {
      if (composing) setComments((cs) => [...cs, { id: ++commentSeq, ...composing, text: t }]);
      setComposing(null);
    },
    onRemove: (id) => setComments((cs) => cs.filter((c) => c.id !== id)),
  };

  // One instruction the agent can act on: the general note, then each pinned
  // comment with its file, line and the exact code it refers to.
  const compile = (): string => {
    const parts: string[] = [];
    if (note.trim()) parts.push(note.trim());
    for (const c of comments) {
      parts.push(`In ${c.file}${c.line != null ? `:${c.line}` : ""} — ${c.text}\n    > ${c.snippet.trim()}`);
    }
    return parts.join("\n\n");
  };
  const hasFeedback = comments.length > 0 || note.trim().length > 0;

  return (
    <Modal title={`Review — ${task.id}`} onClose={onClose} wide>
      <div className="review-head">
        <div className="diff-title">{task.title}</div>
        <div className="review-sub">
          Ready for your review. Click the <span className="mono">+</span> on a line to pin a comment
          {comments.length > 0 ? ` — ${comments.length} comment${comments.length > 1 ? "s" : ""}.` : "."}
        </div>
      </div>
      {err ? <p className="hint">Couldn't load the diff: {err}</p>
        : text === null ? <Skeleton lines={4} />
        : text.trim() === "" ? <p className="hint">No file changes recorded for this ticket.</p>
        : <Diff text={text} review={review} />}
      <textarea className="input review-note" placeholder="General comment (optional)…"
        value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="panel-foot spread review-foot">
        <button className="btn danger" disabled={!hasFeedback}
          onClick={() => { void sendControl("changes", task.id, compile()); onClose(); }}>
          Request changes{comments.length > 0 ? ` (${comments.length})` : ""}
        </button>
        <button className="btn primary"
          onClick={() => { void sendControl("approve", task.id); onClose(); }}>
          Approve and merge
        </button>
      </div>
    </Modal>
  );
}

/** Pre-run guard rail (B7): what will run, the budget in force, and a cost
 *  estimate from past runs — so a re-run never burns credits by surprise. */
function RunGuardModal(
  { runnable, budgetUsd, avgCost, onConfirm, onClose, onSettings }:
  { runnable: number; budgetUsd: number | null; avgCost: number | null;
    onConfirm: () => void | Promise<void>; onClose: () => void; onSettings: () => void },
): JSX.Element {
  const estimate = avgCost !== null ? avgCost * runnable : null;
  const noCap = budgetUsd === null || budgetUsd <= 0;
  // The guard is about the NEXT run, so read the current setting (not the last
  // run's mode) — a toggle saved but not yet run must still warn.
  const [apiMode, setApiMode] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [dockerReady, setDockerReady] = useState<boolean | null>(null);
  useEffect(() => {
    void fetchJSON<{ content: string }>("/api/config")
      .then((r) => {
        const s = parseSettings(r.content);
        setApiMode(s.executionMode === "api");
        setSandbox(s.isolation === "sandbox");
      })
      .catch(() => { /* offline */ });
  }, []);
  useEffect(() => {
    if (!sandbox) { setDockerReady(null); return; }
    void fetchJSON<DockerStatus>("/api/docker")
      .then((d) => setDockerReady(Boolean(d.engine) && Boolean(d.image)))
      .catch(() => setDockerReady(false));
  }, [sandbox]);
  return (
    <Modal title="Start this run?" onClose={onClose}>
      <div className="work-form">
        <div className="run-guard-line">
          <span className="rg-n">{runnable}</span>
          <span>ticket{runnable === 1 ? "" : "s"} will run (everything not yet merged).</span>
        </div>
        {apiMode && (
          <div className="run-guard-budget warn">
            <Key size={14} /> <b>API mode</b> — this run bills real dollars to your <code>ANTHROPIC_API_KEY</code>.
            <button className="btn link" onClick={onSettings}>Switch to Subscription</button>
          </div>
        )}
        {sandbox && (
          dockerReady === false ? (
            <div className="run-guard-budget warn">
              <Lock size={14} /> <b>Sandbox selected, but Docker isn't ready</b> — the run will fail until the engine is up and the image is built.
              <button className="btn link" onClick={onSettings}>Fix in Settings</button>
            </div>
          ) : (
            <div className="run-guard-budget">
              <Lock size={14} /> <b>Sandbox mode</b> — agents run confined: only their worktree is visible, egress limited to Anthropic.
            </div>
          )
        )}
        {estimate !== null
          ? <p className="work-hint">Your past runs averaged <b>{fmtUsd(avgCost!)}</b> per merged ticket — so roughly <b>{fmtUsd(estimate)}</b> for this run. A rough guide, not a quote.</p>
          : <p className="work-hint">No cost history yet, so I can't estimate this one.</p>}
        <div className={`run-guard-budget${noCap ? " warn" : ""}`}>
          {noCap
            ? <>No budget cap — this run can spend without a limit. <button className="btn link" onClick={onSettings}>Set a cap</button></>
            : <>Budget cap in force: <b>{fmtUsd(budgetUsd!)}</b>. The run stops launching new agents once it's reached.</>}
        </div>
      </div>
      <div className="panel-foot spread modal-foot">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <Button kind="btn" variant="primary" autoPending onClick={onConfirm}><Play size={14} /> Start run</Button>
      </div>
    </Modal>
  );
}

/** Compose an answer to a blocked agent and thread it back on re-run. */
// Destructive / history-rewriting git the agent must never run itself. If its
// question mentions one, we warn the operator NOT to just approve it (the op is
// blocked at the tool layer anyway) and steer them to guide the agent instead.
const DESTRUCTIVE_HINT = /\b(reset\s+--hard|--force|force-with-lease|git\s+rebase|git\s+clean|filter-branch|checkout\s+--)\b/i;

// Safe, pre-wired replies. They fill the answer box (the operator still reviews and
// sends — control stays with the human) instead of running anything directly.
const QUICK_REPLIES: Array<{ label: string; text: string }> = [
  { label: "Already done → no-op",
    text: "The ticket's change already exists in the repo. Do NOT reset, rebase, or "
      + "force anything. Report status \"done\" with \"noop\": true (already implemented)." },
  { label: "Don't rewrite history",
    text: "Do not run any destructive git command (reset --hard, rebase, force, clean). "
      + "Explain in one line what is actually missing, or report done/noop if nothing is." },
];

function AnswerModal(
  { taskId, title, question, context, onClose }:
  { taskId: string; title: string; question: string; context: BlockedContext | null;
    onClose: () => void },
): JSX.Element {
  const [text, setText] = useState("");
  const send = async (): Promise<void> => {
    if (!text.trim()) { toast("Write your answer first.", true); return; }
    await sendAnswer(taskId, text.trim());
    onClose();
  };
  const destructive = DESTRUCTIVE_HINT.test(question);
  return (
    <Modal title={`Answer ${taskId}`} onClose={onClose}>
      <div className="work-form">
        <div className="answer-title">{title}</div>
        {question && (
          <div className="answer-question"><span className="flag">?</span><span>{question}</span></div>
        )}
        {destructive && (
          <div className="answer-warn">
            <TriangleAlert size={14} /> This agent wants to run a destructive git command. It is blocked at the tool
            layer — don't approve it. Guide it, or do the git yourself if it's truly needed.
          </div>
        )}
        {context && (
          <div className="answer-facts">
            <div className="facts-head">Git ground truth <span className="facts-sub">when it blocked</span></div>
            <div className="facts-row">
              <span className={`facts-pill ${context.clean ? "ok" : "warn"}`}>
                {context.clean ? "working tree clean" : "uncommitted changes"}
              </span>
              <span className={`facts-pill ${context.commits === 0 ? "warn" : "ok"}`}>
                {context.commits} new commit{context.commits === 1 ? "" : "s"}
              </span>
              {context.commits === 0 && context.clean && (
                <span className="facts-note">nothing to lose — likely already implemented</span>
              )}
            </div>
            {context.diffstat.length > 0 && (
              <pre className="facts-pre">{context.diffstat.join("\n")}</pre>
            )}
            {context.status.length > 0 && (
              <pre className="facts-pre">{context.status.join("\n")}</pre>
            )}
          </div>
        )}
        <div className="answer-quick">
          {QUICK_REPLIES.map((q) => (
            <button key={q.label} className="chip" type="button"
              onClick={() => setText(q.text)}>{q.label}</button>
          ))}
        </div>
        <label className="work-label">Your answer</label>
        <textarea className="input fact-text-input" value={text} autoFocus
          placeholder="Answer the agent's question — it restarts with your reply as context…"
          onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="panel-foot spread modal-foot">
        <span className="answer-hint">The task goes back in the queue and runs again with your answer.</span>
        <button className="btn primary" onClick={() => void send()}>Send answer</button>
      </div>
    </Modal>
  );
}

function FactEditor(
  { fact, tasks, draft, onClose, onSaved }:
  { fact: Fact | "new"; tasks: TaskModel[]; draft?: { text: string; ticketId: string };
    onClose: () => void; onSaved: () => void },
): JSX.Element {
  const isNew = fact === "new";
  const f = isNew ? null : fact;
  const [text, setText] = useState(f?.text ?? draft?.text ?? "");
  const [scope, setScope] = useState<"project" | "global">(f?.scope ?? "project");
  const [ticketId, setTicketId] = useState(f?.ticketId ?? draft?.ticketId ?? "");

  const save = async (): Promise<void> => {
    if (!text.trim()) { toast("Write the lesson first.", true); return; }
    const body = { text: text.trim(), scope, ticketId: ticketId || null };
    try {
      if (isNew) await postJSON("/api/memory", body);
      else await fetchJSON(`/api/memory/${encodeURIComponent(f!.id)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      toast("Lesson saved."); onSaved(); onClose();
    } catch (err) { toast(String(err), true); }
  };
  const remove = async (): Promise<void> => {
    try { await fetchJSON(`/api/memory/${encodeURIComponent(f!.id)}`, { method: "DELETE" }); toast("Lesson deleted."); onSaved(); onClose(); }
    catch (err) { toast(String(err), true); }
  };

  return (
    <Modal title={isNew ? "Add a lesson" : "Edit lesson"} onClose={onClose}>
      <div className="work-form">
        <label className="work-label">The lesson / rule learned</label>
        <textarea className="input fact-text-input" value={text} placeholder="e.g. always check test data matches the mockup before review…"
          onChange={(e) => setText(e.target.value)} />
        <div className="field-row">
          <div className="field">
            <label className="work-label">Scope</label>
            <select className="picker wide" value={scope} onChange={(e) => setScope(e.target.value as "project" | "global")}>
              <option value="project">This project only</option>
              <option value="global">All projects (global)</option>
            </select>
          </div>
          <div className="field">
            <label className="work-label">Origin ticket</label>
            <select className="picker wide" value={ticketId} onChange={(e) => setTicketId(e.target.value)}>
              <option value="">— None (manual) —</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="panel-foot spread modal-foot">
        {!isNew ? <ConfirmButton label="Delete" confirm="Sure? Click again" onConfirm={() => void remove()} /> : <span />}
        <button className="btn primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

function FactCard({ f, onEdit }: { f: Fact; onEdit: () => void }): JSX.Element {
  return (
    <div className="fact-card">
      <div className="fact-text">{f.text}</div>
      <div className="fact-foot">
        <span className={`pill fam-${f.scope === "global" ? "working" : "upnext"}`}>
          {f.scope === "global" ? "Global" : "This project"}
        </span>
        {f.ticketId && <span className="fact-ticket mono"><CornerDownLeft size={12} /> {f.ticketId}</span>}
        {f.applied ? <span className="fact-used" title="How often this lesson was fed to an agent">used {f.applied}×</span> : null}
        <span className="fact-when">{ago(f.createdTs)}</span>
        <button className="btn link fact-edit" onClick={onEdit}>edit</button>
      </div>
    </div>
  );
}

/** Loads the merged (global + project) learned facts for a workspace. */
function useFacts(ws: string): { facts: Fact[] | null; reload: () => void } {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    try { const r = await fetchJSON<{ facts: Fact[] }>("/api/memory"); setFacts(r.facts); }
    // Don't turn a fetch error into "No lessons yet" (implies data loss); keep
    // whatever we last had.
    catch { /* keep the previous facts */ }
  }, []);
  useEffect(() => { setFacts(null); void reload(); }, [ws, reload]);
  return { facts, reload: () => void reload() };
}

function MemoryScreen(
  { ws, tasks, theme, onProjects }:
  { ws: string; tasks: TaskModel[]; theme: Appearance; onProjects: () => void },
): JSX.Element {
  const { facts, reload } = useFacts(ws);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "global" | "project">("all");
  const [editing, setEditing] = useState<Fact | "new" | null>(null);
  const [showAppearance, setShowAppearance] = useState(false);

  const all = facts ?? [];
  const filtered = all.filter((f) => {
    if (scope !== "all" && f.scope !== scope) return false;
    if (q && !(f.text.toLowerCase().includes(q.toLowerCase()) || (f.ticketId ?? "").toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });
  const globalCount = all.filter((f) => f.scope === "global").length;
  const usedTotal = all.reduce((s, f) => s + (f.applied ?? 0), 0);
  const synth = `${all.length} lesson${all.length === 1 ? "" : "s"} learned · ${globalCount} global`
    + (usedTotal > 0 ? ` · applied ${usedTotal}×` : "");
  const scopes: Array<["all" | "global" | "project", string]> = [["all", "All"], ["global", "Global"], ["project", "This project"]];

  return (
    <>
      <AppBar active="memory" factCount={all.length} narrow newLabel="New lesson" theme={theme}
        onProjects={onProjects} onMemory={() => {}} onNew={() => setEditing("new")}
        onAppearance={() => setShowAppearance(true)} />
      <div className="page narrow">
        <PageHead title="Memory" synthFam="merged" synth={synth}
          lead="Each lesson is learned from a task and applied to the next ones — so the same mistake isn't made twice." />

        <div className="mem-toolbar">
          <input className="input" placeholder="Search a lesson or a ticket…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="nav-pills">
            {scopes.map(([v, label]) => (
              <button key={v} className={`nav-pill${scope === v ? " on" : ""}`} onClick={() => setScope(v)}>{label}</button>
            ))}
          </div>
        </div>

        {facts === null ? (
          <div className="empty-state" style={{ alignSelf: "stretch" }}><Skeleton lines={4} /></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {all.length === 0
              ? "No lessons yet. When an agent hits a wall, record the fix here so it never happens twice."
              : "No lessons match this filter."}
          </div>
        ) : (
          <div className="fact-list">
            {filtered.map((f) => <FactCard key={f.id} f={f} onEdit={() => setEditing(f)} />)}
          </div>
        )}

        {editing && <FactEditor fact={editing} tasks={tasks} onClose={() => setEditing(null)} onSaved={reload} />}
      </div>
      {showAppearance && <AppearanceModal theme={theme} onClose={() => setShowAppearance(false)} />}
    </>
  );
}

/* --------------------------------- mount --------------------------------- */

initToken();
initWs();
createRoot(document.getElementById("app")!).render(<StrictMode><App /></StrictMode>);

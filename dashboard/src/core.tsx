/* Extracted from app.tsx — mechanical split. */
/** Agent Factory dashboard — React app. Mounts into #app. */

import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent, CSSProperties, DragEvent as ReactDragEvent, JSX, ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import type {
  BlockedContext, FactoryEvent, TaskState,
  CapsuleAction, CapsuleConsent, CapsulePanel, CapsuleView,
} from "./types.js";
import {
  api, fetchJSON, getText, getWs, initToken, initWs, postJSON, repoGet, repoPath, scopedJSON, setRepoPath, setWs,
} from "./api.js";
import {
  ACTIVITY, Checkpoint, EFFORT_CHOICES, HistoryTicket, MODEL_CHOICES, Model, Settings, StoryItem, TaskModel,
  ago, fmtDuration, fmtTokens, fmtUsd, freshModel, generateConfig, inFlight, narrate,
  parseDiff, parseSettings, reduce, seedHistory,
} from "./model.js";
import { langFromPath, tokenizeLine } from "./highlight.js";
import { qrSvg } from "./qr.js";
import type { Observation } from "./companion.js";
import {
  ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpFromLine,
  BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Circle,
  CircleDot, CircleHelp, Command, CompanionIcon, CornerDownLeft, CornerDownRight,
  ExternalLink, Eye, FileText, FlaskConical, Flag, Folder, FolderOpen, FolderPlus,
  GitBranch, GitMerge, Globe, InfinityIcon, Key, Laptop, Lightbulb, ListChecks, Lock, MessageCircle,
  MoreHorizontal, Palette, Pause, Pencil, Play, Plus, RotateCw, Search, Send,
  ShieldCheck, Smartphone, Sparkles, Square, Terminal, Timer, Trash2, TriangleAlert, Undo2, Upload, X,
} from "./icons.js";
import type { LucideIcon } from "./icons.js";


/* --------------------------------- toasts --------------------------------- */

export interface Toast { id: number; msg: string; error: boolean }
export let toastSeq = 0;
export let toastList: Toast[] = [];
export const toastSubs = new Set<(t: Toast[]) => void>();
export function emitToasts(): void { for (const s of toastSubs) s(toastList); }
export function toast(msg: string, error = false): void {
  const t = { id: ++toastSeq, msg, error };
  toastList = [...toastList, t];
  emitToasts();
  setTimeout(() => { toastList = toastList.filter((x) => x.id !== t.id); emitToasts(); }, 4600);
}
export function Toaster(): JSX.Element {
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
export function Spinner({ size = 13 }: { size?: number }): JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

/**
 * The one button. It centralises behaviour — in-flight pending, disabled, and the
 * accessible name — while reusing the existing CSS vocabularies (`hbtn` / `btn` /
 * `act`) via `kind`, so the whole product routes clicks through one component
 * without a fourth class system. `autoPending` makes it own the spinner: it awaits
 * the onClick promise and disables itself for the duration — no external flag needed.
 */
export type BtnKind = "hbtn" | "btn" | "act";
export interface ButtonProps {
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
export function Button({
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
export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }): JSX.Element {
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
export interface EventSub {
  onRun?: (data: string) => void;
  onHistory?: (data: string) => void;
  onMessage?: (data: string) => void;
  onCompanion?: (data: string) => void;
  onOpen?: () => void;
  onError?: () => void;
}
export const eventHubs = new Map<string, { es: EventSource; subs: Set<EventSub> }>();
export function subscribeEvents(ws: string, sub: EventSub): () => void {
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
export function useEventStream(ws: string): [Model, number, boolean] {
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
export function useManagedInterval(): (tick: (stop: () => void) => void, ms: number) => void {
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
export function useNow(activeOrPaused: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activeOrPaused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeOrPaused]);
  return now;
}

/** Polls whether a dispatcher is really alive for the shown run. */
export function useRunActive(tick: number): boolean {
  const [active, setActive] = useState(true);
  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const s = await fetchJSON<{ run: { state: string }; loop?: { state: string } }>("/api/status");
        // An autopilot loop runs via the "loop" job, not "run" — count it as active
        // too, so the header doesn't say "stopped" while the loop is working.
        if (alive) setActive(s.run.state === "running" || s.loop?.state === "running");
      } catch { /* keep last */ }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tick === 0 ? 0 : 1]); // (re)start once the stream is live
  return active;
}

/** Close-on-Escape for any overlay. Cheap re-subscribe per render is fine. */
export function useEsc(onClose: () => void): void {
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
export function useFocusTrap<T extends HTMLElement>(): React.RefObject<T | null> {
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
export function useNotifyPref(): { on: boolean; toggle: () => void } {
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

export function sendNotification(title: string, body: string): void {
  try { new Notification(title, { body, tag: "agent-factory" }); } catch { /* not permitted */ }
}

/** Terminal states worth interrupting a human for. */
export const ALERT_STATES: Partial<Record<TaskState, { msg: string; error: boolean }>> = {
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
export function useStateAlerts(model: Model, notifyEnabled: boolean): void {
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
          if (notifyEnabled && document.hidden) sendNotification("Warden", `${t.title}: ${a.msg}`);
        }
      }
      prev.current.set(id, t.state);
    }
    if (ready && model.endedTs && !endedSeen.current) {
      endedSeen.current = true;
      const merged = [...model.tasks.values()].filter((t) => t.state === "DONE").length;
      toast(`Run finished — ${merged} merged.`);
      if (notifyEnabled && document.hidden) sendNotification("Warden", `Run finished — ${merged} merged.`);
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
export function useCompanion(ws: string): { obs: Observation[]; latestId: string | null } {
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

export interface WorkspaceInfo { name: string; workdir: string; repo: string | null; currentRun: string | null }

/* --------------------------------- status meta --------------------------------- */

/** Per-state pill: human label + icon + colour family (drives the oklch CSS vars). */
export const STATE_META: Record<TaskState, { label: string; Icon: LucideIcon; fam: string }> = {
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
export const TONE_FAM: Record<string, string> = { good: "merged", warning: "blocked", critical: "failed", accent: "working" };

export function StatusPill({ state, live }: { state: TaskState; live?: boolean }): JSX.Element {
  const m = STATE_META[state];
  return (
    <span className={`pill fam-${m.fam}`}>
      {live ? <span className="live-dot" /> : <span className="glyph"><m.Icon size={12} /></span>}
      {m.label}
    </span>
  );
}


/* --------------------------------- image attachments --------------------------------- */

export interface Attachment { path: string; name: string; thumb: string }

/**
 * Paste/drop/pick images into any composer. Each image is uploaded to
 * /api/attachments (saved under the workspace) and its ABSOLUTE path is handed
 * back via refs() — the consumer appends refs() to the outgoing text so the agent
 * can Read the file and see it. clear() after sending.
 */
export function useAttachments(): {
  items: Attachment[];
  paste: (e: ReactClipboardEvent) => void;
  drop: (e: ReactDragEvent) => void;
  pick: (files: FileList | null) => void;
  remove: (path: string) => void;
  clear: () => void;
  refs: () => string;
} {
  const [items, setItems] = useState<Attachment[]>([]);
  const upload = useCallback((file: File): void => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const thumb = String(reader.result);
      void postJSON<{ path?: string; name?: string }>("/api/attachments", { dataUrl: thumb, name: file.name })
        .then((r) => { if (r.path) setItems((xs) => [...xs, { path: r.path!, name: r.name || file.name, thumb }]); })
        .catch((e) => toast(String(e), true));
    };
    reader.readAsDataURL(file);
  }, []);
  const paste = useCallback((e: ReactClipboardEvent): void => {
    const imgs = [...(e.clipboardData?.items ?? [])].filter((it) => it.type.startsWith("image/"));
    if (!imgs.length) return;
    e.preventDefault();
    for (const it of imgs) { const f = it.getAsFile(); if (f) upload(f); }
  }, [upload]);
  const drop = useCallback((e: ReactDragEvent): void => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    files.forEach(upload);
  }, [upload]);
  const pick = useCallback((files: FileList | null): void => {
    [...(files ?? [])].forEach(upload);
  }, [upload]);
  const remove = useCallback((path: string): void => setItems((xs) => xs.filter((x) => x.path !== path)), []);
  const clear = useCallback((): void => setItems([]), []);
  const refs = useCallback(
    (): string => items.map((x) => `\n\n[Attached image — Read this file to view it: ${x.path}]`).join(""),
    [items],
  );
  return { items, paste, drop, pick, remove, clear, refs };
}

/** The thumbnail strip under a composer; each image has a remove (×) button. */
export function AttachStrip(
  { items, onRemove }: { items: Attachment[]; onRemove: (path: string) => void },
): JSX.Element | null {
  if (!items.length) return null;
  return (
    <div className="attach-strip">
      {items.map((a) => (
        <div key={a.path} className="attach-thumb" title={a.name}>
          <img src={a.thumb} alt={a.name} />
          <button type="button" className="attach-x" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.path)}>
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** A small "attach file" button that opens a file picker, accepting all file types. */
export function AttachButton({ onPick }: { onPick: (files: FileList | null) => void }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="attach-btn" title="Attach files" onClick={() => ref.current?.click()}>
        <Upload size={13} /> Attach
      </button>
      <input ref={ref} type="file" multiple hidden
        onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
    </>
  );
}

/* --------------------------------- file attachments --------------------------------- */

function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.substring(dot + 1).toUpperCase() : "FILE";
}

function fileIconSvg(fileName: string): string {
  const ext = getFileExtension(fileName);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
    <rect width="64" height="64" fill="#e0e0e0" rx="4"/>
    <rect x="4" y="4" width="56" height="56" fill="#f5f5f5" rx="2"/>
    <text x="32" y="40" font-size="12" font-weight="bold" text-anchor="middle" fill="#666" font-family="system-ui">
      ${ext.substring(0, 3)}
    </text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/**
 * Paste/drop/pick all files (images and others) into any composer. Images get
 * thumbnails, other files get extension-based icons. Files are uploaded to
 * /api/attachments (saved under the workspace) and their ABSOLUTE path is handed
 * back via refs() — the consumer appends refs() to the outgoing text so the agent
 * can Read the file. clear() after sending.
 */
export function useFileAttachments(): {
  items: Attachment[];
  uploading: number;
  paste: (e: ReactClipboardEvent) => void;
  drop: (e: ReactDragEvent) => void;
  pick: (files: FileList | null) => void;
  remove: (path: string) => void;
  clear: () => void;
  refs: () => string;
} {
  const [items, setItems] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const upload = useCallback((file: File): void => {
    setUploading((n) => n + 1);
    const reader = new FileReader();
    reader.onload = () => {
      const fileContent = String(reader.result);
      const thumbPromise = isImage(file)
        ? Promise.resolve(fileContent)
        : Promise.resolve(fileIconSvg(file.name));

      thumbPromise.then((thumb) => {
        void postJSON<{ path?: string; name?: string }>("/api/attachments", {
          dataUrl: fileContent,
          name: file.name,
        })
          .then((r) => {
            if (r.path) {
              setItems((xs) => [...xs, { path: r.path!, name: r.name || file.name, thumb }]);
            }
          })
          .catch((e) => toast(String(e), true))
          .finally(() => setUploading((n) => Math.max(0, n - 1)));
      });
    };
    reader.readAsDataURL(file);
  }, []);

  const paste = useCallback((e: ReactClipboardEvent): void => {
    const items = [...(e.clipboardData?.items ?? [])].filter((it) => it.kind === "file");
    if (!items.length) return;
    e.preventDefault();
    for (const it of items) {
      const f = it.getAsFile();
      if (f) upload(f);
    }
  }, [upload]);

  const drop = useCallback((e: ReactDragEvent): void => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    files.forEach(upload);
  }, [upload]);

  const pick = useCallback((files: FileList | null): void => {
    [...(files ?? [])].forEach(upload);
  }, [upload]);

  const remove = useCallback((path: string): void => setItems((xs) => xs.filter((x) => x.path !== path)), []);
  const clear = useCallback((): void => setItems([]), []);
  const refs = useCallback(
    (): string => items.map((x) => `\n\n[Attached file — Read this file to view it: ${x.path}]`).join(""),
    [items],
  );

  return { items, uploading, paste, drop, pick, remove, clear, refs };
}

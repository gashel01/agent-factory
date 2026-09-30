/** Shared client plumbing: toasts, polling and interval hooks, the event
 *  stream, file attachments, the companion feed. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from "react";
import type { FactoryEvent } from "./types.js";
import { api, fetchJSON, postJSON } from "./api.js";
import { HistoryTicket, Model, freshModel, reduce, seedHistory } from "./model.js";
import type { Observation } from "./companion.js";

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
 * `stop()` to end the poll itself when its work is done. Ticks are skipped while
 * the tab is hidden; one runs as soon as it's visible again.
 */
export function useManagedInterval(): (tick: (stop: () => void) => void, ms: number) => void {
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<((stop: () => void) => void) | null>(null);
  const stop = useCallback(() => {
    if (ref.current) { clearInterval(ref.current); ref.current = null; }
    tickRef.current = null;
  }, []);
  useEffect(() => {
    const onVisible = (): void => {
      if (!document.hidden && ref.current) tickRef.current?.(stop);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); stop(); }; // clear on unmount
  }, [stop]);
  return useCallback((tick, ms) => {
    stop();
    tickRef.current = tick;
    ref.current = setInterval(() => { if (!document.hidden) tick(stop); }, ms);
  }, [stop]);
}

/** What a usePolling callback gets: `alive()` is false once the effect was torn
 *  down (unmount / deps change) — check it after an await before setting state;
 *  `stop()` ends the polling for good (until deps change). */
export interface PollControl { alive: () => boolean; stop: () => void }

/**
 * Network polling that respects the tab: `fn` runs once immediately, then every
 * `ms` — but the interval is suspended while `document.hidden` (a backgrounded
 * dashboard shouldn't keep hitting the server) and resumed, with an immediate
 * call, when the tab becomes visible again. `ms: null` is a one-shot load with
 * the same lifecycle. Nothing runs while `enabled` is false. Re-subscribes when
 * `deps` change (like useEffect). A rejected poll is ignored: the last value
 * stays and the next tick retries.
 */
export function usePolling(
  fn: (ctl: PollControl) => void | Promise<void>,
  ms: number | null,
  deps: React.DependencyList,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    let alive = true, stopped = false;
    let id: ReturnType<typeof setInterval> | null = null;
    const pause = (): void => { if (id !== null) { clearInterval(id); id = null; } };
    const ctl: PollControl = { alive: () => alive, stop: () => { stopped = true; pause(); } };
    const run = (): void => {
      if (stopped) return;
      void Promise.resolve().then(() => fn(ctl)).catch(() => { /* keep last; next tick retries */ });
    };
    const resume = (): void => { if (id === null && !stopped && ms !== null) id = setInterval(run, ms); };
    const onVisibility = (): void => {
      if (document.hidden) pause();
      else { run(); resume(); }
    };
    run();
    if (ms === null) return () => { alive = false; };
    if (!document.hidden) resume();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false; stopped = true; pause();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [...deps, ms, enabled]);
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

/** How often the header re-checks that a dispatcher is really running. */
const RUN_ACTIVE_POLL_MS = 3000;

/** Polls whether a dispatcher is really alive for the shown run. */
export function useRunActive(tick: number): boolean {
  const [active, setActive] = useState(true);
  usePolling(async ({ alive }) => {
    try {
      const s = await fetchJSON<{ run: { state: string }; loop?: { state: string } }>("/api/status");
      // An autopilot loop runs via the "loop" job, not "run" — count it as active
      // too, so the header doesn't say "stopped" while the loop is working.
      if (alive()) setActive(s.run.state === "running" || s.loop?.state === "running");
    } catch { /* keep last */ }
  }, RUN_ACTIVE_POLL_MS, [tick === 0 ? 0 : 1]); // (re)start once the stream is live
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
        let body: Record<string, string>;
        if (isImage(file)) {
          body = { dataUrl: fileContent, name: file.name };
        } else {
          const commaIdx = fileContent.indexOf(",");
          const base64Content = commaIdx >= 0 ? fileContent.substring(commaIdx + 1) : fileContent;
          body = { content: base64Content, name: file.name };
        }

        void postJSON<{ path?: string; name?: string }>("/api/attachments", body)
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

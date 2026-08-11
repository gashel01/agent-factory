/* Extracted from app.tsx — mechanical split. */
/** Agent Factory dashboard — React app. Mounts into #app. */

import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
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
import { toast, useEsc, useFocusTrap, type WorkspaceInfo } from "./core.js";
import { Ticket } from "./work.js";

/* --------------------------------- widgets --------------------------------- */

/** A right slide-in drawer, for settings & supervisor (mockup: calm side panels). */
export function Drawer(
  { title, live, wide, onClose, foot, children }:
  { title: ReactNode; live?: boolean; wide?: boolean; onClose: () => void; foot?: ReactNode; children: ReactNode },
): JSX.Element {
  useEsc(onClose);
  const trap = useFocusTrap<HTMLElement>();
  return (
    <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className={`drawer${wide ? " wide" : ""}`} ref={trap} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Panel"}>
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

export function ConfirmButton(
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

export function Modal(
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

export interface SelectOption { value: string; label: ReactNode }

/** A custom, theme-aware dropdown rendered through a portal, so it escapes the
 *  header's overflow/stacking context and never inherits the OS's native <select>
 *  chrome (the white box that clashed with dark mode). Keyboard-accessible:
 *  arrows to move, Enter/Space to pick, Escape to close; closes on outside click,
 *  repositions on scroll/resize, and flips above the trigger when low on room. */
export function Select(
  { value, options, onChange, className = "", ariaLabel, minWidth = 180 }:
  { value: string; options: SelectOption[]; onChange: (v: string) => void;
    className?: string; ariaLabel?: string; minWidth?: number },
): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selIndex);
  const current = options.find((o) => o.value === value);

  const place = useCallback((): void => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const menu = menuRef.current;
    const width = Math.max(r.width, minWidth);
    // Measure the real menu once it's in the DOM; fall back to an estimate on the
    // first pass (before it renders) so we still get a sane initial position.
    const menuW = menu ? Math.max(menu.offsetWidth, width) : width;
    const naturalH = menu ? menu.scrollHeight : Math.min(options.length * 36 + 10, 320);
    const roomBelow = vh - r.bottom - margin;
    const roomAbove = r.top - margin;
    // Flip above the trigger only when below is too tight AND above has more room.
    const up = roomBelow < Math.min(naturalH, 260) && roomAbove > roomBelow;
    const maxHeight = Math.max(120, Math.min(naturalH, up ? roomAbove : roomBelow));
    // Clamp horizontally so a trigger near the right (or a wide menu) never spills
    // off-screen; never push past the left margin either.
    const left = Math.max(margin, Math.min(r.left, vw - menuW - margin));
    setPos({ top: up ? r.top : r.bottom, left, width, up, maxHeight });
  }, [options.length, minWidth]);

  // Position after the menu is actually in the DOM (so it can be measured), before
  // paint — no flicker. Re-runs whenever the menu opens.
  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  const menuStyle: CSSProperties = pos
    ? {
        position: "fixed", left: pos.left, minWidth: pos.width, maxHeight: pos.maxHeight,
        ...(pos.up ? { bottom: window.innerHeight - pos.top + 6 } : { top: pos.top + 6 }),
      }
    // First render (not yet measured): off-screen + hidden so it can be sized
    // without a visible flash; the layout effect immediately replaces this.
    : { position: "fixed", top: 0, left: -9999, visibility: "hidden", minWidth };
  useEffect(() => { if (open) setActive(selIndex); }, [open, selIndex]);
  useEffect(() => {
    if (!open) return;
    const reposition = (): void => place();
    const onDown = (e: PointerEvent): void => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, place]);
  useEffect(() => {
    if (!open || !menuRef.current) return;
    menuRef.current.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const choose = (v: string): void => { onChange(v); setOpen(false); triggerRef.current?.focus(); };

  return (
    <>
      <button
        ref={triggerRef} type="button" className={`xselect-trigger ${className}`.trim()}
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); }
            return;
          }
          // While open we own these keys — stop them reaching an enclosing dialog's
          // Escape/hotkey listeners (else Escape would close the whole drawer too).
          if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(e.key)) e.stopPropagation();
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
          else if (e.key === "Home") { e.preventDefault(); setActive(0); }
          else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
          else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const o = options[active]; if (o) choose(o.value); }
          else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
          else if (e.key === "Tab") { setOpen(false); }
        }}
      >
        <span className="xselect-value">{current?.label ?? value}</span>
        <span className="xselect-caret"><ChevronDown size={15} /></span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef} className={`xselect-menu${pos?.up ? " up" : ""}`} role="listbox"
          style={menuStyle}
        >
          {options.map((o, i) => (
            <div
              key={o.value} data-i={i} role="option" aria-selected={o.value === value}
              className={`xselect-opt${o.value === value ? " sel" : ""}${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o.value)}
            >
              <span className="xselect-opt-label">{o.label}</span>
              {o.value === value && <span className="xselect-check"><Check size={14} /></span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export interface OverflowItem { label: string; hint?: string; onClick: () => void; on?: boolean }

/** A compact "•••" action menu (portal-rendered, right-aligned, theme-aware) for
 *  demoting secondary header controls out of the top bar without losing them —
 *  they move here, one tap away, rather than away. Closes on outside click,
 *  Escape, or scroll/resize. */
export function OverflowMenu({ items, ariaLabel = "More" }: { items: OverflowItem[]; ariaLabel?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const place = useCallback((): void => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const rp = (): void => place();
    const onDown = (e: PointerEvent): void => {
      if (triggerRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("scroll", rp, true);
    window.addEventListener("resize", rp);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", rp, true);
      window.removeEventListener("resize", rp);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, place]);
  return (
    <>
      <button ref={triggerRef} className={`hbtn icon-btn${open ? " on" : ""}`} aria-haspopup="menu"
        aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={16} />
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="xselect-menu overflow-menu" role="menu"
          style={{ position: "fixed", top: pos.top, right: pos.right, minWidth: 200 }}>
          {items.map((it, i) => (
            <button key={i} role="menuitem" className={`xselect-opt as-action${it.on ? " sel" : ""}`}
              onClick={() => { setOpen(false); it.onClick(); }}>
              <span className="xselect-opt-label">{it.label}</span>
              {it.hint && <span className="oi-hint">{it.hint}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Human label for a plan rate-limit window ("five_hour" → "5h window"). */
export interface UsageLimit {
  kind: string; group: string; percent: number; severity: string; resets_at: string | null;
  is_active?: boolean; scope?: { model?: { display_name?: string | null } | null } | null;
}
export interface UsageResp { limits?: UsageLimit[]; error?: string }

/** Poll the real subscription plan usage (5h session + weekly, per model) — the data
 *  Claude's own /usage screen shows, fetched server-side via the account's OAuth token. */
export function usePlanLimits(active: boolean): UsageLimit[] {
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
export function useBacklog(ws: string): { tickets: Ticket[]; refresh: () => void } {
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

/** The binding constraint, full width: the one number worth reading from across the room. */
export function PlanHero(
  { label, pct, note, right, sev, bar = true }:
  { label: string; pct: number; note: string; right?: string; sev?: string; bar?: boolean },
): JSX.Element {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className={`u-hero${sev ? ` sev-${sev}` : ""}`}>
      <div className="u-hero-top">
        <span className="u-hero-lab">{label}</span>
        {right && <span className="u-hero-right">{right}</span>}
      </div>
      <div className="u-hero-fig">
        <b className="tnum">{Math.round(clamped)}%</b>
        <span>used</span>
        <span className="u-hero-left tnum">{Math.round(100 - clamped)}% left</span>
      </div>
      {bar && <div className="pl-bar"><div className="pl-fill" style={{ width: `${Math.max(1.5, clamped)}%` }} /></div>}
      {note && <span className="u-hero-note">{note}</span>}
    </div>
  );
}

/** Session cost/tokens + (on a subscription) the real plan usage limits.
 *  One hero meter for the window that actually binds, the rest as a quiet grid —
 *  three identical bars made every constraint look equally urgent.
 *  Collapsible: the hero alone survives, since that is the one that can stop a run. */
/** Compact usage dial for the header: a ring showing the binding window's percent,
 *  colour-coded by severity. Hovering (or focusing) opens a portal popover with the
 *  full breakdown — the same detail the old card showed inline — and moving into the
 *  popover keeps it open, so the operator can read it or click through to full stats. */
export function UsageCard(
  { mode, tokens, spent, budgetUsd, budgetPct, budgetColor, onAnalytics }:
  { mode: "subscription" | "api"; tokens: number; spent: number; budgetUsd: number | null;
    budgetPct: number; budgetColor: string; onAnalytics: () => void },
): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const limits = usePlanLimits(mode !== "api");
  // Highest percentage first: the window closest to stopping the fleet leads.
  const ranked = [...limits].sort((a, b) => b.percent - a.percent);
  const hero = mode === "api" ? undefined : ranked[0];
  const rest = mode === "api" ? [] : ranked.slice(1);

  // The dial: percent + colour of the binding constraint (budget in API mode).
  const hasValue = mode === "api" || !!hero;
  const pct = Math.max(0, Math.min(100, mode === "api" ? budgetPct : (hero?.percent ?? 0)));
  const sev = hero?.severity;
  const color = mode === "api" ? budgetColor
    : sev === "warning" || sev === "high" ? "#d3a018"
      : sev === "critical" || sev === "reject" ? "var(--st-failed-fg, #d3543f)"
        : "var(--accent)";
  const R = 13, CIRC = 2 * Math.PI * R;

  const place = useCallback((): void => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const rp = (): void => place();
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("scroll", rp, true);
    window.addEventListener("resize", rp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", rp, true);
      window.removeEventListener("resize", rp);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, place]);
  // A short close delay bridges the gap between the dial and the popover, so moving
  // the cursor across it doesn't dismiss it.
  const show = (): void => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const hide = (): void => { closeTimer.current = setTimeout(() => setOpen(false), 160); };

  const caption = mode === "api" ? "Run budget" : "Plan usage";
  const heroNote = `${fmtUsd(spent)} · ${fmtTokens(tokens)} tokens this session, API-equivalent`;

  return (
    <>
      <button ref={triggerRef} className={`usage-gauge${open ? " on" : ""}`}
        aria-label={`${caption}${hasValue ? ` — ${Math.round(pct)}% used` : ""}. Open cost & activity.`}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onClick={onAnalytics}>
        <span className="ug-ring-wrap">
          <svg className="ug-ring" viewBox="0 0 34 34" width="34" height="34" aria-hidden="true">
            <circle className="ug-track" cx="17" cy="17" r={R} />
            {hasValue && (
              <circle className="ug-arc" cx="17" cy="17" r={R}
                style={{ stroke: color, strokeDasharray: CIRC, strokeDashoffset: CIRC * (1 - pct / 100) }} />
            )}
          </svg>
          <span className="ug-pct" style={{ color: hasValue ? color : "var(--faint)" }}>
            {hasValue ? Math.round(pct) : "·"}
          </span>
        </span>
      </button>

      {open && pos && createPortal(
        <div ref={popRef} className="usage-pop" style={{ position: "fixed", top: pos.top, right: pos.right }}
          onMouseEnter={show} onMouseLeave={hide}>
          <div className="u-top">
            <span className="u-cap">{caption}</span>
            <span className="u-mode">{mode === "api" ? "API · billed" : "Subscription"}</span>
          </div>

          {hero
            ? <PlanHero label={limitLabel(hero)} pct={hero.percent} sev={hero.severity}
              right={fmtReset(hero.resets_at)} note={heroNote} />
            : mode === "api"
              ? (
                <div className="u-hero">
                  <div className="u-hero-top">
                    <span className="u-hero-lab">Spent this session</span>
                    {budgetUsd !== null && <span className="u-hero-right tnum">of {fmtUsd(budgetUsd)}</span>}
                  </div>
                  <div className="u-hero-fig"><b className="tnum">{fmtUsd(spent)}</b><span>{fmtTokens(tokens)} tokens</span></div>
                  <div className="pl-bar">
                    <div className="pl-fill" style={{ width: `${Math.max(1.5, budgetPct)}%`, background: budgetColor }} />
                  </div>
                  <span className="u-hero-note">{budgetUsd === null ? "No cap set · real dollars" : "Real dollars · amber at 70%, red at 90%"}</span>
                </div>
              )
              : (
                <div className="u-hero">
                  <div className="u-hero-fig"><b className="tnum">{fmtUsd(spent)}</b><span>{fmtTokens(tokens)} tokens</span></div>
                  <span className="u-hero-note">API-equivalent · not charged. Plan windows unavailable — sign in to the Claude CLI.</span>
                </div>
              )}

          {rest.length > 0 && (
            <div className="u-grid">
              {rest.map((l) => (
                <div key={l.kind} className={`u-cell sev-${l.severity}`}>
                  <span className="u-cell-lab">{limitLabel(l)}</span>
                  <span className="u-cell-val">
                    <b className="tnum">{Math.round(l.percent)}%</b>
                    <span>{fmtReset(l.resets_at)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          <button className="u-hint" onClick={() => { setOpen(false); onAnalytics(); }}>
            Cost &amp; activity across runs
            <ArrowRight size={13} />
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

/* --------------------------- command palette (Cmd-K) --------------------------- */

export interface Command { id: string; label: string; hint?: string; group: string; run: () => void }

/** Fuzzy-ish filter: every query char appears in order somewhere in the haystack. */
export function fuzzyMatch(query: string, hay: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase(), h = hay.toLowerCase();
  let i = 0;
  for (const ch of h) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return false;
}

/** One-keystroke launcher (Cmd/Ctrl+K): search every action and jump to it. */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }): JSX.Element {
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

export function ProjectSwitcher(
  { workspace, workspaces, onOpenProjects, onSwitchProject }:
  { workspace: string; workspaces: WorkspaceInfo[]; onOpenProjects: () => void; onSwitchProject: (name: string) => void },
): JSX.Element {
  const options: SelectOption[] = [
    { value: "__all_projects__", label: "All Projects" },
    ...workspaces.map((w) => ({ value: w.name, label: w.name })),
  ];

  const currentValue = workspaces.some((w) => w.name === workspace) ? workspace : "__all_projects__";

  const handleChange = (value: string): void => {
    if (value === "__all_projects__") {
      onOpenProjects();
    } else {
      onSwitchProject(value);
    }
  };

  return <Select value={currentValue} options={options} onChange={handleChange} className="proj-select" />;
}

export async function quickRun(): Promise<void> {
  try {
    await postJSON("/api/run", {});
    toast("New run starting — remaining tickets replay with the current config.");
  } catch (err) { toast(String(err), true); }
}


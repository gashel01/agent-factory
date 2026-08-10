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
import { Diff, ReviewComment, ReviewProps } from "./diff-view.js";

// Module-level id counter for inline review comments (moved here with its only
// mutation site when app.tsx was split; an imported `let` cannot be reassigned).
let commentSeq = 0;
import { AttachStrip, Button, Skeleton, toast, useAttachments, useEsc } from "./core.js";
import { DockerStatus } from "./modals.js";
import { ConfirmButton, Modal, Select, sendAnswer, sendControl } from "./widgets.js";
import { NewWorkModal } from "./work.js";
import {
  ACCENTS, ATMOSPHERES, BACKGROUNDS, MAX_CUSTOM_BG, PANEL_COLORS, PANEL_STYLES, SCENES,
} from "./appearance-types.js";
import type { PanelStyle } from "./appearance-types.js";

/* --------------------------------- projects landing --------------------------------- */

export interface PortfolioProject {
  name: string; workdir: string; currentRun: string | null; running: boolean;
  counts: { queued: number; working: number; needs: number; merged: number };
  total: number; spend: number; tokens: number; budget: number | null; ended: boolean; updatedTs: string | null;
}

/** Derive a single at-a-glance status for a whole project from its counts. */
export function projStatus(c: PortfolioProject["counts"]): { fam: string; label: string } {
  if (c.needs > 0) return { fam: "blocked", label: "Needs you" };
  if (c.working > 0) return { fam: "working", label: "Working" };
  if (c.queued > 0) return { fam: "upnext", label: "Up next" };
  if (c.merged > 0) return { fam: "merged", label: "Up to date" };
  return { fam: "upnext", label: "No run yet" };
}

export type ThemeMode = "system" | "light" | "dark";

export interface Appearance {
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
  panelStyle: PanelStyle;
  setPanelStyle: (v: PanelStyle) => void;
  panelColor: string;                 // "" = theme default
  setPanelColor: (v: string) => void;
  background: string;                 // "" = none (theme --bg)
  setBackground: (v: string) => void;
  scene: string;                      // "" = none
  setScene: (v: string) => void;
  atmosphere: string;                 // "" = none
  setAtmosphere: (v: string) => void;
  customBgs: string[];                // data URLs, stored on this device
  addCustomBg: (dataUrl: string) => void;
  removeCustomBg: (i: number) => void;
  customBg: number;                   // index into customBgs, or -1
  setCustomBg: (i: number) => void;
  darkness: number;                   // 0..100 backdrop dimmer
  setDarkness: (v: number) => void;
}

export function readPref(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function readNum(key: string, fallback: number): number {
  const n = Number(readPref(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}
function readList(key: string): string[] {
  try { const v = JSON.parse(readPref(key, "[]")); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}

/** Appearance: theme, accent, density plus the full backdrop system — panel
 *  style/colour, background colour, scenes, atmospheres, custom backgrounds and
 *  a darkness dimmer. All persisted; applied to <html> via data-attributes and
 *  inline CSS vars the CSS in 08-appearance-polish.css keys off. */
export function useTheme(): Appearance {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const s = readPref("factory.theme", "system");
    return s === "dark" || s === "light" || s === "system" ? s : "system";
  });
  const [accent, setAccentState] = useState(() => readPref("factory.accent", "brass"));
  const [density, setDensityState] = useState(() => readPref("factory.density", "comfortable"));
  const [compactHeader, setCompactHeaderState] = useState(() => readPref("factory.headerCompact", "0") === "1");
  const [panelStyle, setPanelStyleState] = useState<PanelStyle>(() => {
    const s = readPref("factory.panelStyle", "max");
    return s === "solid" || s === "glass" ? s : "max";
  });
  const [panelColor, setPanelColorState] = useState(() => readPref("factory.panelColor", ""));
  const [background, setBackgroundState] = useState(() => readPref("factory.background", ""));
  const [scene, setSceneState] = useState(() => readPref("factory.scene", ""));
  const [atmosphere, setAtmosphereState] = useState(() => readPref("factory.atmosphere", ""));
  const [customBgs, setCustomBgsState] = useState<string[]>(() => readList("factory.customBgs"));
  const [customBg, setCustomBgState] = useState(() => readNum("factory.customBg", -1));
  const [darkness, setDarknessState] = useState(() => readNum("factory.darkness", 0));
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
    const el = document.documentElement;
    el.setAttribute("data-accent", accent);
    el.setAttribute("data-density", density);
    el.setAttribute("data-header", compactHeader ? "compact" : "full");
  }, [accent, density, compactHeader]);
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-panel", panelStyle);
    if (panelColor) el.setAttribute("data-panel-color", panelColor); else el.removeAttribute("data-panel-color");
    if (background) el.setAttribute("data-bg", background); else el.removeAttribute("data-bg");
    el.style.setProperty("--app-darkness", String(darkness));
    // Custom background wins over a preset scene; both feed the same layer.
    const custom = customBg >= 0 && customBg < customBgs.length ? customBgs[customBg] : null;
    const sceneImg = SCENES.find((s) => s.id === scene)?.image ?? null;
    const bgImage = custom ? `url("${custom}")` : sceneImg;
    if (bgImage) el.style.setProperty("--app-scene", bgImage); else el.style.removeProperty("--app-scene");
    const atmo = ATMOSPHERES.find((a) => a.id === atmosphere)?.overlay ?? null;
    if (atmo) el.style.setProperty("--app-atmo", atmo); else el.style.removeProperty("--app-atmo");
  }, [panelStyle, panelColor, background, scene, atmosphere, customBg, customBgs, darkness]);

  const persist = (key: string, value: string): void => {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  };
  return {
    dark, mode, accent, density, compactHeader,
    panelStyle, panelColor, background, scene, atmosphere, customBgs, customBg, darkness,
    setMode: (m) => { setModeState(m); persist("factory.theme", m); },
    setAccent: (a) => { setAccentState(a); persist("factory.accent", a); },
    setDensity: (d) => { setDensityState(d); persist("factory.density", d); },
    setCompactHeader: (v) => { setCompactHeaderState(v); persist("factory.headerCompact", v ? "1" : "0"); },
    setPanelStyle: (v) => { setPanelStyleState(v); persist("factory.panelStyle", v); },
    setPanelColor: (v) => { setPanelColorState(v); persist("factory.panelColor", v); },
    setBackground: (v) => { setBackgroundState(v); persist("factory.background", v); },
    setScene: (v) => { setSceneState(v); persist("factory.scene", v); if (v) { setCustomBgState(-1); persist("factory.customBg", "-1"); } },
    setAtmosphere: (v) => { setAtmosphereState(v); persist("factory.atmosphere", v); },
    addCustomBg: (dataUrl) => {
      setCustomBgsState((prev) => {
        const next = [...prev, dataUrl].slice(-MAX_CUSTOM_BG);
        persist("factory.customBgs", JSON.stringify(next));
        const idx = next.length - 1;
        setCustomBgState(idx); persist("factory.customBg", String(idx));
        setSceneState(""); persist("factory.scene", "");
        return next;
      });
    },
    removeCustomBg: (i) => {
      setCustomBgsState((prev) => {
        const next = prev.filter((_, k) => k !== i);
        persist("factory.customBgs", JSON.stringify(next));
        setCustomBgState((cur) => { const nc = cur === i ? -1 : cur > i ? cur - 1 : cur; persist("factory.customBg", String(nc)); return nc; });
        return next;
      });
    },
    setCustomBg: (i) => { setCustomBgState(i); persist("factory.customBg", String(i)); if (i >= 0) { setSceneState(""); persist("factory.scene", ""); } },
    setDarkness: (v) => { setDarknessState(v); persist("factory.darkness", String(v)); },
    toggle: () => { const m = dark ? "light" : "dark"; setModeState(m); persist("factory.theme", m); },
  };
}

export function AppearanceButton({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <button className="hbtn icon-btn" aria-label="Appearance settings" title="Appearance — theme, accent, density" onClick={onOpen}><Palette size={16} /></button>
  );
}

/** The full appearance panel: theme, panels, background, scenes, atmospheres,
 *  custom backgrounds, accent and a darkness dimmer. Global UI prefs. */
export function AppearanceModal({ theme, onClose }: { theme: Appearance; onClose: () => void }): JSX.Element {
  const modes: Array<[ThemeMode, string]> = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
  const densities: Array<[string, string]> = [["comfortable", "Comfortable"], ["compact", "Compact"]];
  const fileRef = useRef<HTMLInputElement>(null);
  const full = theme.customBgs.length >= MAX_CUSTOM_BG;

  // Read the picked file, downscale it (cap the longest edge at 1600px, JPEG
  // 0.82) so five backgrounds stay well within the localStorage quota, then
  // hand the data URL to the hook. Read via the ref so we need no React event.
  const onPickFile = (): void => {
    const input = fileRef.current;
    const file = input?.files?.[0] ?? null;
    if (input) input.value = "";
    if (!file || full) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { theme.addCustomBg(String(reader.result)); return; }
        ctx.drawImage(img, 0, 0, w, h);
        try { theme.addCustomBg(canvas.toDataURL("image/jpeg", 0.82)); }
        catch { toast("Couldn't store that image — try a smaller one.", true); }
      };
      img.onerror = () => toast("Couldn't read that image.", true);
      img.src = String(reader.result);
    };
    reader.onerror = () => toast("Couldn't read that file.", true);
    reader.readAsDataURL(file);
  };

  const noScene = !theme.scene && theme.customBg < 0;
  return (
    <Modal title="Appearance" onClose={onClose}>
      <div className="appearance-form">
        <div className="appearance-group">
          <span className="appearance-label">Mode</span>
          <div className="seg-choice">
            {modes.map(([v, l]) => (
              <button key={v} className={`seg-opt${theme.mode === v ? " on" : ""}`} onClick={() => theme.setMode(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Panel style</span>
          <div className="seg-choice">
            {PANEL_STYLES.map(([v, l]) => (
              <button key={v} className={`seg-opt${theme.panelStyle === v ? " on" : ""}`} onClick={() => theme.setPanelStyle(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Panel color</span>
          <div className="swatches">
            <button className={`swatch none${!theme.panelColor ? " on" : ""}`} title="Default" aria-label="Default panel colour" onClick={() => theme.setPanelColor("")} />
            {PANEL_COLORS.map(([name, color]) => (
              <button key={name} className={`swatch${theme.panelColor === name ? " on" : ""}`}
                style={{ background: color }} title={name} aria-label={name} onClick={() => theme.setPanelColor(name)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Background</span>
          <div className="swatches">
            <button className={`swatch none${!theme.background ? " on" : ""}`} title="Default" aria-label="Default background" onClick={() => theme.setBackground("")} />
            {BACKGROUNDS.map(([name, color]) => (
              <button key={name} className={`swatch${theme.background === name ? " on" : ""}`}
                style={{ background: color }} title={name} aria-label={name} onClick={() => theme.setBackground(name)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Atmospheres</span>
          <div className="atmo-grid">
            <button className={`atmo-tile none${!theme.atmosphere ? " on" : ""}`} title="None" aria-label="No atmosphere" onClick={() => theme.setAtmosphere("")} />
            {ATMOSPHERES.map((a) => (
              <button key={a.id} className={`atmo-tile${theme.atmosphere === a.id ? " on" : ""}`}
                style={{ backgroundImage: a.overlay }} title={a.name} aria-label={a.name} onClick={() => theme.setAtmosphere(a.id)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Scenes</span>
          <div className="scene-grid">
            <button className={`scene-tile none${noScene ? " on" : ""}`} title="None" aria-label="No scene" onClick={() => { theme.setScene(""); theme.setCustomBg(-1); }} />
            {SCENES.map((s) => (
              <button key={s.id} className={`scene-tile${theme.scene === s.id ? " on" : ""}`}
                style={{ backgroundImage: s.image }} title={s.name} aria-label={s.name} onClick={() => theme.setScene(s.id)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <div className="appearance-row">
            <span className="appearance-label">Custom background</span>
            <span className="appearance-count">{theme.customBgs.length}/{MAX_CUSTOM_BG}</span>
          </div>
          {theme.customBgs.length > 0 && (
            <div className="scene-grid">
              {theme.customBgs.map((url, i) => (
                <div key={i} className={`scene-tile custom${theme.customBg === i ? " on" : ""}`} style={{ backgroundImage: `url("${url}")` }}>
                  <button className="scene-pick" aria-label={`Use custom background ${i + 1}`} onClick={() => theme.setCustomBg(i)} />
                  <button className="scene-del" aria-label="Remove background" onClick={() => theme.removeCustomBg(i)}><X size={11} /></button>
                </div>
              ))}
            </div>
          )}
          <button className="upload-bg" disabled={full} onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Upload background
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden onChange={onPickFile} />
          <span className="appearance-hint">Static JPG, PNG, WebP, or AVIF · stored on this device</span>
        </div>

        <div className="appearance-group">
          <span className="appearance-label">Accent</span>
          <div className="swatches">
            {ACCENTS.map(([name, color]) => (
              <button key={name} className={`swatch${theme.accent === name ? " on" : ""}`}
                style={{ background: color }} title={name} aria-label={name} onClick={() => theme.setAccent(name)} />
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <div className="appearance-row">
            <span className="appearance-label">Darkness</span>
            <span className="appearance-count">{theme.darkness}%</span>
          </div>
          <input type="range" className="appearance-range" min={0} max={100} step={1} value={theme.darkness}
            onChange={(e) => theme.setDarkness(Number(e.target.value))} aria-label="Darkness" />
          <span className="appearance-hint">Dims the backdrop behind the panels.</span>
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
export function AppBar(
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
            <span className="brand-name">Warden</span>
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

/** Persistent steering composer docked at the board's edge when the supervisor
 *  rail is closed — the always-on channel to direct the run, surfaced instead of
 *  hidden behind an icon. Sends to the supervisor and opens the rail so the
 *  streamed reply (and its one-click suggestions) is immediately in view. */
export function SupervisorDock({ onExpand }: { onExpand: () => void }): JSX.Element {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const att = useAttachments();
  const send = async (): Promise<void> => {
    const text = msg.trim();
    if ((!text && !att.items.length) || busy) return;
    setBusy(true);
    try {
      await postJSON("/api/chat", { message: text + att.refs() });
      setMsg("");
      att.clear();
      onExpand(); // reveal the reply in the rail thread (pushed over SSE)
    } catch (err) {
      toast(String(err), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sup-dock-wrap" onDrop={att.drop} onDragOver={(e) => e.preventDefault()}>
      <AttachStrip items={att.items} onRemove={att.remove} />
      <div className="sup-dock">
        <button className="sup-dock-open" title="Open the supervisor" aria-label="Open the supervisor" onClick={onExpand}>
          <MessageCircle size={16} />
        </button>
        <input className="sup-dock-input" value={msg} placeholder="Tell the supervisor (paste an image too)…"
          onChange={(e) => setMsg(e.target.value)} onPaste={att.paste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="sup-dock-send" disabled={(!msg.trim() && !att.items.length) || busy} onClick={() => void send()} aria-label="Send to the supervisor">
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}

/** Which coding-agent CLI the cockpit is driving, probed server-side once. Stays
 *  hidden when the CLI isn't on PATH (nothing to show, no error noise). */
export function AgentVersionChip(): JSX.Element | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    fetchJSON<{ agentVersion?: string | null }>("/api/status")
      .then((s) => setV(s.agentVersion ?? null)).catch(() => setV(null));
  }, []);
  if (!v) return null;
  const label = v.replace(/^v/, "");
  return (
    <span className="agent-ver mono" title="The coding-agent CLI this cockpit drives">
      <Bot size={12} /> Claude Code v{label}
    </span>
  );
}

/** Big page title + synthesis dot + optional lead text and stat tiles on the right. */
export function PageHead(
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
export function StatTile({ value, label, color }: { value: ReactNode; label: string; color?: string }): JSX.Element {
  return (
    <div className="stat-tile">
      <span className="st-v" style={color ? { color } : undefined}>{value}</span>
      <span className="st-l">{label}</span>
    </div>
  );
}

export function SegBar({ segs }: { segs: Array<{ pct: number; color: string }> }): JSX.Element {
  return (
    <div className="seg-bar">
      {segs.map((s, i) => <div key={i} style={{ width: `${s.pct}%`, background: s.color }} />)}
    </div>
  );
}

export function ProjectCard({ p, onOpen, onEdit }: { p: PortfolioProject; onOpen: () => void; onEdit: () => void }): JSX.Element {
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
  const metric = (n: number, label: string) => (
    <div className="pm">
      <span className="pm-n" style={{ color: n > 0 ? "var(--ink)" : "var(--faint)" }}>{n}</span>
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
        {metric(c.working, "working")}
        {metric(c.needs, "attention")}
        {metric(c.queued, "up next")}
        {metric(c.merged, "merged")}
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
export function usePortfolio(): { projects: PortfolioProject[] | null; reload: () => void } {
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
export function Onboarding({ onOpen, onCreated }: { onOpen: (name: string) => void; onCreated: () => void }): JSX.Element {
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

  const reassure = project === "python" ? "Runs uv sync, then lands you in the cockpit."
    : project === "node" ? "Runs npm install, then lands you in the cockpit."
      : "Lands you straight in the cockpit.";

  return (
    <div className="onboard">
      <div className="onboard-mark" aria-hidden="true"><ShieldCheck size={30} strokeWidth={2} /></div>
      <div className="onboard-word">Warden</div>
      <h1 className="onboard-title">Let's set up your first project.</h1>
      <p className="onboard-thesis">A project is a work folder Warden drives agents against — in parallel, each behind one deterministic gate. No terminal needed.</p>

      <div className="onboard-card">
        <div className="onboard-group">
          <label className="work-label">Project name</label>
          <input className="input" placeholder="my-project" value={name} onChange={(e) => setName(e.target.value)} />
          {name.trim() && !nameOk && <p className="onboard-warn">Use only letters, numbers, dashes or underscores.</p>}
        </div>

        <div className="onboard-group">
          <label className="work-label">Repository / work folder</label>
          <input className="input" placeholder="C:\path\to\your\repo" value={folder} onChange={(e) => setFolder(e.target.value)} />
          <div className="seg onboard-seg">
            <button className={!fresh ? "on" : ""} onClick={() => setFresh(false)}>Use an existing repo</button>
            <button className={fresh ? "on" : ""} onClick={() => setFresh(true)}>Start fresh here</button>
          </div>
          {fresh && <p className="onboard-hint">The folder is created and <code>git init</code>'d with a first commit.</p>}
        </div>

        <div className="onboard-group onboard-row">
          <div className="onboard-col">
            <label className="work-label">Stack</label>
            <div className="seg onboard-seg">
              {(["node", "python", "other"] as const).map((p) => (
                <button key={p} className={project === p ? "on" : ""} onClick={() => setProject(p)}>
                  {p === "node" ? "Node" : p === "python" ? "Python" : "Other"}
                </button>
              ))}
            </div>
          </div>
          <div className="onboard-col">
            <label className="work-label">Budget · USD, optional</label>
            <input className="input num" type="number" min="0" placeholder="no cap" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
        </div>

        <div className="onboard-foot">
          <button className="btn primary onboard-go" disabled={!ready} onClick={() => void create()}>
            {busy ? "Setting up…" : <>Create project <ArrowRight size={14} /></>}
          </button>
          {!busy && <span className="onboard-reassure">{reassure}</span>}
        </div>
      </div>
    </div>
  );
}

/** Rename a project, set its per-project budget, or remove it from the dashboard. */
export function ProjectEditor(
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

export interface NetInfo { ip: string | null; port: number; url: string | null }

/**
 * "Open on your phone" card: shows a QR of the dashboard's LAN URL so the user
 * can point a phone camera at the screen and open the cockpit on the same Wi-Fi.
 * Hidden entirely when the machine has no reachable LAN address (e.g. offline).
 * The QR is drawn by our zero-dependency encoder (byte-mode, oracle-verified).
 */
export function PhoneCard({ theme }: { theme: Appearance }): JSX.Element | null {
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

export function ProjectsScreen(
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
        {list.length > 0 && (
          <PageHead title="Your projects" synthFam={need > 0 ? "blocked" : "merged"} synth={synth}
            stats={<>
              <StatTile value={list.length} label="Projects" />
              <StatTile value={working} label="Agents working" color="var(--st-working-fg)" />
              <StatTile value={need} label="Need you" color={need > 0 ? "var(--st-failed-fg)" : undefined} />
              <StatTile value={fmtUsd(spend)} label="Spent" />
            </>} />
        )}

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
      {showNew && <NewWorkModal variant="project" initialTab="goal" onClose={() => setShowNew(false)} onWorkspaceAdded={() => { /* the portfolio poll picks it up */ }} />}
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

export interface Fact { id: string; text: string; scope: "project" | "global"; ticketId: string | null; createdTs: string; applied?: number }

/** Show exactly what an agent changed for a merged ticket (B5). The range
 *  survives the deleted branch because both commits hang off the merge commit. */
export function DiffModal(
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
export function ReviewModal({ task, onClose }: { task: TaskModel; onClose: () => void }): JSX.Element {
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
export function RunGuardModal(
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
export const DESTRUCTIVE_HINT = /\b(reset\s+--hard|--force|force-with-lease|git\s+rebase|git\s+clean|filter-branch|checkout\s+--)\b/i;

// Safe, pre-wired replies. They fill the answer box (the operator still reviews and
// sends — control stays with the human) instead of running anything directly.
export const QUICK_REPLIES: Array<{ label: string; text: string }> = [
  { label: "Already done → no-op",
    text: "The ticket's change already exists in the repo. Do NOT reset, rebase, or "
      + "force anything. Report status \"done\" with \"noop\": true (already implemented)." },
  { label: "Don't rewrite history",
    text: "Do not run any destructive git command (reset --hard, rebase, force, clean). "
      + "Explain in one line what is actually missing, or report done/noop if nothing is." },
];

export function AnswerModal(
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

export function FactEditor(
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
            <Select className="wide" value={scope} onChange={(v) => setScope(v as "project" | "global")} ariaLabel="Scope"
              options={[{ value: "project", label: "This project only" }, { value: "global", label: "All projects (global)" }]} />
          </div>
          <div className="field">
            <label className="work-label">Origin ticket</label>
            <Select className="wide" value={ticketId} onChange={setTicketId} ariaLabel="Origin ticket"
              options={[{ value: "", label: "— None (manual) —" }, ...tasks.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))]} />
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

export function FactCard({ f, onEdit }: { f: Fact; onEdit: () => void }): JSX.Element {
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
export function useFacts(ws: string): { facts: Fact[] | null; reload: () => void } {
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

export function MemoryScreen(
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


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
import { Skeleton, StatusPill, WorkspaceInfo, toast, useEsc, useManagedInterval } from "./core.js";
import { FactEditor, useFacts } from "./screens.js";
import { Drawer, Select, quickRun, sendControl } from "./widgets.js";
import { RepoTools } from "./work.js";

export function describe(event: FactoryEvent): string {
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

/** Icon + human verb for a tool call, so an `act` step reads as a plain-language
 *  line ("Ran command") above the raw detail — not a bare tool name. Unknown
 *  tools fall back to the tool's own name with a neutral glyph. */
export const ACT_META: Record<string, { Icon: LucideIcon; verb: string }> = {
  Read: { Icon: FileText, verb: "Read a file" },
  Write: { Icon: Pencil, verb: "Wrote a file" },
  Edit: { Icon: Pencil, verb: "Edited a file" },
  MultiEdit: { Icon: Pencil, verb: "Edited files" },
  NotebookEdit: { Icon: Pencil, verb: "Edited a notebook" },
  Bash: { Icon: Terminal, verb: "Ran a command" },
  Grep: { Icon: Search, verb: "Searched the code" },
  Glob: { Icon: Search, verb: "Looked for files" },
  WebFetch: { Icon: Globe, verb: "Fetched a page" },
  WebSearch: { Icon: Globe, verb: "Searched the web" },
  TodoWrite: { Icon: ListChecks, verb: "Updated the plan" },
};
/** Tools whose detail is a file path the agent changed — used to tally "files touched". */
export const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function actMeta(tool: string): { Icon: LucideIcon; verb: string } {
  return ACT_META[tool] ?? { Icon: ChevronRight, verb: tool };
}

/** Icon for the non-`act` story kinds. */
export const KIND_ICON: Record<"say" | "final" | "subresult" | "delegate", LucideIcon> = {
  say: Lightbulb,
  final: Check,
  subresult: CornerDownRight,
  delegate: GitBranch,
};

/** Steer a parked branch back to a per-step checkpoint (AWAITING_APPROVAL only). */
export interface UndoCtl { checkpoints: Checkpoint[]; onUndo: (sha: string) => void }

/** One narrated step, in the timeline's stacked grammar: a typed glyph, a plain
 *  human line, and — for tool calls — the raw path/command dimmed beneath it. An
 *  edit step with a matching checkpoint gets a "rewind to here" affordance. */
export function StoryNode({ s, cp, onUndo }: { s: StoryItem; cp?: Checkpoint; onUndo?: (sha: string) => void }): JSX.Element {
  if (s.kind === "act") {
    const m = actMeta(s.tool);
    return (
      <div className="tl-node act">
        <span className="tl-glyph"><m.Icon size={13} /></span>
        <div className="tl-verb">
          {m.verb}
          {cp && onUndo && (
            <button className="tl-undo" title="Rewind the branch to this step — later changes are discarded"
              onClick={() => onUndo(cp.sha)}><Undo2 size={11} /> Rewind to here</button>
          )}
        </div>
        {s.detail && <div className="tl-detail mono">{s.detail}</div>}
      </div>
    );
  }
  const Icon = KIND_ICON[s.kind];
  const text = s.kind === "delegate"
    ? `Delegated to ${s.who}${s.mission ? ` — ${s.mission}` : ""}`
    : s.text;
  const label = s.kind === "say" ? "Thinking"
    : s.kind === "final" ? "Result"
    : s.kind === "subresult" ? "Sub-agent result" : "Delegated";
  return (
    <div className={`tl-node ${s.kind}`}>
      <span className="tl-glyph"><Icon size={13} /></span>
      <div className="tl-kind">{label}</div>
      <div className="tl-text">{text}</div>
    </div>
  );
}

/** A compact one-line tally of the run's footprint — tools invoked, distinct
 *  files the agent changed, and tokens spent — in the density of a status bar. */
export function StoryStats({ story, tokens }: { story: StoryItem[]; tokens: number }): JSX.Element | null {
  const acts = story.filter((s) => s.kind === "act") as Extract<StoryItem, { kind: "act" }>[];
  if (!acts.length && tokens <= 0) return null;
  const files = new Set(acts.filter((a) => EDIT_TOOLS.has(a.tool) && a.detail).map((a) => a.detail));
  const parts: string[] = [];
  if (acts.length) parts.push(`${acts.length} ${acts.length === 1 ? "tool" : "tools"}`);
  if (files.size) parts.push(`${files.size} ${files.size === 1 ? "file" : "files"}`);
  if (tokens > 0) parts.push(`${fmtTokens(tokens)} tokens`);
  return <div className="tl-foot mono">{parts.join(" · ")}</div>;
}

export function StoryView({ story, tokens = 0, undo }: { story: StoryItem[]; tokens?: number; undo?: UndoCtl }): JSX.Element {
  if (!story.length) return <p className="story-say">No activity recorded yet.</p>;
  // Checkpoints are recorded once per file-edit tool, oldest first — so the k-th
  // edit step maps to the k-th checkpoint. Track that index as we render.
  let editIdx = -1;
  return (
    <div className="tl">
      {story.map((s, i) => {
        let cp: Checkpoint | undefined;
        if (s.kind === "act" && EDIT_TOOLS.has(s.tool)) { editIdx++; cp = undo?.checkpoints[editIdx]; }
        return <StoryNode key={i} s={s} cp={cp} onUndo={undo?.onUndo} />;
      })}
      <StoryStats story={story} tokens={tokens} />
    </div>
  );
}

/** Measures row for the history modal: timer · cost · tokens · attempt. */
export function ModalMeasures({ t, now }: { t: TaskModel; now: number }): JSX.Element {
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

export function LogModal(
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
            : <StoryView story={story} tokens={t ? (t.liveTokens || t.tokens) : 0}
                undo={t && t.state === "AWAITING_APPROVAL" && live && t.checkpoints.length > 0
                  ? { checkpoints: t.checkpoints, onUndo: (sha) => void sendControl("undo", t.id, undefined, sha) }
                  : undefined} />}

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

export interface DockerStatus {
  engine: boolean; image: boolean; proxy: boolean; ready: boolean;
  detail?: string; building?: boolean; buildOk?: boolean | null; buildLog?: string;
}

/** Direct/Sandbox toggle with a live Docker preflight + one-click image build.
 *  Polls /api/docker only while Sandbox is selected, so a Direct project pays nothing. */
export function SandboxControl({ value, onChange }: {
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
export function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }): JSX.Element {
  return (
    <div className="setting-row">
      <div className="setting-text"><div className="setting-label">{label}</div><div className="setting-hint">{hint}</div></div>
      {children}
    </div>
  );
}

/** One settings section: an anchor target with a title, jumped to from the left
 *  nav. Always open — the nav replaces the old expand-to-find accordions. */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): JSX.Element {
  return (
    <section id={id} className="settings-section">
      <h4 className="settings-section-title">{title}</h4>
      {children}
    </section>
  );
}

/** Left-nav anchors for the settings drawer, in scroll order. General (the
 *  essentials) leads, so the panel still opens on "run without touching a thing". */
export const SETTINGS_SECTIONS: Array<{ id: string; label: string }> = [
  { id: "set-general", label: "General" },
  { id: "set-models", label: "Models & thinking" },
  { id: "set-project", label: "Project & repo" },
  { id: "set-safety", label: "Execution & safety" },
  { id: "set-notify", label: "Notifications" },
];

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [activeSec, setActiveSec] = useState(SETTINGS_SECTIONS[0]!.id);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // Scroll-spy: highlight the section currently under the top of the scroll area,
  // so the left nav always reflects where you are. Runs once the sections exist.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !s) return;
    const secs = SETTINGS_SECTIONS
      .map((x) => document.getElementById(x.id))
      .filter((el): el is HTMLElement => el !== null);
    const obs = new IntersectionObserver((entries) => {
      const top = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActiveSec(top.target.id);
    }, { root, rootMargin: "0px 0px -70% 0px", threshold: 0 });
    secs.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [s]);

  const jump = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
    setActiveSec(id);
  };

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

  if (!s) return <Drawer title="Settings" wide onClose={onClose}><div className="panel-body"><Skeleton lines={8} /></div></Drawer>;

  const effortChoices = [...EFFORT_CHOICES];
  if (s.effort && !effortChoices.some(([v]) => v === s.effort)) effortChoices.push([s.effort, `${s.effort} (expensive)`]);
  const planChoices: Array<[string, string]> = [["", "Same as coders"], ["haiku", "Haiku (cheapest)"], ["sonnet", "Sonnet"]];
  if (s.planModel && !planChoices.some(([v]) => v === s.planModel)) planChoices.push([s.planModel, s.planModel]);
  const modelChoices = [...MODEL_CHOICES];
  if (s.model && !modelChoices.some(([v]) => v === s.model)) modelChoices.push([s.model, s.model]);

  return (
    <Drawer title="Settings" wide onClose={onClose} foot={
      <>
        <button className="btn ghost" disabled={testing} onClick={() => void doTest()}><FlaskConical size={14} /> Test these settings</button>
        <button className="btn primary" onClick={async () => {
          try { await save(); toast("Saved. Your next run uses these settings."); onClose(); }
          catch (err) { toast(String(err), true); }
        }}>Save</button>
      </>
    }>
      <div className="panel-body settings-form" ref={scrollRef}>
        <p className="settings-intro">Sensible defaults are already set — you can run without changing a thing. Tweak these only if you want to.</p>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Jump to a settings section">
            {SETTINGS_SECTIONS.map((sec) => (
              <button key={sec.id} type="button" className={`settings-nav-item${activeSec === sec.id ? " on" : ""}`}
                onClick={() => jump(sec.id)}>{sec.label}</button>
            ))}
          </nav>
          <div className="settings-panes">
            <Section id="set-general" title="General">
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
            <Select value={s.model} onChange={(v) => set({ model: v })} ariaLabel="Coding model"
              options={modelChoices.map(([value, label]) => ({ value, label }))} />
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
            </Section>

            <Section id="set-models" title="Models & thinking">
          <Row label="Planning model" hint="The ticket-maker explores the repo once and saves a reusable map. A cheaper tier here cuts planning cost. Default matches the coding model.">
            <Select value={s.planModel} onChange={(v) => set({ planModel: v })} ariaLabel="Planning model"
              options={planChoices.map(([value, label]) => ({ value, label }))} />
          </Row>
          <Row label="Reasoning effort" hint="How hard each agent thinks. Higher digs deeper but is slower and costs more. Default lets the agent decide.">
            <Select value={s.effort} onChange={(v) => set({ effort: v })} ariaLabel="Reasoning effort"
              options={effortChoices.map(([value, label]) => ({ value, label }))} />
          </Row>
          <Row label="Code reviewer" hint="A second AI double-checks every change before merge: scope, gamed tests, obvious bugs.">
            <input type="checkbox" className="switch" checked={s.reviewer} onChange={(e) => set({ reviewer: e.target.checked })} />
          </Row>
          <Row label="Internet access" hint="Agents may search and read the web. Needed for research; adds exposure to web content.">
            <input type="checkbox" className="switch" checked={s.internet} onChange={(e) => set({ internet: e.target.checked })} />
          </Row>
            </Section>

            <Section id="set-project" title="Project & repository">
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
            </Section>

            <Section id="set-safety" title="Execution & safety">
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
            </Section>

            <Section id="set-notify" title="Notifications">
          <Row label="Notify me" hint="Get pinged when a run finishes or a ticket needs you. Paste a Slack, Discord, or any incoming-webhook URL. Empty = off. Fires server-side, so it works with the browser closed.">
            <input className="input" type="url" value={s.webhookUrl} placeholder="https://hooks.slack.com/services/…" onChange={(e) => set({ webhookUrl: e.target.value })} />
          </Row>
            </Section>

            {testOut !== null && <pre className="doctor-result">{testOut}</pre>}
          </div>
        </div>
      </div>
    </Drawer>
  );
}

/* --------------------------------- Knowledge (docs) modal --------------------------------- */

export interface KnowledgeDoc {
  id: string; name: string; size: number; addedTs: string; chunks: number | null; error?: string;
}

export function DocsModal({ onClose }: { onClose: () => void }): JSX.Element {
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


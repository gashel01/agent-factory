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
  DollarSign, ExternalLink, Eye, FileText, FlaskConical, Flag, Folder, FolderOpen, FolderPlus,
  GitBranch, GitMerge, Globe, InfinityIcon, Key, Laptop, Lightbulb, ListChecks, Lock, MessageCircle,
  MoreHorizontal, Palette, Pause, Pencil, Play, Plus, RotateCw, Search, Send,
  ShieldCheck, Smartphone, Sparkles, Square, Terminal, Timer, Trash2, TriangleAlert, Undo2, Upload, X,
} from "./icons.js";
import type { LucideIcon } from "./icons.js";
import { Button, Skeleton, StatusPill, WorkspaceInfo, toast, useEsc, useManagedInterval } from "./core.js";
import { FactEditor, useFacts } from "./screens.js";
import { Drawer, Modal, Select, quickRun, sendControl } from "./widgets.js";
import { RepoTools } from "./work.js";

export function describe(event: FactoryEvent): string {
  const tag = event.task ? `[${event.task}] ` : "";
  const e = event as unknown as Record<string, unknown>;
  switch (event.event) {
    case "state": return `${tag}${e["from"]} → ${e["to"]}`;
    case "agent_result": return `${tag}agent ${e["status"]} (${e["turns"] ?? "?"} turns${e["cost_usd"] ? `, ${fmtUsd(e["cost_usd"] as number)}` : ""})`;
    case "verify": return `${tag}verify ${e["ok"] ? "ok" : "FAILED: " + (e["failures"] as string[]).join("; ")}`;
    case "retry": return `${tag}retry #${e["attempt"]}: ${e["reason"]}`;
    case "escalate": return `${tag}escalated model ${e["from"]} → ${e["to"]}`;
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
          <Row label="Coding model" hint="The starting model for every coding agent — cheapest is fine: a ticket that fails verify automatically retries on a stronger tier (haiku → sonnet → opus). A ticket can still pin its own.">
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
          <Row label="Delivery: a PR per ticket" hint="OFF (default): each verified ticket merges straight into the base branch — one integrated result lands locally. ON: each verified ticket is pushed to its own branch and opened as a GitHub PR instead — your base branch does NOT move until you merge those PRs yourself, and a batch becomes several separate PRs to review. Needs a connected GitHub repo.">
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

/* --------------------------------- insights: diagnostics + forecast --------------------------------- */

/* `/api/diagnostics` and `/api/forecast` — and the pure `diagnose` / `forecast`
 * modules behind them — ship with a sibling ticket. Until they land, their
 * payloads are read here as untrusted JSON: every field goes through a small
 * reader, so a missing or oddly-shaped key degrades to an empty slot in the UI
 * instead of throwing. When the modules are merged, these readers are the one
 * place to swap for their exported types. */
const asRec = (v: unknown): Record<string, unknown> =>
  (v !== null && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const asStr = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const asNum = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v)) ? v : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A confidence on the wire may be a 0–1 ratio or an already-scaled percentage. */
function pct(v: number | null): number | null {
  if (v === null) return null;
  return Math.max(0, Math.min(100, Math.round(v <= 1 ? v * 100 : v)));
}

export interface DiagnosisStep { when: string; text: string }
export interface DiagnosisEvidence { source: string; text: string }
/** A recommendation with an `op` is actionable: it maps to an /api/control op. */
export interface DiagnosisFix { label: string; detail: string; op: string; task: string }
export interface Diagnosis {
  category: string; headline: string; detail: string; confidence: number | null;
  timeline: DiagnosisStep[]; evidence: DiagnosisEvidence[]; recommendations: DiagnosisFix[];
}

/** Human wording per diagnosis category. An unlisted one (or "unknown") falls
 *  back to the raw category — "no conclusive cause" is a normal answer here,
 *  not an error state. */
export const DX_CATEGORY: Record<string, string> = {
  verify: "Verification failed",
  test: "Tests failed",
  build: "Build broke",
  timeout: "Ran out of time",
  budget: "Budget reached",
  merge: "Merge conflict",
  blocked: "Needed an answer",
  agent: "The agent gave up",
  infra: "Environment problem",
  scope: "Ticket scope problem",
  unknown: "No conclusive cause",
};

function parseDiagnosis(raw: unknown): Diagnosis {
  // The endpoint wraps the diagnosis as {ok, run, task, diagnosis, summary}, so
  // unwrap it — reading the fields off the envelope gave an all-empty diagnosis
  // every time, which the modal reported as "no failure was recorded".
  const top = asRec(raw);
  const d = asRec(top["diagnosis"] ?? top);
  return {
    category: asStr(d["category"]) || "unknown",
    headline: asStr(d["headline"]),
    detail: asStr(d["detail"]),
    confidence: asNum(d["confidence"]),
    timeline: asArr(d["timeline"])
      .map((s): DiagnosisStep => {
        if (typeof s === "string") return { when: "", text: s };
        const o = asRec(s);
        return { when: asStr(o["ts"] ?? o["at"]), text: asStr(o["text"] ?? o["label"]) };
      })
      .filter((s) => s.text || s.when),
    evidence: asArr(d["evidence"])
      .map((e): DiagnosisEvidence => {
        if (typeof e === "string") return { source: "", text: e };
        const o = asRec(e);
        return { source: asStr(o["source"] ?? o["file"]), text: asStr(o["text"] ?? o["excerpt"]) };
      })
      .filter((e) => e.text),
    recommendations: asArr(d["recommendations"])
      .map((r): DiagnosisFix => {
        const o = asRec(r);
        return {
          label: asStr(o["label"]), detail: asStr(o["detail"]),
          op: asStr(o["op"]), task: asStr(o["task"]),
        };
      })
      .filter((r) => r.label || r.detail),
  };
}

/**
 * "Why did it fail?" — the post-mortem for one failed ticket. It answers the
 * three questions an operator actually has: what happened, what proves it, and
 * what to do next. The evidence stays verbatim in a monospace block — restyling
 * a log excerpt into prose would make it read as our words, not the agent's.
 */
export function DiagnosticsModal(
  { taskId, title, run, onClose }:
  { taskId: string; title: string; run?: string | null; onClose: () => void },
): JSX.Element {
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setDiag(null); setErr(null);
    const q = `/api/diagnostics?task=${encodeURIComponent(taskId)}`
      + (run ? `&run=${encodeURIComponent(run)}` : "");
    void fetchJSON<Record<string, unknown>>(q)
      .then((r) => { if (alive) setDiag(parseDiagnosis(r)); })
      .catch((e: unknown) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [taskId, run, attempt]);

  const conf = pct(diag?.confidence ?? null);
  const empty = diag !== null && !diag.headline && !diag.detail
    && diag.timeline.length === 0 && diag.evidence.length === 0 && diag.recommendations.length === 0;

  return (
    <Modal title="Why did it fail?" onClose={onClose} wide>
      <div className="dx">
        <div className="dx-task"><span className="kcard-id">{taskId}</span> {title}</div>

        {err !== null && (
          <div className="dx-error" role="alert">
            <TriangleAlert size={14} />
            <div className="dx-error-body">
              <b>No diagnosis available.</b> The dashboard couldn’t reach the failure analysis.
              <div className="dx-error-detail mono">{err}</div>
            </div>
            <button className="btn ghost" onClick={() => setAttempt((n) => n + 1)}><RotateCw size={13} /> Try again</button>
          </div>
        )}

        {err === null && diag === null && <Skeleton lines={5} />}

        {err === null && empty && (
          <p className="hint">Nothing to analyse for this ticket yet — no failure was recorded in its run.</p>
        )}

        {err === null && diag !== null && !empty && (
          <>
            <div className="dx-verdict">
              <div className="dx-verdict-top">
                <span className={`dx-cat dx-cat-${diag.category}`}>{DX_CATEGORY[diag.category] ?? diag.category}</span>
                {conf !== null && (
                  <span className="dx-conf" title="How sure this reading is">
                    <span className="tnum">{conf}%</span> confident
                  </span>
                )}
              </div>
              {diag.headline && <h4 className="dx-headline">{diag.headline}</h4>}
              {diag.detail && <p className="dx-detail">{diag.detail}</p>}
              {diag.category === "unknown" && (
                <p className="dx-hedge">The signals don’t point at one cause — the excerpts below are the raw material to judge for yourself.</p>
              )}
            </div>

            {diag.recommendations.length > 0 && (
              <section className="dx-block">
                <h5 className="dx-h"><Lightbulb size={13} /> What to do next <span className="dx-h-note">best first</span></h5>
                <ol className="dx-fixes">
                  {diag.recommendations.map((f, i) => (
                    <li key={i} className="dx-fix">
                      <div className="dx-fix-body">
                        <div className="dx-fix-label">{f.label}</div>
                        {f.detail && <div className="dx-fix-detail">{f.detail}</div>}
                      </div>
                      {f.op && (
                        <Button kind="btn" variant={i === 0 ? "primary" : "ghost"} autoPending
                          onClick={() => sendControl(f.op, f.task || taskId)}>{f.op}</Button>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {diag.timeline.length > 0 && (
              <section className="dx-block">
                <h5 className="dx-h"><ListChecks size={13} /> How it got there</h5>
                <ol className="dx-timeline">
                  {diag.timeline.map((s, i) => (
                    <li key={i}>
                      <span className="dx-step-n tnum">{i + 1}</span>
                      <span className="dx-step-text">{s.text}</span>
                      {s.when && <span className="dx-step-when mono">{s.when}</span>}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {diag.evidence.length > 0 && (
              <section className="dx-block">
                <h5 className="dx-h"><FileText size={13} /> Raw excerpts <span className="dx-h-note">verbatim, unedited</span></h5>
                {diag.evidence.map((e, i) => (
                  <div key={i} className="dx-ev">
                    {e.source && <div className="dx-ev-src mono">{e.source}</div>}
                    <pre className="dx-ev-text mono">{e.text}</pre>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------ pre-launch cost estimate ------------------------------ */

export type RunProfile = "cheap" | "standard" | "thorough";

export const RUN_PROFILES: Array<{ key: RunProfile; label: string; blurb: string }> = [
  { key: "cheap", label: "Cheap", blurb: "Smaller model, fewer retries. Good for mechanical tickets." },
  { key: "standard", label: "Standard", blurb: "Your configured setup — the usual balance." },
  { key: "thorough", label: "Thorough", blurb: "More thinking, more retries. For the ones that keep failing." },
];

export interface ForecastTicket { id: string; title: string; usd: number; durationS: number | null }
export interface ProfileForecast {
  profile: RunProfile;
  usd: number; lowUsd: number | null; highUsd: number | null;
  durationS: number | null; basis: string; confidence: number | null;
  tickets: ForecastTicket[];
  /** The server's own object, posted back with /api/run so the run records the
   *  estimate it was launched against. */
  raw: unknown;
}

/** How the number was reached — stated plainly, because a heuristic guess and a
 *  history-backed estimate deserve very different trust. */
export const FORECAST_BASIS: Record<string, string> = {
  history: "based on your past runs",
  heuristic: "a heuristic guess — no comparable run yet",
  blend: "your past runs blended with a heuristic",
};

function parseProfileForecast(profile: RunProfile, raw: unknown): ProfileForecast {
  const f = asRec(raw);
  const range = asRec(f["range"]);
  return {
    profile,
    usd: asNum(f["usd"]) ?? asNum(f["totalUsd"]) ?? 0,
    lowUsd: asNum(f["lowUsd"]) ?? asNum(range["low"]),
    highUsd: asNum(f["highUsd"]) ?? asNum(range["high"]),
    durationS: asNum(f["durationS"]) ?? asNum(f["etaS"]),
    basis: asStr(f["basis"]),
    confidence: asNum(f["confidence"]),
    tickets: asArr(f["tickets"] ?? f["perTicket"]).map((t): ForecastTicket => {
      const o = asRec(t);
      return {
        id: asStr(o["id"]), title: asStr(o["title"]),
        usd: asNum(o["usd"]) ?? 0, durationS: asNum(o["durationS"]) ?? asNum(o["etaS"]),
      };
    }),
    raw,
  };
}

/** The payload may key its forecasts by profile or list them — accept both. */
function parseForecasts(raw: unknown): Map<RunProfile, ProfileForecast> {
  const top = asRec(raw);
  const box: unknown = top["forecasts"] ?? top["profiles"] ?? raw;
  const pairs: Array<[string, unknown]> = Array.isArray(box)
    ? box.map((f): [string, unknown] => [asStr(asRec(f)["profile"]), f])
    : Object.entries(asRec(box));
  const out = new Map<RunProfile, ProfileForecast>();
  for (const [key, value] of pairs) {
    const p = RUN_PROFILES.find((x) => x.key === key);
    if (p) out.set(p.key, parseProfileForecast(p.key, value));
  }
  return out;
}

/**
 * The last thing between the operator and a run that spends money: how many
 * tickets go out, what each profile is likely to cost, and where the budget
 * stands. Everything the old run guard warned about is still here — API mode,
 * sandbox readiness, the budget cap — because a nicer estimate is no excuse to
 * drop a warning. If the forecast can't be fetched the dialog degrades to that
 * plain confirmation: the operator can always launch.
 */
export function RunEstimateModal(
  { tickets, budgetUsd, avgCost, onClose, onSettings }:
  { tickets: number; budgetUsd: number | null; avgCost: number | null;
    onClose: () => void; onSettings: () => void },
): JSX.Element {
  const [profile, setProfile] = useState<RunProfile>("standard");
  const [forecasts, setForecasts] = useState<Map<RunProfile, ProfileForecast> | null>(null);
  const [fcErr, setFcErr] = useState(false);
  // The guard is about the NEXT run, so read the current settings (not the last
  // run's mode) — a toggle saved but not yet run must still warn.
  const [apiMode, setApiMode] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [dockerReady, setDockerReady] = useState<boolean | null>(null);
  const [project, setProject] = useState<"node" | "python" | "other">("other");
  const [setupCmds, setSetupCmds] = useState("");
  // Delivery target. Default: merge into the configured base (unchanged behaviour).
  // Opt in to a fresh integration branch — the factory creates + checks it out, so
  // a big refactor lands as ONE PR with the base untouched, no CLI, no branch sprawl.
  const [deliverNew, setDeliverNew] = useState(false);
  const [branch, setBranch] = useState(
    () => "integrate/" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"),
  );

  useEffect(() => {
    let alive = true;
    void fetchJSON<Record<string, unknown>>("/api/forecast")
      .then((r) => { if (alive) setForecasts(parseForecasts(r)); })
      .catch(() => { if (alive) { setForecasts(new Map()); setFcErr(true); } });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    void fetchJSON<{ content: string }>("/api/config")
      .then((r) => {
        const s = parseSettings(r.content);
        setApiMode(s.executionMode === "api");
        setSandbox(s.isolation === "sandbox");
        setProject(s.project);
        setSetupCmds(s.setupCommands);
      })
      .catch(() => { /* offline */ });
  }, []);
  useEffect(() => {
    if (!sandbox) { setDockerReady(null); return; }
    void fetchJSON<DockerStatus>("/api/docker")
      .then((d) => setDockerReady(Boolean(d.engine) && Boolean(d.image)))
      .catch(() => setDockerReady(false));
  }, [sandbox]);

  const sel = forecasts?.get(profile) ?? null;
  const noCap = budgetUsd === null || budgetUsd <= 0;
  const overCap = sel !== null && !noCap && (sel.highUsd ?? sel.usd) > budgetUsd!;
  const conf = pct(sel?.confidence ?? null);
  const fallback = avgCost !== null ? avgCost * tickets : null;
  // Environment check: a node/python project whose setup installs nothing means
  // each agent's fresh worktree has no deps, so verify dies with "command not
  // found" (the flaky class that bit us). Warn before spending, not after.
  const needsInstall =
    (project === "node" && !/\b(install|ci)\b/.test(setupCmds)) ||
    (project === "python" && !/uv sync|pip install/.test(setupCmds));

  const base = deliverNew && branch.trim() ? branch.trim() : undefined;
  const start = async (): Promise<void> => {
    try {
      await postJSON("/api/run", { profile, ...(sel ? { forecast: sel.raw } : {}), ...(base ? { base } : {}) });
      toast(base
        ? `Run starting on ${base} — delivers as one PR, base untouched.`
        : `Run starting on the ${profile} profile — remaining tickets replay with the current config.`);
      onClose();
    } catch (err) { toast(String(err), true); }
  };

  return (
    <Modal title="Start this run?" onClose={onClose} wide>
      <div className="work-form">
        <div className="run-guard-line">
          <span className="rg-n">{tickets}</span>
          <span>ticket{tickets === 1 ? "" : "s"} will run (everything not yet merged).</span>
        </div>

        <div className="rf-profiles" role="radiogroup" aria-label="Run profile">
          {RUN_PROFILES.map((p) => {
            const f = forecasts?.get(p.key) ?? null;
            return (
              <button key={p.key} role="radio" aria-checked={profile === p.key}
                className={`rf-profile${profile === p.key ? " on" : ""}`} onClick={() => setProfile(p.key)}>
                <span className="rf-profile-name">{p.label}</span>
                <span className="rf-profile-cost tnum">{f ? fmtUsd(f.usd) : "—"}</span>
                <span className="rf-profile-blurb">{p.blurb}</span>
              </button>
            );
          })}
        </div>

        <div className="run-deliver">
          <div className="rd-head">Deliver to</div>
          <label className={`rd-opt${!deliverNew ? " on" : ""}`}>
            <input type="radio" name="deliver" checked={!deliverNew} onChange={() => setDeliverNew(false)} />
            <span><b>The base branch</b> — verified tickets merge straight in.</span>
          </label>
          <label className={`rd-opt${deliverNew ? " on" : ""}`}>
            <input type="radio" name="deliver" checked={deliverNew} onChange={() => setDeliverNew(true)} />
            <span><b>A new integration branch</b> — base untouched, lands as one PR you open from here.</span>
          </label>
          {deliverNew && (
            <input className="rd-branch" value={branch} aria-label="Integration branch name"
              placeholder="integrate/…"
              onChange={(e) => setBranch(e.currentTarget.value.replace(/[^\w./-]/g, ""))} />
          )}
        </div>

        {forecasts === null && <Skeleton lines={3} />}

        {sel !== null && (
          <div className="rf-estimate">
            <div className="rf-figures">
              <div className="rf-fig">
                <span className="rf-fig-n tnum">{fmtUsd(sel.usd)}</span>
                <span className="rf-fig-k"><DollarSign size={12} /> estimated total</span>
                {(sel.lowUsd !== null || sel.highUsd !== null) && (
                  <span className="rf-range tnum">
                    {fmtUsd(sel.lowUsd ?? sel.usd)} – {fmtUsd(sel.highUsd ?? sel.usd)}
                  </span>
                )}
              </div>
              {sel.durationS !== null && (
                <div className="rf-fig">
                  <span className="rf-fig-n tnum">{fmtDuration(sel.durationS)}</span>
                  <span className="rf-fig-k"><Timer size={12} /> estimated wall time</span>
                </div>
              )}
            </div>
            <div className="rf-basis">
              {FORECAST_BASIS[sel.basis] ?? "estimate"}
              {conf !== null && <> · <span className="tnum">{conf}%</span> confidence</>}
            </div>
            {sel.tickets.length > 0 && (
              <ul className="rf-breakdown">
                {sel.tickets.map((t, i) => (
                  <li key={t.id || i}>
                    <span className="kcard-id">{t.id}</span>
                    <span className="rf-bd-title">{t.title}</span>
                    {t.durationS !== null && <span className="rf-bd-dur tnum">{fmtDuration(t.durationS)}</span>}
                    <span className="rf-bd-cost tnum">{fmtUsd(t.usd)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {fcErr && (
          <p className="work-hint">
            No estimate this time — the forecast didn’t answer. {fallback !== null
              ? <>Your past runs averaged <b>{fmtUsd(avgCost!)}</b> per merged ticket, so roughly <b>{fmtUsd(fallback)}</b> for this one. A rough guide, not a quote.</>
              : <>You can still start the run.</>}
          </p>
        )}

        {needsInstall && (
          <div className="run-guard-budget warn">
            <TriangleAlert size={14} /> <b>No dependency install in setup</b> — agents work in fresh worktrees, so verify may fail with “command not found”. Add <code>{project === "python" ? "uv sync" : "npm install"}</code> to setup.
            <button className="btn link" onClick={onSettings}>Fix in Settings</button>
          </div>
        )}
        {apiMode && (
          <div className="run-guard-budget warn">
            <Key size={14} /> <b>API mode</b> — this run bills real dollars to your <code>ANTHROPIC_API_KEY</code>.
            <button className="btn link" onClick={onSettings}>Switch to Subscription</button>
          </div>
        )}
        {sandbox && (
          dockerReady === false ? (
            <div className="run-guard-budget warn">
              <Lock size={14} /> <b>Sandbox selected, but Docker isn’t ready</b> — the run will fail until the engine is up and the image is built.
              <button className="btn link" onClick={onSettings}>Fix in Settings</button>
            </div>
          ) : (
            <div className="run-guard-budget">
              <Lock size={14} /> <b>Sandbox mode</b> — agents run confined: only their worktree is visible, egress limited to Anthropic.
            </div>
          )
        )}

        <div className={`run-guard-budget${noCap || overCap ? " warn" : ""}`}>
          {noCap
            ? <>No budget cap — this run can spend without a limit. <button className="btn link" onClick={onSettings}>Set a cap</button></>
            : overCap
              ? <>Budget cap in force: <b>{fmtUsd(budgetUsd!)}</b> — the high end of this estimate goes past it, so the run may stop before every ticket is done. <button className="btn link" onClick={onSettings}>Raise it</button></>
              : <>Budget cap in force: <b>{fmtUsd(budgetUsd!)}</b>. The run stops launching new agents once it’s reached.</>}
        </div>
      </div>
      <div className="panel-foot spread modal-foot">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <Button kind="btn" variant="primary" autoPending onClick={start}><Play size={14} /> Start run</Button>
      </div>
    </Modal>
  );
}


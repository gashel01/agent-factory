/** Agent Factory dashboard — React app. Mounts into #app. */

import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { FactoryEvent, TaskState } from "./types.js";
import {
  api, fetchJSON, getText, getWs, initWs, postJSON, repoGet, repoPath, setRepoPath, setWs,
} from "./api.js";
import {
  ACTIVITY, EFFORT_CHOICES, Model, STATE_ICON, Settings, StoryItem, TaskModel,
  ago, fmtDuration, fmtTokens, fmtUsd, freshModel, generateConfig, inFlight, narrate,
  parseSettings, reduce,
} from "./model.js";

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

/* --------------------------------- hooks --------------------------------- */

/** SSE stream folded into a model; returns [model, tick] and resets per run. */
function useEventStream(ws: string): [Model, number] {
  const modelRef = useRef<Model>(freshModel(""));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    modelRef.current = freshModel("");
    const bump = (): void => setTick((t) => t + 1);
    const source = new EventSource(api("/api/events"));
    source.addEventListener("run", (e) => {
      const { run } = JSON.parse((e as MessageEvent).data) as { run: string | null };
      modelRef.current = freshModel(run ?? "");
      bump();
    });
    source.onmessage = (e) => {
      try { reduce(modelRef.current, JSON.parse(e.data) as FactoryEvent); } catch { return; }
      bump();
    };
    return () => source.close();
  }, [ws]);
  return [modelRef.current, tick];
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

interface WorkspaceInfo { name: string; workdir: string; currentRun: string | null }

/* --------------------------------- widgets --------------------------------- */

function ConfirmButton(
  { label, confirm, onConfirm, className = "danger-soft" }:
  { label: string; confirm: string; onConfirm: () => void; className?: string },
): JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      className={`btn ${className}${armed ? " armed" : ""}`}
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
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`panel${wide ? " wide" : ""}`}>
        <div className="panel-head">
          <h3>{title}</h3>
          <button className="btn icon" onClick={onClose}>✕</button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}

/* --------------------------------- controls --------------------------------- */

async function sendControl(op: string, taskId?: string): Promise<void> {
  try {
    await postJSON("/api/control", { op, task: taskId });
    const messages: Record<string, string> = {
      pause: "Pausing — running agents finish, no new ones start.",
      resume: "Resuming.",
      stop: "Stopping — running agents finish, the rest stays queued.",
      kill: `Stopping the agent on ${taskId}…`,
      retry: `${taskId} is back in the queue with a fresh budget.`,
    };
    toast(messages[op] ?? "Sent.");
  } catch (err) { toast(`Could not send the command: ${String(err)}`, true); }
}

async function quickRun(): Promise<void> {
  try {
    await postJSON("/api/run", {});
    toast("New run starting — remaining tickets replay with the current config.");
  } catch (err) { toast(String(err), true); }
}

/* --------------------------------- board --------------------------------- */

type ModalState =
  | null
  | { type: "settings" }
  | { type: "supervisor" }
  | { type: "newwork" }
  | { type: "repo" }
  | { type: "preview" }
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

function Progress({ tasks }: { tasks: TaskModel[] }): JSX.Element {
  const total = tasks.length || 1;
  const done = tasks.filter((t) => t.state === "DONE").length;
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const active = tasks.filter((t) => inFlight(t.state)).length;
  const seg = (cls: string, n: number) =>
    n ? <div key={cls} className={`progress-seg ${cls}`} style={{ width: `${(n / total) * 100}%` }} /> : null;
  return <div className="progress">{seg("done", done)}{seg("failed", failed)}{seg("active", active)}</div>;
}

function UsageStrip({ model }: { model: Model }): JSX.Element | null {
  const tasks = [...model.tasks.values()];
  const spent = model.spentUsd || tasks.reduce((s, t) => s + t.costUsd, 0);
  const tokens = tasks.reduce((s, t) => s + t.tokens, 0);
  if (spent === 0 && model.budgetUsd === null) return null;
  const pct = model.budgetUsd ? Math.min(100, (spent / model.budgetUsd) * 100) : 0;
  return (
    <div className="usage-strip">
      <div className="usage-left">
        <span className="usage-figure">{fmtUsd(spent)}</span>
        <span className="usage-label">spent this run · {fmtTokens(tokens)} tokens</span>
      </div>
      {model.budgetUsd !== null && model.budgetUsd > 0 && (
        <div className="usage-right">
          <div className="budget-bar">
            <div className={`budget-fill${pct >= 100 ? " over" : pct >= 80 ? " warn" : ""}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="budget-cap">{fmtUsd(spent)} / {fmtUsd(model.budgetUsd)} budget</div>
        </div>
      )}
    </div>
  );
}

function TaskCard(
  { t, kind, live, now, onLog }:
  { t: TaskModel; kind: string; live: boolean; now: number; onLog: () => void },
): JSX.Element {
  const facts: string[] = [];
  if (t.turns !== null) facts.push(`${t.turns} steps`);
  if (t.wallS !== null && t.state !== "RUNNING") facts.push(fmtDuration(t.wallS));
  if (t.costUsd > 0) facts.push(`${fmtUsd(t.costUsd)} · ${fmtTokens(t.tokens)} tok`);
  if (t.retries > 0) facts.push(`attempt ${t.retries + 1}`);
  const watching = inFlight(t.state);
  return (
    <article className={`card ${kind} state-${t.state.toLowerCase()}`}>
      <div className="card-head">
        <span className="card-activity">{STATE_ICON[t.state]} {ACTIVITY[t.state]}</span>
        {t.state === "RUNNING" && t.runningSince
          ? <span className="card-timer">{fmtDuration((now - t.runningSince) / 1000)}</span>
          : t.finishedAt ? <span className="card-timer">{ago(t.finishedAt)}</span> : null}
      </div>
      <div className="card-title">{t.title}</div>
      {t.note && <div className={`card-note${kind === "attention" ? " loud" : ""}`}>{t.note}</div>}
      {facts.length > 0 && <div className="card-facts">{facts.join(" · ")}</div>}
      <div className="card-actions">
        {(t.state === "FAILED" || t.state === "BLOCKED") && (
          live
            ? <button className="btn primary" onClick={() => void sendControl("retry", t.id)}>↻ Try again</button>
            : <button className="btn primary" onClick={() => void quickRun()}>▶ Run again (new run)</button>
        )}
        {t.state === "RUNNING" && live && (
          <ConfirmButton label="Stop this agent" confirm="Sure? Click again" onConfirm={() => void sendControl("kill", t.id)} />
        )}
        <button className={`btn ${watching ? "primary" : "ghost"}`} onClick={onLog}>
          {watching ? "👁 Watch live" : "What did it do?"}
        </button>
      </div>
    </article>
  );
}

function Zone({ title, cls, children }: { title: string; cls: string; children: ReactNode }): JSX.Element {
  return (
    <section className={`zone ${cls}`}>
      <h2>{title}</h2>
      <div className="zone-grid">{children}</div>
    </section>
  );
}

/* --------------------------------- App --------------------------------- */

function App(): JSX.Element {
  const [ws, setWsState] = useState(getWs());
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [model, tick] = useEventStream(ws);
  const runActive = useRunActive(tick);
  const anyRunning = [...model.tasks.values()].some((t) => t.runningSince !== null);
  const now = useNow(anyRunning || model.ratePause !== null);

  const loadWorkspaces = async (): Promise<void> => {
    try {
      const { workspaces: list } = await fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
      setWorkspaces(list);
      if (!list.some((w) => w.name === ws)) { setWs(list[0]?.name ?? ""); setWsState(list[0]?.name ?? ""); }
    } catch { /* offline */ }
  };
  useEffect(() => { void loadWorkspaces(); }, []);

  const tasks = [...model.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  const head = headline(model, runActive);
  const live = Boolean(model.run) && !model.endedTs && runActive;
  const done = tasks.filter((t) => t.state === "DONE");
  const attention = tasks.filter((t) => t.state === "BLOCKED" || t.state === "FAILED");
  const working = tasks.filter((t) => inFlight(t.state));
  const queued = tasks.filter((t) => t.state === "QUEUED");
  const openLog = (t: TaskModel) => setModal({ type: "log", taskId: t.id, title: t.title });

  return (
    <>
      <header className={`topbar tone-${head.tone}`}>
        <div className="topbar-left">
          <div className="headline">{head.text}</div>
          <div className="subline">
            {done.length} of {tasks.length} merged · run {model.run || "—"}
            {model.startedTs ? ` · started ${ago(model.startedTs)}` : ""}
          </div>
        </div>
        <div className="topbar-controls">
          {workspaces.length > 0 && (
            <select className="picker" value={ws}
              onChange={(e) => {
                if (e.target.value === "__add__") { setModal({ type: "newwork" }); return; }
                setWs(e.target.value); setWsState(e.target.value);
              }}>
              {workspaces.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
            </select>
          )}
          {live ? (
            <>
              {(model.manualPause || model.ratePause)
                ? <button className="btn primary" onClick={() => void sendControl("resume")}>▶ Resume</button>
                : <button className="btn ghost" onClick={() => void sendControl("pause")}>⏸ Pause</button>}
              <ConfirmButton label="⏹ Stop run" confirm="Sure? Click again" onConfirm={() => void sendControl("stop")} />
            </>
          ) : model.run && tasks.some((t) => t.state !== "DONE") ? (
            <button className="btn primary" onClick={() => void quickRun()}>▶ Run again</button>
          ) : null}
          <button className="btn ghost" onClick={() => setModal({ type: "preview" })}>🌐 View result</button>
          <button className="btn ghost" onClick={() => setModal({ type: "settings" })}>⚙ Settings</button>
          <button className="btn ghost" onClick={() => setModal({ type: "repo" })}>📁 Repo</button>
          <button className="btn ghost" onClick={() => setModal({ type: "supervisor" })}>💬 Supervisor</button>
          <button className={`btn ${model.run ? "ghost" : "primary"}`} onClick={() => setModal({ type: "newwork" })}>＋ New work</button>
        </div>
      </header>

      <Progress tasks={tasks} />
      <UsageStrip model={model} />

      {attention.length > 0 && (
        <Zone title="Needs you" cls="attention">
          {attention.map((t) => <TaskCard key={t.id} t={t} kind="attention" live={live} now={now} onLog={() => openLog(t)} />)}
        </Zone>
      )}
      {working.length > 0 && (
        <Zone title="Working now" cls="working">
          {working.map((t) => <TaskCard key={t.id} t={t} kind="working" live={live} now={now} onLog={() => openLog(t)} />)}
        </Zone>
      )}
      {queued.length > 0 && (
        <section className="zone waiting">
          <h2>Up next ({queued.length})</h2>
          <div className="chip-row">{queued.map((t) => <span key={t.id} className="queue-chip">{t.title}</span>)}</div>
        </section>
      )}
      {done.length > 0 && (
        <section className="zone finished">
          <h2>Merged ({done.length})</h2>
          <div className="done-list">
            {done.map((t) => {
              const meta: string[] = [];
              if (t.turns !== null) meta.push(`${t.turns} steps`);
              if (t.wallS !== null) meta.push(fmtDuration(t.wallS));
              if (t.costUsd > 0) meta.push(fmtUsd(t.costUsd));
              return (
                <div key={t.id} className="done-row">
                  <span className="done-check">✓</span>
                  <span className="done-title">{t.title}</span>
                  <span className="done-meta">{meta.join(" · ")}</span>
                  <button className="btn link" onClick={() => openLog(t)}>details</button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <details className="timeline">
        <summary>Technical timeline</summary>
        <div className="feed-list">
          {[...model.feed].reverse().map((e, i) => (
            <div key={i} className="feed-line">
              <span className="feed-ts">{e.ts?.slice(11, 19) ?? ""}</span>
              <span className="feed-body">{describe(e)}</span>
            </div>
          ))}
        </div>
      </details>

      {modal?.type === "settings" && <SettingsModal onClose={() => setModal(null)} />}
      {modal?.type === "supervisor" && <SupervisorModal ws={ws} onClose={() => setModal(null)} />}
      {modal?.type === "newwork" && <NewWorkModal onClose={() => setModal(null)} onWorkspaceAdded={loadWorkspaces} />}
      {modal?.type === "repo" && <RepoModal onClose={() => setModal(null)} />}
      {modal?.type === "preview" && <PreviewModal onClose={() => setModal(null)} onFiles={() => setModal({ type: "repo" })} />}
      {modal?.type === "log" && (
        <LogModal taskId={modal.taskId} title={modal.title}
          getState={() => model.tasks.get(modal.taskId)?.state}
          onClose={() => setModal(null)} />
      )}
      <Toaster />
    </>
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

function StoryView({ story }: { story: StoryItem[] }): JSX.Element {
  if (!story.length) return <p className="story-say">No activity recorded yet.</p>;
  return (
    <div className="story">
      {story.map((s, i) => {
        if (s.kind === "delegate") return (
          <div key={i} className="story-delegate">
            <div className="delegate-head">🤖 delegated to {s.who}</div>
            {s.mission && <div className="delegate-mission">{s.mission}</div>}
          </div>
        );
        if (s.kind === "act") return <div key={i} className="story-act">▸ {s.text}</div>;
        if (s.kind === "subresult") return <div key={i} className="story-subresult">↳ {s.text}</div>;
        return <p key={i} className={s.kind === "final" ? "story-final" : "story-say"}>{s.text}</p>;
      })}
    </div>
  );
}

function LogModal(
  { taskId, title, getState, onClose }:
  { taskId: string; title: string; getState: () => TaskState | undefined; onClose: () => void },
): JSX.Element {
  const [raw, setRaw] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [following, setFollowing] = useState(inFlight(getState()));
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      const text = await getText(`/api/log?task=${encodeURIComponent(taskId)}`);
      if (!alive) return;
      if (text !== null) setRaw(text);
      if (!inFlight(getState())) setFollowing(false);
    };
    void refresh();
    if (!inFlight(getState())) return;
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
        <div className="panel-head">
          <div className="panel-title-row">
            <h3>{title}</h3>
            {following && <span className="live-tag">● live</span>}
          </div>
          <button className="btn icon" onClick={onClose}>✕</button>
        </div>
        <div className="panel-body log-body" ref={bodyRef}>
          {raw === null ? <p className="story-say">loading…</p>
            : rawMode ? <pre className="log-pre">{raw}</pre>
            : <StoryView story={story} />}
        </div>
        <div className="panel-foot">
          <button className="btn link" onClick={() => setRawMode((v) => !v)}>
            {rawMode ? "Show as story" : "Show raw log"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- Settings modal --------------------------------- */

function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState<string | null>(null);
  const set = (patch: Partial<Settings>) => setS((cur) => cur ? { ...cur, ...patch } : cur);

  useEffect(() => {
    void fetchJSON<{ content: string }>("/api/config").then(({ content }) => setS(parseSettings(content)));
  }, []);

  const save = async (): Promise<void> => {
    if (!s) return;
    await postJSON("/api/config", { content: generateConfig(s) });
  };
  const doTest = async (): Promise<void> => {
    try { await save(); await postJSON("/api/doctor", {}); } catch (err) { toast(String(err), true); return; }
    setTesting(true); setTestOut("Testing for real — one tiny agent tries the web and your commands (~30s)…");
    const id = setInterval(async () => {
      const st = await fetchJSON<{ doctor: { state: string; output: string } }>("/api/status");
      if (st.doctor.state === "running") return;
      clearInterval(id); setTesting(false);
      setTestOut(st.doctor.output.trim() || (st.doctor.state === "error" ? "The check failed — see server logs." : "(no result)"));
    }, 2000);
  };

  if (!s) return <Modal title="Settings" onClose={onClose}>loading…</Modal>;

  const Row = ({ label, hint, children }: { label: string; hint: string; children: ReactNode }) => (
    <div className="setting-row">
      <div className="setting-text"><div className="setting-label">{label}</div><div className="setting-hint">{hint}</div></div>
      {children}
    </div>
  );
  const effortChoices = [...EFFORT_CHOICES];
  if (s.effort && !effortChoices.some(([v]) => v === s.effort)) effortChoices.push([s.effort, `${s.effort} (expensive)`]);

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="settings-form">
        <Row label="Internet access" hint="Agents may search and read the web. Needed for research; adds exposure to web content.">
          <input type="checkbox" className="switch" checked={s.internet} onChange={(e) => set({ internet: e.target.checked })} />
        </Row>
        <Row label="Project type" hint="Grants the matching build tools and preselects the dependency install.">
          <div className="chip-choice">
            {(["node", "python", "other"] as const).map((v) => (
              <button key={v} className={`btn choice${s.project === v ? " on" : ""}`}
                onClick={() => set({ project: v, setupCommands: v === "node" ? "npm install" : v === "python" ? "uv sync" : "" })}>
                {v === "node" ? "Node / JS" : v === "python" ? "Python" : "Other"}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Install dependencies" hint="Run in every agent's fresh copy of the repo, before work starts. Comma-separated.">
          <input className="input" value={s.setupCommands} placeholder="npm install" onChange={(e) => set({ setupCommands: e.target.value })} />
        </Row>
        <Row label="Code reviewer" hint="A second AI double-checks every change before merge: scope, gamed tests, obvious bugs.">
          <input type="checkbox" className="switch" checked={s.reviewer} onChange={(e) => set({ reviewer: e.target.checked })} />
        </Row>
        <Row label="Reasoning effort" hint="How hard each agent thinks. Higher digs deeper but is slower and costs more. Default lets Claude Code decide.">
          <select className="picker" value={s.effort} onChange={(e) => set({ effort: e.target.value })}>
            {effortChoices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Row>
        <Row label="Run budget (USD)" hint="Stop launching new agents once estimated spend crosses this. Empty = no cap. API-equivalent estimate, not a real charge.">
          <input type="number" min="0" step="0.5" className="input num" placeholder="none" value={s.budgetUsd} onChange={(e) => set({ budgetUsd: e.target.value.trim() })} />
        </Row>
        <Row label="Retries per task" hint="How many times a failing ticket is re-attempted. Each retry is a full agent run — keep low for costly tasks.">
          <input type="number" min="0" className="input num" value={s.maxRetries} onChange={(e) => set({ maxRetries: Math.max(0, Number(e.target.value) || 0) })} />
        </Row>
        <Row label="Parallel agents" hint="How many agents work at the same time. 3 is a sane default on a subscription plan.">
          <input type="number" min="1" className="input num" value={s.slots} onChange={(e) => set({ slots: Math.max(1, Number(e.target.value) || 3) })} />
        </Row>
        {testOut !== null && <pre className="doctor-result">{testOut}</pre>}
      </div>
      <div className="panel-foot spread">
        <button className="btn ghost" disabled={testing} onClick={() => void doTest()}>🧪 Test these settings</button>
        <button className="btn primary" onClick={async () => {
          try { await save(); toast("Saved. Your next run uses these settings."); onClose(); }
          catch (err) { toast(String(err), true); }
        }}>Save</button>
      </div>
    </Modal>
  );
}

/* --------------------------------- Supervisor modal --------------------------------- */

const chatHistory = new Map<string, Array<{ who: "you" | "supervisor"; text: string }>>();

function SupervisorModal({ ws, onClose }: { ws: string; onClose: () => void }): JSX.Element {
  const [history, setHistory] = useState(chatHistory.get(ws) ?? []);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const push = (m: { who: "you" | "supervisor"; text: string }) => {
    const next = [...(chatHistory.get(ws) ?? []), m];
    chatHistory.set(ws, next); setHistory(next);
  };
  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || thinking) return;
    setInput(""); push({ who: "you", text }); setThinking(true);
    try {
      await postJSON("/api/chat", { message: text });
      const id = setInterval(async () => {
        const st = await fetchJSON<{ chat: { state: string; output: string } }>("/api/status");
        if (st.chat.state === "running") return;
        clearInterval(id); setThinking(false);
        push({ who: "supervisor", text: st.chat.output.trim() || (st.chat.state === "error" ? "The supervisor failed to answer." : "(no answer)") });
      }, 1500);
    } catch (err) { setThinking(false); push({ who: "supervisor", text: `Error: ${String(err)}` }); }
  };
  return (
    <Modal title={`Supervisor — ${ws}`} onClose={onClose}>
      <div className="chat-messages">
        {history.length === 0 && (
          <p className="hint">Ask anything about the current run — "how is it going?", "why did task 2 fail?" — or give an instruction.</p>
        )}
        {history.map((m, i) => <div key={i} className={`chat-msg ${m.who}`}>{m.text}</div>)}
        {thinking && <div className="chat-msg supervisor thinking">…</div>}
      </div>
      <div className="chat-input-row">
        <textarea className="input chat-input" placeholder="Message the supervisor…" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="btn primary" disabled={thinking} onClick={() => void send()}>Send</button>
      </div>
    </Modal>
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
          <button className="btn primary" onClick={() => window.open(url, "_blank")}>▸ Open the site</button>
          <ConfirmButton label="Stop the preview server" confirm="Sure? Click again"
            onConfirm={async () => { try { await postJSON("/api/preview/stop", {}); toast("Preview server stopped."); } catch (err) { toast(String(err), true); } onClose(); }} />
        </>}
      </div>
      {out && <pre className="log-pre preview-out">{out}</pre>}
    </Modal>
  );
}

/* --------------------------------- Repo modal --------------------------------- */

function RepoModal({ onClose }: { onClose: () => void }): JSX.Element {
  const repo = repoPath();
  const [tab, setTab] = useState<"files" | "history">("files");
  const [files, setFiles] = useState<string[]>([]);
  const [commits, setCommits] = useState<Array<{ hash: string; date: string; author: string; subject: string }>>([]);
  const [branches, setBranches] = useState<{ branches: string[]; current: string }>({ branches: [], current: "" });
  const [mainView, setMainView] = useState<ReactNode>(<p className="hint">Pick a file to preview it, or a commit to see its diff.</p>);

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
    try {
      const { content } = await repoGet<{ content: string }>("file", { path });
      setMainView(
        <>
          <div className="repo-file-bar"><span className="card-title">{path}</span>
            <button className="btn ghost" onClick={() => { window.location.href = `vscode://file/${repo.replace(/\\/g, "/")}/${path}`; }}>Open in IDE</button></div>
          <pre className="file-pre">{content}</pre>
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
            ? files.map((f) => <button key={f} className="tree-file" onClick={() => void openFile(f)}>{f}</button>)
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

function Diff({ text }: { text: string }): JSX.Element {
  return (
    <pre className="diff-pre">
      {text.split("\n").map((line, i) => {
        const cls = line.startsWith("+++") || line.startsWith("---") || line.startsWith("commit ") ? "diff-file"
          : line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "";
        return <div key={i} className={`diff-line ${cls}`}>{line || " "}</div>;
      })}
    </pre>
  );
}

/* --------------------------------- New work modal --------------------------------- */

interface Ticket { file: string; content: string }
function ticketTitle(content: string): string {
  const m = content.match(/^title:\s*(.+)$/m);
  return m ? m[1]!.replace(/^["']|["']$/g, "") : "(untitled)";
}

function NewWorkModal({ onClose, onWorkspaceAdded }: { onClose: () => void; onWorkspaceAdded: () => void }): JSX.Element {
  const [repo, setRepo] = useState(repoPath());
  const [goal, setGoal] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planOut, setPlanOut] = useState("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [slots, setSlots] = useState(3);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [vis, setVis] = useState("private");

  const refreshBacklog = async (): Promise<void> => {
    try { const { tickets: t } = await fetchJSON<{ tickets: Ticket[] }>("/api/backlog"); setTickets(t); } catch { /* */ }
  };
  useEffect(() => { void refreshBacklog(); }, []);

  const repoAction = async (endpoint: string, withVis: boolean): Promise<void> => {
    setRepoPath(repo);
    try {
      const body: Record<string, string> = { path: repo.trim() };
      if (withVis) body.visibility = vis;
      const r = await postJSON<{ output?: string }>(endpoint, body);
      toast(r.output?.slice(-280) || "Done.");
    } catch (err) { toast(String(err), true); }
  };

  const startPlan = async (): Promise<void> => {
    setRepoPath(repo);
    try { await postJSON("/api/plan", { goal, repo }); } catch (err) { toast(String(err), true); return; }
    setPlanning(true); setPlanOut("…");
    const id = setInterval(async () => {
      const st = await fetchJSON<{ plan: { state: string; output: string } }>("/api/status");
      setPlanOut(st.plan.output.slice(-3000) || "…");
      if (st.plan.state === "running") return;
      clearInterval(id); setPlanning(false);
      if (st.plan.state === "done") { toast("Tickets drafted — review them below."); void refreshBacklog(); }
      else toast("Planning failed — see the output.", true);
    }, 1500);
  };

  const startRun = async (): Promise<void> => {
    try { await postJSON("/api/run", { slots: slots || undefined }); } catch (err) { toast(String(err), true); return; }
    toast("Run starting — the board follows automatically."); onClose();
  };

  return (
    <Modal title="New work" onClose={onClose} wide>
      <div className="work-form">
        <label className="work-label">Repository path</label>
        <input className="input" placeholder="C:\\path\\to\\your\\repo" value={repo}
          onChange={(e) => { setRepo(e.target.value); setRepoPath(e.target.value); }} />
        <div className="repo-tools">
          <button className="btn ghost" onClick={() => void repoAction("/api/repo/init", false)}>🆕 Start project here</button>
          <select className="picker" value={vis} onChange={(e) => setVis(e.target.value)}>
            <option value="private">private</option><option value="public">public</option>
          </select>
          <button className="btn ghost" onClick={() => void repoAction("/api/repo/publish", true)}>⬆ Publish to GitHub</button>
          <ConfirmButton label="Set visibility" confirm="Sure? Click again" className="ghost" onConfirm={() => void repoAction("/api/repo/visibility", true)} />
        </div>
        <label className="work-label">What do you want done?</label>
        <textarea className="input work-goal" placeholder="One or two sentences. The planner explores the repo and drafts the tickets."
          value={goal} onChange={(e) => setGoal(e.target.value)} />
        <button className="btn primary" disabled={planning} onClick={() => void startPlan()}>
          {planning ? "Planning… (exploring your repo)" : "✨ Draft tickets with AI"}
        </button>
        {planning && <pre className="log-pre plan-out">{planOut}</pre>}
      </div>

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
            <button className="btn primary" onClick={() => void startRun()}>▶ Start run</button>
          </div>
        </div>
      )}

      <details className="add-ws">
        <summary>Add a workspace</summary>
        <AddWorkspace onAdded={onWorkspaceAdded} />
      </details>
    </Modal>
  );
}

function AddWorkspace({ onAdded }: { onAdded: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  return (
    <div className="work-form">
      <label className="work-label">Name</label>
      <input className="input" placeholder="my-project" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="work-label">Folder (holds factory.yaml, backlog, runs)</label>
      <input className="input" placeholder="C:\\path\\to\\a\\work\\folder" value={dir} onChange={(e) => setDir(e.target.value)} />
      <button className="btn primary" onClick={async () => {
        try { await postJSON("/api/workspaces", { name: name.trim(), workdir: dir.trim() }); setWs(name.trim()); onAdded(); toast(`Workspace "${name.trim()}" added.`); }
        catch (err) { toast(String(err), true); }
      }}>Add</button>
    </div>
  );
}

/* --------------------------------- mount --------------------------------- */

initWs();
createRoot(document.getElementById("app")!).render(<StrictMode><App /></StrictMode>);

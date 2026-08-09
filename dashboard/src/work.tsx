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
import { BoardTicket } from "./board.js";
import { Button, WorkspaceInfo, toast, useManagedInterval } from "./core.js";
import { describe } from "./modals.js";
import { ConfirmButton, Modal, Select, sendControl } from "./widgets.js";

/* --------------------------------- New work modal --------------------------------- */

export interface Ticket { file: string; content: string }
/* ---- ticket front-matter helpers: read/patch one scalar key without touching
   the rest of the file, so the per-ticket pickers below can tune `model:` and
   `effort:` while hand-written YAML stays intact. ---- */

export const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function fmGet(content: string, key: string): string {
  const fm = FM_RE.exec(content)?.[1] ?? "";
  return new RegExp(`^${key}:\\s*["']?([\\w.-]+)["']?\\s*$`, "m").exec(fm)?.[1] ?? "";
}

export function fmSet(content: string, key: string, value: string): string {
  const m = FM_RE.exec(content);
  if (!m) return content;
  const kept = m[1]!.split(/\r?\n/).filter((l) => !l.startsWith(`${key}:`));
  if (value) kept.push(`${key}: ${value}`);
  return content.replace(m[0], `---\n${kept.join("\n")}\n---`);
}

/** Per-ticket model + effort pickers: patch the ticket's front matter in place
 *  and save immediately. These pin THIS ticket only, overriding the run-wide
 *  defaults chosen in Settings. */
export function TicketTune(
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
      <Select className="mini" value={model} onChange={(v) => void save("model", v)} ariaLabel="Ticket model" minWidth={150}
        options={modelChoices.map(([value, label]) => ({ value, label: value ? label.split(" — ")[0] : "Model: default" }))} />
      <Select className="mini" value={effort} onChange={(v) => void save("effort", v)} ariaLabel="Ticket effort" minWidth={140}
        options={effortChoices.map(([value, label]) => ({ value, label: value ? label : "Effort: default" }))} />
      <label className="tune-flag" title="Skip the automated test/verify step for this ticket — for a change small enough that you'll just check it yourself.">
        <input type="checkbox" checked={skipVerify} onChange={(e) => void saveFlag("skip_verify", e.target.checked)} /> Skip tests
      </label>
      <label className="tune-flag" title="Skip the AI code reviewer for this ticket — saves a whole review agent's tokens on a low-risk change like a title tweak.">
        <input type="checkbox" checked={skipReview} onChange={(e) => void saveFlag("skip_review", e.target.checked)} /> Skip review
      </label>
    </div>
  );
}

export function ticketTitle(content: string): string {
  const m = content.match(/^title:\s*(.+)$/m);
  return m ? m[1]!.replace(/^["']|["']$/g, "") : "(untitled)";
}

/** The ticket body — everything after the front matter block. */
export function ticketBody(content: string): string {
  const m = FM_RE.exec(content);
  return (m ? content.slice(m[0].length) : content).replace(/^\r?\n/, "");
}

/** Rewrite a ticket's title (front matter) and body, preserving every other flag
 *  already on it (assignee, status, hold, model, effort, skip_*). */
export function withTitleAndBody(content: string, title: string, body: string): string {
  const q = `"${title.replace(/"/g, "'")}"`;
  const m = FM_RE.exec(content);
  if (!m) return `---\ntitle: ${q}\n---\n${body.trim()}\n`;
  const kept = m[1]!.split(/\r?\n/).filter((l) => !/^title:\s*/.test(l));
  const idIdx = kept.findIndex((l) => /^id:\s*/.test(l));
  kept.splice(idIdx >= 0 ? idIdx + 1 : 0, 0, `title: ${q}`);
  return `---\n${kept.join("\n")}\n---\n${body.trim()}\n`;
}

/** Relative "2m ago" style stamp for a companion observation. */
export function agoShort(iso: string, now: number): string {
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
export function NeedsYou(
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
export function RunChapter(
  { events, defaultOpen, now, currentRun, onPlan }:
  { events: Observation[]; defaultOpen: boolean; now: number; currentRun: string | null; onPlan: (goal: string) => void },
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
                      <button key={i} className="asst-act"
                        onClick={() => s.op === "plan" ? onPlan(s.goal ?? "") : void sendControl(s.op, s.task)}>{s.label}</button>
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

export function CompanionRail(
  { obs, feed, onClose, now, currentRun, live, needsYou, onAnswer, onReview, onPlan }:
  {
    obs: Observation[]; feed: FactoryEvent[]; onClose: () => void; now: number; currentRun: string | null; live: boolean;
    needsYou: TaskModel[]; onAnswer: (t: TaskModel) => void; onReview: (t: TaskModel) => void;
    onPlan: (goal: string) => void;
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
                now={now} currentRun={currentRun} onPlan={onPlan} />
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
export function stepIcon(step: string): LucideIcon {
  if (step.startsWith("reading ")) return BookOpen;
  if (step.startsWith("searching")) return Search;
  if (step.startsWith("finding files")) return Folder;
  return Lightbulb;
}

export interface PlanQuestion { q: string; why: string; suggestions: string[] }

/**
 * Live feedback while the planning agent explores the repo. Instead of a raw log
 * dump, it shows an elapsed timer, a running tally (files read, searches) and a
 * scrolling feed of the agent's moves — so a wait that can run several minutes
 * feels alive and legible. Lines come from `factory plan` stdout, each prefixed
 * "· " by the CLI. `mode` colours the phrasing: exploring-to-draft vs
 * exploring-to-ask (plan mode's clarify-first pass).
 */
export function PlanProgress({ output, startMs, mode }: { output: string; startMs: number; mode: "tickets" | "questions" }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const steps = output
    .split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("· ")).map((l) => l.slice(2));
  const reads = steps.filter((s) => s.startsWith("reading ")).length;
  const searches = steps.filter((s) => s.startsWith("searching") || s.startsWith("finding files")).length;
  // Show a long tail (not just the last few) as a scrolling timeline, so the user
  // sees the depth of the exploration, not a flickering 5-line window.
  const recent = steps.slice(-40);
  const feedRef = useRef<HTMLUListElement>(null);
  useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [steps.length]);
  const secs = startMs ? Math.max(0, Math.floor((now - startMs) / 1000)) : 0;
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const phase = steps.length === 0
    ? "Waking the planning agent"
    : mode === "questions" ? "Working out what to ask you" : "Exploring your repo to draft tickets";
  return (
    <div className="plan-progress">
      <div className="plan-progress-head">
        <span className="plan-spinner" />
        <span className="plan-phase">{phase}…</span>
        <span className="plan-timer" title="elapsed">{mmss}</span>
      </div>
      {steps.length > 0 ? (
        <>
          <ul className="plan-steps" ref={feedRef}>
            {recent.map((s, i) => {
              const StepIcon = stepIcon(s);
              return (
                <li key={`${i}-${s}`} className={i === recent.length - 1 ? "on" : ""}>
                  <span className="plan-step-ic"><StepIcon size={13} /></span>{s}
                </li>
              );
            })}
          </ul>
          <div className="plan-counts">
            <span><b>{reads}</b> file{reads === 1 ? "" : "s"} read</span>
            <span><b>{searches}</b> search{searches === 1 ? "" : "es"}</span>
            <span className="plan-counts-hint">
              {mode === "questions" ? "then it'll ask you a few questions" : "usually 1–3 min; longer on a big repo"}
            </span>
          </div>
        </>
      ) : (
        <div className="plan-hint-line">
          {mode === "questions"
            ? "Reading your code so its questions land where they matter — a moment…"
            : "Reading your code to draft parallel-safe tickets — usually 1–3 minutes."}
        </div>
      )}
    </div>
  );
}

/** GitHub/repo actions for a project: initialise a repo, publish it, flip its
 *  visibility. Shared by the New-project flow and Settings › Repository — the two
 *  places a project's repo is set up (it is a project property, not a ticket's). */
export function RepoTools({ repo }: { repo: string }): JSX.Element {
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
      <Select value={vis} onChange={setVis} ariaLabel="Repository visibility" minWidth={130}
        options={[{ value: "private", label: "private" }, { value: "public", label: "public" }]} />
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
export function NewWorkModal(
  { onClose, onWorkspaceAdded, onBacklogChange, takenIds = [], initialTab = "one", initialGoal, variant = "work" }:
  { onClose: () => void; onWorkspaceAdded: () => void; onBacklogChange?: () => void;
    takenIds?: string[]; initialTab?: "one" | "goal"; initialGoal?: string; variant?: "work" | "project" },
): JSX.Element {
  const isProject = variant === "project";
  const [tab, setTab] = useState<"one" | "goal">(initialGoal ? "goal" : initialTab);
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
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [planning, setPlanning] = useState(false);
  const [planOut, setPlanOut] = useState("");
  const [planStart, setPlanStart] = useState(0);
  // Plan mode: ask clarifying questions before drafting, for more control.
  const [askMode, setAskMode] = useState(false);
  const [planMode, setPlanMode] = useState<"tickets" | "questions">("tickets");
  const [questions, setQuestions] = useState<PlanQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
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

  // Follow a planning pass (ask or draft) already running server-side. Split from
  // the kickoff so it can also RE-ATTACH to a plan that is still running when the
  // modal is reopened — the job lives on the server, not this tab.
  const followPlan = (isAsk: boolean): void => {
    setPlanning(true); setPlanMode(isAsk ? "questions" : "tickets");
    if (!isAsk) setQuestions(null);
    pollPlan((stop) => {
      void (async () => {
        const st = await fetchJSON<{ plan: { state: string; output: string; questions?: PlanQuestion[] } }>("/api/status");
        setPlanOut(st.plan.output.slice(-6000));
        if (st.plan.state === "running") return;
        stop(); setPlanning(false);
        if (st.plan.state === "done") {
          if (isAsk) {
            if (st.plan.questions?.length) { setQuestions(st.plan.questions); setAnswers({}); }
            else toast("No questions came back — you can draft directly.", true);
          } else {
            setQuestions(null);
            toast("Tickets drafted — review them below.");
            void refreshBacklog();
          }
        } else {
          toast(isAsk ? "Couldn't get questions — see the output." : "Planning failed — see the output.", true);
        }
      })();
    }, 1500);
  };

  // If a plan is already running when this modal opens (e.g. it was closed and
  // reopened, or opened on another device), re-attach to its live feed.
  useEffect(() => {
    void (async () => {
      try {
        const st = await fetchJSON<{ plan: { state: string; mode?: "tickets" | "questions" } }>("/api/status");
        if (st.plan.state === "running") { setPlanStart(Date.now()); followPlan(st.plan.mode === "questions"); }
      } catch { /* no live plan — nothing to attach to */ }
    })();
  }, []);

  // Kick off a planning pass: `ask` runs the clarify-first pass; `clarifications`
  // (the operator's answers) are folded into the draft pass. `repoOverride` lets a
  // caller pin the repo explicitly, so an immediate draft can't race the async
  // repo-seed and plan against a stale (previously-open) workspace's repo.
  const kickPlan = async (ask: boolean, clarifications?: string, repoOverride?: string): Promise<void> => {
    if (!goal.trim()) { toast("Say what you want done first.", true); return; }
    if (!(await ensureIsolatedWs())) return;
    const useRepo = (repoOverride ?? repo).trim();
    setRepoPath(useRepo);
    try { await postJSON("/api/plan", { goal, repo: useRepo, ask, clarifications }); }
    catch (err) { toast(String(err), true); return; }
    setPlanOut(""); setPlanStart(Date.now());
    followPlan(ask);
  };

  // "From a goal": either draft straight away, or (plan mode) ask questions first.
  const startPlan = (): Promise<void> => kickPlan(askMode);

  // Opened from the supervisor with a ready goal: draft immediately (the operator
  // already agreed to it in chat), landing straight on the drafted-tickets review.
  // Resolve THIS workspace's repo first — repoPath() (localStorage) may still point
  // at a previously-open workspace, and the goal came from the active one's
  // supervisor — then pin it so the draft can't plan against the wrong repo.
  useEffect(() => {
    if (!initialGoal || !initialGoal.trim() || isProject) return;
    void (async () => {
      let useRepo = repoPath();
      try {
        const { workspaces } = await fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
        const active = workspaces.find((w) => w.name === getWs()) ?? workspaces[0];
        if (active?.repo) { useRepo = active.repo; setRepo(active.repo); setRepoPath(active.repo); }
      } catch { /* fall back to repoPath() */ }
      await kickPlan(false, undefined, useRepo);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Plan mode, phase two: the operator answered — draft with their answers folded in.
  const draftWithAnswers = (): Promise<void> => {
    const clar = (questions ?? [])
      .map((q, i) => { const a = (answers[i] ?? "").trim(); return a ? `- ${q.q}\n  -> ${a}` : null; })
      .filter(Boolean).join("\n");
    if (!clar) { toast("Answer at least one question, or skip to draft directly.", true); return Promise.resolve(); }
    return kickPlan(false, clar);
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
          <label className={`plan-mode-toggle${askMode ? " on" : ""}`} title="The planner explores your repo, then asks a few high-leverage questions so the plan matches what you actually want.">
            <input type="checkbox" className="switch" checked={askMode} disabled={planning || !!questions}
              onChange={(e) => setAskMode(e.target.checked)} />
            <CircleHelp size={14} />
            <span>Ask me questions first <span className="plan-mode-hint">— more control over what gets built</span></span>
          </label>
          {!questions && (
            <div className="work-draft-row">
              <button className="btn primary" disabled={planning} onClick={() => void startPlan()}>
                {planning
                  ? (planMode === "questions" ? "Thinking of questions…" : "Planning… (exploring your repo)")
                  : askMode
                    ? <><CircleHelp size={14} /> Plan with questions</>
                    : <><Sparkles size={14} /> Draft tickets with AI</>}
              </button>
            </div>
          )}
          {planning && <PlanProgress output={planOut} startMs={planStart} mode={planMode} />}
          {questions && !planning && (
            <div className="plan-questions-form">
              <div className="pqf-head"><CircleHelp size={15} /> A few questions to aim the plan</div>
              <p className="pqf-sub">Pick a suggestion or write your own. Blank answers use the planner's default.</p>
              {questions.map((q, i) => (
                <div key={i} className="pqf-item">
                  <div className="pqf-q"><span className="pqf-n">{i + 1}</span>{q.q}</div>
                  {q.why && <div className="pqf-why">{q.why}</div>}
                  {q.suggestions.length > 0 && (
                    <div className="pqf-chips">
                      {q.suggestions.map((s, j) => (
                        <button key={j} type="button"
                          className={`pqf-chip${(answers[i] ?? "") === s ? " on" : ""}`}
                          onClick={() => setAnswers((a) => ({ ...a, [i]: s }))}>{s}</button>
                      ))}
                    </div>
                  )}
                  <input className="input pqf-answer" placeholder="Your answer (or pick one above)…"
                    value={answers[i] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))} />
                </div>
              ))}
              <div className="pqf-actions">
                <button className="btn ghost" onClick={() => void kickPlan(false)}>Skip — just draft</button>
                <div className="spacer" />
                <Button kind="btn" variant="primary" autoPending onClick={draftWithAnswers}>
                  <Sparkles size={14} /> Draft tickets
                </Button>
              </div>
            </div>
          )}
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
export function EditTicketModal(
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


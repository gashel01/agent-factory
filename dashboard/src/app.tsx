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
  ArrowLeft, BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Circle,
  CircleDot, CircleHelp, Command, CompanionIcon, CornerDownLeft, CornerDownRight,
  ExternalLink, Eye, FileText, FlaskConical, Flag, Folder, FolderOpen, FolderPlus,
  GitBranch, GitMerge, GitPullRequest, Globe, InfinityIcon, Key, Laptop, Lightbulb, ListChecks, Lock, MessageCircle,
  MessageSquare, MoreHorizontal, Palette, Pause, Pencil, Play, Plus, RotateCw, Search, Send,
  ShieldCheck, Smartphone, Sparkles, Square, Terminal, Timer, Trash2, TriangleAlert, Undo2, Upload, X,
} from "./icons.js";
import type { LucideIcon } from "./icons.js";
import { AiReviewModal, AnalyticsModal, BoardTicket, DepGraphModal, HotspotsPanel, IntegrationBanner, Kanban, ModalState, RERUNNABLE, RemovedModal, Screen, SyncNote, headline, isAutopilotRun, parseTicketDeps } from "./board.js";
import { AutopilotModal, CockpitModal, PreviewModal, PullRequestsModal, RepoModal } from "./cockpit.js";
import { Button, TONE_FAM, Toaster, WorkspaceInfo, sendNotification, toast, useCompanion, useEventStream, useNotifyPref, useNow, useRunActive, useStateAlerts } from "./core.js";
import { DiagnosticsModal, DocsModal, LogModal, Row, RunEstimateModal, SettingsModal, describe } from "./modals.js";
import { CoordinationModal } from "./coordination-view.js";
import { ArchitectureModal } from "./architecture-view.js";
import { AgentVersionChip, AnswerModal, Appearance, AppearanceModal, DiffModal, FactEditor, MemoryScreen, ProjectsScreen, ReviewModal, SupervisorDock, useTheme } from "./screens.js";
import { CommandPalette, ConfirmButton, OverflowMenu, ProjectSwitcher, Select, UsageCard, sendControl, useBacklog, useHidden } from "./widgets.js";
// The command-palette item type. Aliased because the bare name `Command` is also a
// Lucide icon value imported above; in the pre-split monolith the value-import and
// the interface merged in one file — apart, the type must be pulled in explicitly.
import type { Command as CmdItem } from "./widgets.js";
import { CompanionRail, EditTicketModal, NewWorkModal, Ticket, fmGet, fmSet, ticketTitle } from "./work.js";

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
  const [railWidth, setRailWidthState] = useState(() => {
    try {
      const saved = localStorage.getItem("factory.railWidth");
      return saved ? Math.max(280, Math.min(600, Number(saved))) : 340;
    } catch { return 340; }
  });
  const setRailWidth = (w: number): void => {
    const clamped = Math.max(280, Math.min(600, w));
    setRailWidthState(clamped);
    try { localStorage.setItem("factory.railWidth", String(clamped)); } catch { /* */ }
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
      sendNotification("Warden", latest.text);
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

  const head = headline(model, runActive, hidden.ids);
  const live = Boolean(model.run) && !model.endedTs && runActive;
  // Autopilot UI (banner, Deps) keys on the loop job actually running, not the
  // per-iteration `live` flag which blips off at each iteration boundary — and
  // must go quiet once the loop is stopped, even though model.run still names
  // the last (dead) loop iteration.
  const autopilot = isAutopilotRun(model.run) && runActive;
  const allTasks = [...model.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  // A killed run (e.g. a stopped autopilot loop) leaves tickets stuck in an
  // in-flight state with no terminal event. When nothing is actually running
  // they're ghosts — hide them so the board shows no phantom "working" cards.
  const tasks = runActive ? allTasks : allTasks.filter((t) => !inFlight(t.state));
  // Stats + banner count only what's still on the board: a removed ticket must not
  // keep the "Needs you" tally (or the banner tone) lit. `tasks` stays unfiltered
  // for the Removed list, which needs exactly the hidden ones.
  const visibleTasks = tasks.filter((t) => !hidden.ids.has(t.id));
  const done = visibleTasks.filter((t) => t.state === "DONE");
  const attention = visibleTasks.filter((t) => t.state === "BLOCKED" || t.state === "FAILED");
  const working = visibleTasks.filter((t) => inFlight(t.state));
  const queued = visibleTasks.filter((t) => t.state === "QUEUED");
  const openLog = (t: TaskModel) => setModal({ type: "log", taskId: t.id, title: t.title });
  const openAnswer = (t: TaskModel) =>
    setModal({ type: "answer", taskId: t.id, title: t.title, question: t.note ?? "",
               context: t.blockedContext });
  const openDiagnose = (t: TaskModel) => setModal({ type: "diagnostics", taskId: t.id, title: t.title });
  // Re-scope a stuck ticket before retrying: its backlog file still exists, so open
  // the full editor on it. Saving rewrites the file; the next "Run again" uses it.
  const openEditTask = (t: TaskModel) => {
    const bt = boardTickets.find((x) => x.id === t.id);
    if (bt) setModal({ type: "editticket", ticket: bt });
    else toast("This ticket's file is gone (merged or removed) — nothing to edit.", true);
  };
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
  const commands = useMemo<CmdItem[]>(() => {
    const nav: CmdItem[] = [
      { id: "newwork", group: "Actions", label: "New work", hint: "n", run: () => setModal({ type: "newwork" }) },
      { id: "settings", group: "Open", label: "Settings", run: () => setModal({ type: "settings" }) },
      { id: "docs", group: "Open", label: "Knowledge base", run: () => setModal({ type: "docs" }) },
      { id: "repo", group: "Open", label: "Repo explorer", run: () => setModal({ type: "repo" }) },
      { id: "deps", group: "Open", label: "Dependency graph", run: () => setModal({ type: "depgraph" }) },
      { id: "coord", group: "Open", label: "Shared space (agent coordination)", run: () => setModal({ type: "coordination" }) },
      { id: "arch", group: "Open", label: "Architecture (world-model + notes)", run: () => setModal({ type: "architecture" }) },
      { id: "analytics", group: "Open", label: "Cost analytics", run: () => setModal({ type: "analytics" }) },
      { id: "supervisor", group: "Open", label: "Supervisor", run: () => setRailOpen(true) },
      { id: "preview", group: "Open", label: "View result (preview)", run: () => setModal({ type: "preview" }) },
      { id: "cockpit", group: "Open", label: "Project cockpit (run / build / install)", run: () => setModal({ type: "cockpit" }) },
      { id: "appearance", group: "Open", label: "Appearance", run: () => setModal({ type: "appearance" }) },
    ];
    if (runnableCount > 0) {
      nav.splice(1, 0, { id: "runagain", group: "Actions", label: `Run again (${runnableCount} ticket${runnableCount > 1 ? "s" : ""})`, hint: "estimate first", run: () => setModal({ type: "runestimate", tickets: runnableCount }) });
    }
    const toggles: CmdItem[] = [
      { id: "view", group: "Toggle", label: view === "focus" ? "Switch to Kanban view" : "Switch to Focus view", hint: "f", run: () => setView(view === "focus" ? "kanban" : "focus") },
      { id: "theme", group: "Toggle", label: theme.dark ? "Light theme" : "Dark theme", run: theme.toggle },
      { id: "notify", group: "Toggle", label: notify.on ? "Mute notifications" : "Enable notifications", run: notify.toggle },
    ];
    const screens: CmdItem[] = [
      { id: "projects", group: "Go to", label: "All projects", run: () => setScreen("projects") },
      { id: "memory", group: "Go to", label: "Memory", run: () => setScreen("memory") },
    ];
    const wsCmds: CmdItem[] = workspaces
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

  // App-level actions the Projects/Memory header "•••" menu invokes (they live here,
  // above those screens) — same source as the board header's menu.
  const headerMenu = { onCmdk: () => setModal({ type: "cmdk" }), notifyOn: notify.on, onToggleNotify: notify.toggle };
  if (screen === "projects") {
    return (
      <>
        <ProjectsScreen theme={theme} onOpen={openProject} onMemory={() => setScreen("memory")} menu={headerMenu} />
        <Toaster />
      </>
    );
  }
  if (screen === "memory") {
    return (
      <>
        <MemoryScreen ws={ws} tasks={tasks} theme={theme} onProjects={() => setScreen("projects")} menu={headerMenu} />
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
              <span className="brand-name">Warden</span>
              <span className="brand-sub">Local execution</span>
            </div>
          </div>
          {workspaces.length > 0 && (
            <ProjectSwitcher
              workspace={ws}
              workspaces={workspaces}
              onOpenProjects={() => setScreen("projects")}
              onSwitchProject={(name) => { setWs(name); setWsState(name); }}
            />
          )}
          <div className="spacer" />
          <AgentVersionChip />
          <button className={`mode-badge mode-${model.mode}`} onClick={() => setModal({ type: "settings", section: "set-safety" })}
            title={model.mode === "api" ? "API mode — real dollars billed. Click to change." : "Subscription mode — draws from your plan, no real charge. Click to change."}>
            {model.mode === "api" ? <><Key size={13} /> API</> : <><InfinityIcon size={14} /> Subscription</>}
          </button>
          {model.prMode !== null && (
            <button className={`mode-badge delivery-${model.prMode ? "pr" : "integrated"}`} onClick={() => setModal({ type: "settings", section: "set-safety" })}
              title={model.prMode
                ? "Delivery: one GitHub PR per verified ticket. Nothing lands on your base branch until YOU merge those PRs — merged tickets on the board just mean the PR is open. Click to change."
                : "Delivery: verified tickets merge straight into the base branch (one integrated result). Click to change."}>
              {model.prMode ? <><GitPullRequest size={13} /> PRs per ticket</> : <><GitMerge size={13} /> Integrated</>}
            </button>
          )}
          <OverflowMenu ariaLabel="More actions" items={[
            { label: "Command palette", hint: "⌘K", onClick: () => setModal({ type: "cmdk" }) },
            { label: "Notifications", hint: notify.on ? "On" : "Off", on: notify.on, onClick: notify.toggle },
            { label: "Appearance", onClick: () => setModal({ type: "appearance" }) },
            { label: "Settings", onClick: () => setModal({ type: "settings" }) },
            { label: "Memory", onClick: () => setScreen("memory") },
            { label: "Supervisor", onClick: () => setRailOpen(true) },
          ]} />
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
            {/* Shipped-ticket chips removed from the header: the merged tickets
                already live in the Kanban's "Merged" column, so they added no info. */}
          </div>

          {/* Run controls sit right after the status — the natural next action —
              instead of floating alone at the far right. */}
          {(live || willRun > 0) && (
            <div className="transport">
              <div className="transport-row">
                {live ? (
                  <>
                    {(model.manualPause || model.ratePause)
                      ? <Button kind="hbtn" autoPending onClick={() => sendControl("resume")}><Play size={14} /> Resume</Button>
                      : <Button kind="hbtn" autoPending onClick={() => sendControl("pause")}><Pause size={14} /> Pause</Button>}
                    <ConfirmButton label={<><Square size={13} /> Stop all</>} confirm="Sure? Click again" plain className="hbtn" onConfirm={() => void sendControl("stop")} />
                  </>
                ) : (
                  <button className="hbtn accent" onClick={() => setModal({ type: "runestimate", tickets: willRun })}>
                    {/* "Run again" only when re-executing tickets from the finished
                        run (runnable > 0). Fresh backlog work — even after a prior
                        run — is a plain "Run", not a re-run. */}
                    <Play size={14} /> {runnable > 0 ? "Run again" : "Run"} ({willRun})
                  </button>
                )}
              </div>
            </div>
          )}

          <UsageCard mode={model.mode} tokens={tokens} spent={spent} budgetUsd={model.budgetUsd}
            budgetPct={budgetPct} budgetColor={budgetColor} onAnalytics={() => setModal({ type: "analytics" })} />
        </div>
      </header>

      <SyncNote sync={model.sync} />
      <IntegrationBanner integ={model.integration} />
      {autopilot && (
        <div className="autopilot-banner">
          <span className="ap-badge"><InfinityIcon size={13} /> Autopilot</span>
          <span className="ap-text">These tickets are driven by the autopilot loop — it plans, runs and merges them on an integration branch.</span>
          <button className="btn ghost" onClick={() => setModal({ type: "autopilot" })}>Open autopilot</button>
        </div>
      )}

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
          <button className="board-tool" title="Run, build, verify and install this project — whatever its stack" onClick={() => setModal({ type: "cockpit" })}><Play size={13} /> Cockpit</button>
          <button className="board-tool" title="Browse files, branches and history" onClick={() => setModal({ type: "repo" })}><GitBranch size={13} /> Repo</button>
          <button className="board-tool" title="Open pull requests — merge or close them here" onClick={() => setModal({ type: "prs" })}><GitMerge size={13} /> PRs</button>
          <button className="board-tool" title="Autopilot — run toward an objective under a budget cap" onClick={() => setModal({ type: "autopilot" })}><InfinityIcon size={13} /> Autopilot</button>
          {(hasDeps || autopilot) && (
            <button className="board-tool" title="Ticket dependency graph" onClick={() => setModal({ type: "depgraph" })}><GitMerge size={13} /> Deps</button>
          )}
          <button className="board-tool" title="The shared space where agents coordinate — who's editing what, symbols they've published, decisions they share" onClick={() => setModal({ type: "coordination" })}><MessageSquare size={13} /> Shared space</button>
          <button className="board-tool" title="The living architecture — the world-model your agents maintain (symbols, decisions, file ownership) plus your own notes" onClick={() => setModal({ type: "architecture" })}><ListChecks size={13} /> Architecture</button>
          <button className="board-tool" title="This project's docs your agents can read" onClick={() => setModal({ type: "docs" })}><BookOpen size={13} /> Knowledge</button>
          {removed.length > 0 && (
            <button className="board-tool" title="Tickets you removed from the board — restore them here" onClick={() => setModal({ type: "removed" })}><Trash2 size={13} /> Removed ({removed.length})</button>
          )}
          {(tasks.length > 0 || pending.length > 0 || manual.length > 0) && (
            <div className="nav-pills">
              <button className={`nav-pill${view === "kanban" ? " on" : ""}`} onClick={() => setView("kanban")}>Kanban</button>
              <button className={`nav-pill${view === "focus" ? " on" : ""}`} onClick={() => setView("focus")}>Focus</button>
            </div>
          )}
        </div>
      </div>
      <HotspotsPanel
        ws={ws}
        tasks={allTasks}
        live={live}
        onOpenFile={(path) => setModal({ type: "repo", file: path })}
        onSplit={(path) => setModal({
          type: "newwork", tab: "goal", autostart: false,
          goal: `Split ${path} into smaller, cohesive modules. Pure mechanical refactor: `
            + `move code into new files and wire imports/exports — change no logic or behavior. `
            + `Keep the typecheck and the build green.`,
        })} />
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
          onAnswer={openAnswer} onLesson={openLesson} onDiff={openDiff} onDiagnose={openDiagnose}
          onEditTask={openEditTask}
          focus={view === "focus"} autopilot={autopilot}
          pending={pending} manual={manual} onAddTicket={() => setModal({ type: "newwork", tab: "one" })}
          onEditTicket={(bt) => setModal({ type: "editticket", ticket: bt })}
          onRemoveTicket={removeTicket} onRemoveTask={removeTask}
          onMoveManual={moveManual} onSetAssignee={setAssignee} onSetHold={setHold}
          onReviewManual={(bt) => setModal({ type: "aireview", file: bt.file, title: bt.title })} />
      )}

      {modal?.type === "settings" && <SettingsModal onClose={() => setModal(null)} initialSection={modal.section} />}
      {modal?.type === "newwork" && <NewWorkModal onClose={() => setModal(null)} onWorkspaceAdded={loadWorkspaces} onBacklogChange={backlog.refresh} takenIds={tasks.map((t) => t.id)} initialTab={modal.tab ?? "one"} initialGoal={modal.goal} initialAutoStart={modal.autostart ?? true} />}
      {modal?.type === "editticket" && (
        <EditTicketModal ticket={modal.ticket} onClose={() => setModal(null)}
          onSave={(content) => patchTicket(modal.ticket, content, `Ticket ${modal.ticket.id} updated.`)} />
      )}
      {modal?.type === "repo" && <RepoModal onClose={() => setModal(null)} initialFile={modal.file} />}
      {modal?.type === "prs" && <PullRequestsModal ws={ws} onClose={() => setModal(null)} />}
      {modal?.type === "autopilot" && <AutopilotModal ws={ws} onClose={() => setModal(null)} />}
      {modal?.type === "preview" && <PreviewModal onClose={() => setModal(null)} onFiles={() => setModal({ type: "repo" })} />}
      {modal?.type === "cockpit" && <CockpitModal onClose={() => setModal(null)} />}
      {modal?.type === "removed" && (
        <RemovedModal removed={removed} onRestore={restoreTicket} onClose={() => setModal(null)} />
      )}
      {modal?.type === "appearance" && (
        <AppearanceModal theme={theme} onClose={() => setModal(null)} />
      )}
      {modal?.type === "runestimate" && (
        <RunEstimateModal tickets={modal.tickets} budgetUsd={model.budgetUsd}
          avgCost={done.length > 0 && spent > 0 ? spent / done.length : null}
          onClose={() => setModal(null)}
          onSettings={() => setModal({ type: "settings" })} />
      )}
      {modal?.type === "diagnostics" && (
        <DiagnosticsModal taskId={modal.taskId} title={modal.title} run={model.run}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "diff" && (
        <DiffModal taskId={modal.taskId} title={modal.title} diff={modal.diff}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "review" && model.tasks.get(modal.taskId)?.diff && (
        <ReviewModal task={model.tasks.get(modal.taskId)!} onClose={() => setModal(null)} />
      )}
      {modal?.type === "analytics" && <AnalyticsModal onClose={() => setModal(null)} />}
      {modal?.type === "docs" && <DocsModal onClose={() => setModal(null)} />}
      {modal?.type === "aireview" && <AiReviewModal file={modal.file} title={modal.title} onClose={() => setModal(null)}
        onSendToAi={(review) => handToAiWithFeedback(modal.file, review)} />}
      {modal?.type === "cmdk" && <CommandPalette commands={commands} onClose={() => setModal(null)} />}
      {modal?.type === "depgraph" && (
        <DepGraphModal
          stateOf={(id) => model.tasks.get(id)?.state}
          liveNodes={live ? allTasks.map((t) => ({ id: t.id, title: t.title, deps: t.deps })) : null}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "coordination" && <CoordinationModal onClose={() => setModal(null)} />}
      {modal?.type === "architecture" && <ArchitectureModal onClose={() => setModal(null)} />}
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
            currentRun={model.run} live={live} railWidth={railWidth} onRailWidth={setRailWidth}
            needsYou={visibleTasks.filter((t) => t.state === "BLOCKED" || t.state === "FAILED" || t.state === "AWAITING_APPROVAL")}
            onAnswer={openAnswer} onReview={openDiff}
            onPlan={(goal) => { setRailOpen(false); setModal({ type: "newwork", tab: "goal", goal }); }} />
        : <SupervisorDock onExpand={() => setRailOpen(true)} />}
    </div>
  );
}

/* --------------------------------- mount --------------------------------- */

initToken();
initWs();
createRoot(document.getElementById("app")!).render(<StrictMode><App /></StrictMode>);


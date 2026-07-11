/**
 * Dashboard client — designed around the operator's questions, in order:
 *   1. "Is everything okay?"        → headline + progress bar, one glance
 *   2. "Does anything need ME?"     → attention section pinned on top, action beside problem
 *   3. "What's happening right now?"→ working cards in plain language, live timers
 *   4. "What already happened?"     → compact done/failed lists, technical timeline folded
 *
 * State-machine names never reach the screen; humans read activities.
 */

import type {
  AgentResultEvent,
  BlockedEvent,
  FactoryEvent,
  FailureEvent,
  PausedEvent,
  RetryEvent,
  RunEndEvent,
  RunStartEvent,
  StateEvent,
  TaskState,
  VerifyEvent,
} from "./types.js";

/* ---------------------------------- model ---------------------------------- */

interface TaskModel {
  id: string;
  title: string;
  state: TaskState;
  turns: number | null;
  wallS: number | null;
  note: string;
  retries: number;
  runningSince: number | null; // epoch ms, for live timers
  finishedAt: string | null;
}

interface Model {
  run: string;
  slots: number | null;
  startedTs: string | null;
  endedTs: string | null;
  stopped: boolean;
  ratePause: PausedEvent | null;
  manualPause: boolean;
  tasks: Map<string, TaskModel>;
  feed: FactoryEvent[];
}

const FEED_LIMIT = 200;

function freshModel(run: string): Model {
  return {
    run,
    slots: null,
    startedTs: null,
    endedTs: null,
    stopped: false,
    ratePause: null,
    manualPause: false,
    tasks: new Map(),
    feed: [],
  };
}

let model = freshModel("");

function task(id: string): TaskModel {
  let entry = model.tasks.get(id);
  if (!entry) {
    entry = {
      id,
      title: id,
      state: "QUEUED",
      turns: null,
      wallS: null,
      note: "",
      retries: 0,
      runningSince: null,
      finishedAt: null,
    };
    model.tasks.set(id, entry);
  }
  return entry;
}

function reduce(event: FactoryEvent): void {
  model.feed.push(event);
  if (model.feed.length > FEED_LIMIT) model.feed.shift();

  switch (event.event) {
    case "run_start": {
      const e = event as RunStartEvent;
      model.slots = e.slots;
      model.startedTs = e.ts;
      for (const t of e.tasks) {
        const id = typeof t === "string" ? t : t.id;
        const entry = task(id);
        if (typeof t !== "string") entry.title = t.title;
      }
      break;
    }
    case "state": {
      const e = event as StateEvent;
      const entry = task(e.task);
      entry.state = e.to;
      if (e.to === "RUNNING") {
        entry.runningSince = Date.parse(e.ts);
        entry.note = "";
        model.ratePause = null;
      }
      if (e.to === "DONE" || e.to === "FAILED" || e.to === "BLOCKED") {
        entry.runningSince = null;
        entry.finishedAt = e.ts;
      }
      if (e.to === "QUEUED") entry.runningSince = null;
      break;
    }
    case "agent_result": {
      const e = event as AgentResultEvent;
      const entry = task(e.task);
      entry.turns = e.turns;
      entry.wallS = e.wall_s;
      if (e.summary) entry.note = e.summary;
      break;
    }
    case "verify": {
      const e = event as VerifyEvent;
      if (!e.ok) task(e.task).note = e.failures.join("; ");
      break;
    }
    case "retry": {
      const e = event as RetryEvent;
      const entry = task(e.task);
      entry.retries = e.attempt;
      entry.note = e.reason;
      break;
    }
    case "failure":
      task((event as FailureEvent).task).note = (event as FailureEvent).reason;
      break;
    case "blocked":
      task((event as BlockedEvent).task).note = (event as BlockedEvent).question;
      break;
    case "paused_ratelimit":
      model.ratePause = event as PausedEvent;
      break;
    case "paused_manual":
      model.manualPause = true;
      break;
    case "resumed":
      model.manualPause = false;
      model.ratePause = null;
      break;
    case "run_end": {
      const e = event as RunEndEvent;
      model.endedTs = e.ts;
      model.stopped = e.stopped;
      model.ratePause = null;
      model.manualPause = false;
      break;
    }
  }
}

/* ------------------------------ human language ------------------------------ */

const ACTIVITY: Record<TaskState, string> = {
  QUEUED: "Waiting for a free slot",
  RUNNING: "Agent is working",
  VERIFYING: "Checking the work (tests)",
  REVIEWING: "Second agent reviewing the diff",
  MERGE_QUEUED: "Work approved — waiting to merge",
  MERGING: "Merging into your branch",
  DONE: "Merged",
  FAILED: "Failed",
  BLOCKED: "The agent has a question",
};

const STATE_ICON: Record<TaskState, string> = {
  QUEUED: "◷",
  RUNNING: "●",
  VERIFYING: "🔎",
  REVIEWING: "⚖",
  MERGE_QUEUED: "✓",
  MERGING: "⇄",
  DONE: "✓",
  FAILED: "✕",
  BLOCKED: "✋",
};

function fmtDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 90) return `${m}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ago(ts: string): string {
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

/* --------------------------------- controls --------------------------------- */

async function sendControl(op: string, taskId?: string): Promise<void> {
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, task: taskId }),
    });
    if (!res.ok) throw new Error(await res.text());
    const messages: Record<string, string> = {
      pause: "Pausing — running agents finish, no new ones start.",
      resume: "Resuming.",
      stop: "Stopping — running agents finish, the rest stays queued.",
      kill: `Stopping the agent on ${taskId}…`,
      retry: `${taskId} is back in the queue with a fresh budget.`,
    };
    toast(messages[op] ?? "Sent.");
  } catch (err) {
    toast(`Could not send the command: ${String(err)}`, true);
  }
}

async function quickRun(): Promise<void> {
  try {
    await fetchJSON("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    toast("New run starting — remaining tickets replay with the current config.");
  } catch (err) {
    toast(String(err), true);
    return;
  }
  // Surface an early crash (e.g. preflight refusing a dirty repo).
  let checks = 0;
  const timer = setInterval(async () => {
    const status = await fetchJSON<{ run: { state: string; output: string } }>("/api/status");
    if (status.run.state === "error") {
      clearInterval(timer);
      toast(status.run.output.slice(-280) || "The run failed to start.", true);
    } else if (status.run.state !== "running" || ++checks > 20) {
      clearInterval(timer);
    }
  }, 2000);
}

function toast(message: string, isError = false): void {
  const host = document.getElementById("toasts")!;
  const node = el("div", `toast${isError ? " error" : ""}`, message);
  host.append(node);
  setTimeout(() => node.remove(), 4000);
}

/** Destructive actions use a two-step inline confirm — no popups. */
function confirmButton(label: string, confirmLabel: string, action: () => void): HTMLElement {
  const btn = el("button", "btn danger-soft", label) as HTMLButtonElement;
  let armed = false;
  btn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmLabel;
      btn.classList.add("armed");
      setTimeout(() => {
        armed = false;
        btn.textContent = label;
        btn.classList.remove("armed");
      }, 3000);
    } else {
      action();
      btn.remove();
    }
  });
  return btn;
}

/* ---------------------------------- render ---------------------------------- */

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(label: string, cls: string, onClick: () => void): HTMLElement {
  const node = el("button", `btn ${cls}`, label) as HTMLButtonElement;
  node.addEventListener("click", onClick);
  return node;
}

function headline(): { text: string; tone: string } {
  if (!model.run) {
    return { text: "No run yet — create some work.", tone: "warning" };
  }
  const tasks = [...model.tasks.values()];
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const blocked = tasks.filter((t) => t.state === "BLOCKED").length;
  const done = tasks.filter((t) => t.state === "DONE").length;

  if (model.endedTs) {
    if (failed === 0 && blocked === 0) return { text: "All done — everything merged.", tone: "good" };
    const parts = [`${done} merged`];
    if (failed) parts.push(`${failed} failed`);
    if (blocked) parts.push(`${blocked} waiting on you`);
    return { text: `Finished: ${parts.join(", ")}.`, tone: failed ? "critical" : "warning" };
  }
  if (blocked > 0) return { text: `${blocked} task${blocked > 1 ? "s" : ""} need${blocked > 1 ? "" : "s"} you.`, tone: "warning" };
  if (model.manualPause) return { text: "Paused by you.", tone: "warning" };
  if (model.ratePause) {
    return {
      text: `Paused — usage limit hit, retrying in ${fmtDuration(model.ratePause.cooldown_s)}. Nothing is lost.`,
      tone: "warning",
    };
  }
  return { text: "Everything is running fine.", tone: "good" };
}

function progressBar(): HTMLElement {
  const tasks = [...model.tasks.values()];
  const total = tasks.length || 1;
  const bar = el("div", "progress");
  const done = tasks.filter((t) => t.state === "DONE").length;
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const active = tasks.filter((t) =>
    ["RUNNING", "VERIFYING", "REVIEWING", "MERGING", "MERGE_QUEUED"].includes(t.state),
  ).length;
  const seg = (cls: string, count: number) => {
    if (!count) return;
    const node = el("div", `progress-seg ${cls}`);
    node.style.width = `${(count / total) * 100}%`;
    bar.append(node);
  };
  seg("done", done);
  seg("failed", failed);
  seg("active", active);
  return bar;
}

function taskCard(t: TaskModel, kind: "attention" | "working" | "finished"): HTMLElement {
  const card = el("article", `card ${kind} state-${t.state.toLowerCase()}`);

  const head = el("div", "card-head");
  head.append(el("span", "card-activity", `${STATE_ICON[t.state]} ${ACTIVITY[t.state]}`));
  if (t.state === "RUNNING" && t.runningSince) {
    head.append(el("span", "card-timer", fmtDuration((Date.now() - t.runningSince) / 1000)));
  } else if (t.finishedAt) {
    head.append(el("span", "card-timer", ago(t.finishedAt)));
  }
  card.append(head);

  card.append(el("div", "card-title", t.title));

  if (t.note) {
    const note = el("div", `card-note${kind === "attention" ? " loud" : ""}`, t.note);
    card.append(note);
  }

  const facts: string[] = [];
  if (t.turns !== null) facts.push(`${t.turns} steps`);
  if (t.wallS !== null && t.state !== "RUNNING") facts.push(fmtDuration(t.wallS));
  if (t.retries > 0) facts.push(`attempt ${t.retries + 1}`);
  if (facts.length) card.append(el("div", "card-facts", facts.join(" · ")));

  const actions = el("div", "card-actions");
  if (t.state === "FAILED" || t.state === "BLOCKED") {
    if (model.endedTs) {
      // The dispatcher exited with the run: control commands have no reader.
      // The ticket is still in the backlog — a new run is the real retry.
      actions.append(btn("▶ Run again (new run)", "primary", () => void quickRun()));
    } else {
      actions.append(btn("↻ Try again", "primary", () => void sendControl("retry", t.id)));
    }
  }
  if (t.state === "RUNNING") {
    actions.append(confirmButton("Stop this agent", "Sure? Click again", () => void sendControl("kill", t.id)));
  }
  actions.append(btn("What did it do?", "ghost", () => void showLog(t.id, t.title)));
  card.append(actions);

  return card;
}

function section(title: string, cls: string, cards: HTMLElement[]): HTMLElement | null {
  if (!cards.length) return null;
  const node = el("section", `zone ${cls}`);
  node.append(el("h2", "", title));
  const grid = el("div", "zone-grid");
  grid.append(...cards);
  node.append(grid);
  return node;
}

function render(): void {
  const root = document.getElementById("app")!;
  root.replaceChildren();

  const tasks = [...model.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  const done = tasks.filter((t) => t.state === "DONE");
  const head = headline();

  /* sticky header: headline, progress, global controls */
  const header = el("header", `topbar tone-${head.tone}`);
  const left = el("div", "topbar-left");
  left.append(el("div", "headline", head.text));
  left.append(
    el("div", "subline",
      `${done.length} of ${tasks.length} merged · run ${model.run}` +
      (model.startedTs ? ` · started ${ago(model.startedTs)}` : "")),
  );
  header.append(left);

  const controls = el("div", "topbar-controls");
  if (workspaceList.length) {
    const picker = document.createElement("select");
    picker.className = "ws-picker";
    for (const w of workspaceList) {
      const opt = document.createElement("option");
      opt.value = w.name;
      opt.textContent = w.name;
      opt.selected = w.name === currentWs;
      picker.append(opt);
    }
    const addOpt = document.createElement("option");
    addOpt.value = "__add__";
    addOpt.textContent = "＋ add workspace…";
    picker.append(addOpt);
    picker.addEventListener("change", () => {
      if (picker.value === "__add__") {
        picker.value = currentWs;
        void showAddWorkspace();
      } else {
        switchWorkspace(picker.value);
      }
    });
    controls.append(picker);
  }
  if (!model.endedTs && model.run) {
    if (model.manualPause || model.ratePause) {
      controls.append(btn("▶ Resume", "primary", () => void sendControl("resume")));
    } else {
      controls.append(btn("⏸ Pause", "ghost", () => void sendControl("pause")));
    }
    controls.append(confirmButton("⏹ Stop run", "Sure? Click again", () => void sendControl("stop")));
  }
  controls.append(btn("⚙ Settings", "ghost", () => void showSettings()));
  controls.append(btn("📁 Repo", "ghost", () => void showRepoExplorer()));
  controls.append(btn("💬 Supervisor", "ghost", () => void showSupervisor()));
  controls.append(btn("＋ New work", model.run ? "ghost" : "primary", () => void showWorkPanel()));
  header.append(controls);
  root.append(header);
  root.append(progressBar());

  /* zones, in the order a human scans them */
  const attention = tasks
    .filter((t) => t.state === "BLOCKED" || t.state === "FAILED")
    .map((t) => taskCard(t, "attention"));
  const working = tasks
    .filter((t) =>
      ["RUNNING", "VERIFYING", "REVIEWING", "MERGING", "MERGE_QUEUED"].includes(t.state))
    .map((t) => taskCard(t, "working"));

  for (const zone of [
    section("Needs you", "attention", attention),
    section("Working now", "working", working),
  ]) {
    if (zone) root.append(zone);
  }

  const queued = tasks.filter((t) => t.state === "QUEUED");
  if (queued.length) {
    const waiting = el("section", "zone waiting");
    waiting.append(el("h2", "", `Up next (${queued.length})`));
    const row = el("div", "chip-row");
    for (const t of queued) row.append(el("span", "queue-chip", t.title));
    waiting.append(row);
    root.append(waiting);
  }

  if (done.length) {
    const zone = el("section", "zone finished");
    zone.append(el("h2", "", `Merged (${done.length})`));
    const list = el("div", "done-list");
    for (const t of done) {
      const row = el("div", "done-row");
      row.append(el("span", "done-check", "✓"));
      row.append(el("span", "done-title", t.title));
      const meta: string[] = [];
      if (t.turns !== null) meta.push(`${t.turns} steps`);
      if (t.wallS !== null) meta.push(fmtDuration(t.wallS));
      row.append(el("span", "done-meta", meta.join(" · ")));
      const more = btn("details", "link", () => void showLog(t.id, t.title));
      row.append(more);
      list.append(row);
    }
    zone.append(list);
    root.append(zone);
  }

  /* technical timeline, folded away for the curious */
  const details = document.createElement("details");
  details.className = "timeline";
  const summary = document.createElement("summary");
  summary.textContent = "Technical timeline";
  details.append(summary);
  const list = el("div", "feed-list");
  for (const event of [...model.feed].reverse()) {
    const line = el("div", "feed-line");
    line.append(el("span", "feed-ts", event.ts?.slice(11, 19) ?? ""));
    line.append(el("span", "feed-body", describe(event)));
    list.append(line);
  }
  details.append(list);
  root.append(details);
}

function describe(event: FactoryEvent): string {
  const tag = event.task ? `[${event.task}] ` : "";
  switch (event.event) {
    case "state": {
      const e = event as StateEvent;
      return `${tag}${e.from} → ${e.to}`;
    }
    case "agent_result": {
      const e = event as AgentResultEvent;
      return `${tag}agent ${e.status} (${e.turns ?? "?"} turns, ${fmtDuration(e.wall_s)})`;
    }
    case "verify": {
      const e = event as VerifyEvent;
      return `${tag}verify ${e.ok ? "ok" : "FAILED: " + e.failures.join("; ")}`;
    }
    case "retry":
      return `${tag}retry #${(event as RetryEvent).attempt}: ${(event as RetryEvent).reason}`;
    case "failure":
      return `${tag}failed: ${(event as FailureEvent).reason}`;
    case "blocked":
      return `${tag}blocked: ${(event as BlockedEvent).question}`;
    case "paused_ratelimit": {
      const e = event as PausedEvent;
      return `rate limit — pause #${e.pause_n} (${fmtDuration(e.cooldown_s)})`;
    }
    case "control":
      return `operator: ${(event as FactoryEvent & { op?: string }).op ?? "?"} ${event.task ?? ""}`;
    case "merged":
      return `${tag}merged into base`;
    case "run_start":
      return `run started (${(event as RunStartEvent).slots} slots)`;
    case "run_end": {
      const e = event as RunEndEvent;
      return `run ${e.stopped ? "stopped" : "finished"}: ` +
        Object.entries(e.counts).map(([k, v]) => `${k}=${v}`).join(" ");
    }
    default:
      return `${tag}${event.event}`;
  }
}

/* ------------------------- agent log, human-readable ------------------------- */

interface StreamRecord {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> };
  result?: string;
}

/** Turn the raw stream-json into a story: what the agent did, step by step. */
function narrateLog(raw: string): HTMLElement {
  const story = el("div", "story");
  for (const line of raw.split("\n")) {
    let record: StreamRecord;
    try {
      record = JSON.parse(line) as StreamRecord;
    } catch {
      continue;
    }
    if (record.type === "assistant" && record.message?.content) {
      for (const item of record.message.content) {
        if (item.type === "text" && item.text?.trim()) {
          story.append(el("p", "story-say", item.text.trim()));
        } else if (item.type === "tool_use" && item.name) {
          const input = item.input ?? {};
          const detail =
            (input["file_path"] as string) ??
            (input["command"] as string) ??
            (input["pattern"] as string) ??
            "";
          const short = detail.length > 90 ? "…" + detail.slice(-88) : detail;
          story.append(el("div", "story-act", `▸ ${item.name}  ${short}`));
        }
      }
    } else if (record.type === "result" && record.result) {
      // The result record repeats the assistant's final text: only show it
      // if it adds something new.
      const last = story.lastElementChild;
      if (last?.textContent?.trim() !== record.result.trim()) {
        story.append(el("p", "story-final", record.result.trim()));
      }
    }
  }
  if (!story.childElementCount) story.append(el("p", "story-say", "No activity recorded yet."));
  return story;
}

async function showLog(taskId: string, title: string): Promise<void> {
  const overlay = el("div", "overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = el("div", "log-panel");
  const head = el("div", "log-head");
  head.append(el("h3", "", title));
  head.append(btn("✕", "ghost close", () => overlay.remove()));
  panel.append(head);
  const bodyHost = el("div", "log-body", "loading…");
  panel.append(bodyHost);
  overlay.append(panel);
  document.body.append(overlay);

  const res = await fetch(api(`/api/log?task=${encodeURIComponent(taskId)}`));
  if (!res.ok) {
    bodyHost.textContent = "Nothing recorded for this task yet.";
    return;
  }
  const raw = await res.text();
  bodyHost.replaceChildren(narrateLog(raw));
  const foot = el("div", "log-foot");
  foot.append(
    btn("Show raw log", "link", () => {
      const pre = el("pre", "log-pre", raw);
      bodyHost.replaceChildren(pre);
      foot.remove();
    }),
  );
  panel.append(foot);
}

/* ------------------------ New work: plan → edit → run ------------------------ */

interface Ticket {
  file: string;
  content: string;
}

function ticketTitle(content: string): string {
  const match = content.match(/^title:\s*(.+)$/m);
  return match ? match[1]!.replace(/^["']|["']$/g, "") : "(untitled)";
}

/** Current workspace: every API call is scoped to it via ?ws=. */
let currentWs = localStorage.getItem("factory.ws") ?? "";

function api(path: string): string {
  if (!currentWs) return path;
  return path + (path.includes("?") ? "&" : "?") + "ws=" + encodeURIComponent(currentWs);
}

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(path), init);
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

interface WorkspaceInfo {
  name: string;
  workdir: string;
  currentRun: string | null;
}

let workspaceList: WorkspaceInfo[] = [];

async function loadWorkspaces(): Promise<void> {
  const { workspaces } = await fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
  workspaceList = workspaces;
  if (!workspaces.some((w) => w.name === currentWs)) {
    currentWs = workspaces[0]?.name ?? "";
    localStorage.setItem("factory.ws", currentWs);
  }
}

function switchWorkspace(name: string): void {
  currentWs = name;
  localStorage.setItem("factory.ws", name);
  connectEvents(); // fresh SSE stream, model resets on its run event
}

/* ------------------------- workspace settings ------------------------- */

const CONFIG_TEMPLATE = `repo_defaults:
  base_branch: main

concurrency:
  max_slots: 3
  stagger_seconds: 15

agent:
  command: claude
  permission_mode: acceptEdits
  allowed_tools:
    - "Bash(git add:*)"
    - "Bash(git commit:*)"
    - "Bash(git status:*)"
    - "Bash(git diff:*)"
    - "Bash(pytest:*)"
    - "Bash(python:*)"

setup:
  commands: []      # e.g. ["npm install"] or ["uv sync"] — runs in each worktree

review:
  enabled: false    # adversarial reviewer on each diff (model: haiku recommended)
  model: haiku

supervisor:
  allowed_tools: ["Read", "Glob", "Grep", "Write", "Edit"]
`;

async function showSettings(): Promise<void> {
  const { content, path } = await fetchJSON<{ content: string; path: string }>("/api/config");
  const overlay = el("div", "overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = el("div", "log-panel work-panel");
  const head = el("div", "log-head");
  head.append(el("h3", "", `Settings — ${currentWs}`));
  head.append(btn("✕", "ghost close", () => overlay.remove()));
  panel.append(head);
  panel.append(el("p", "chat-hint settings-hint",
    "This is the workspace's factory.yaml. It is read at the START of each run — " +
    "edit here, save, then launch a run. Agents are denied any tool not in " +
    "agent.allowed_tools (add \"WebSearch\"/\"WebFetch\" for web access); " +
    "setup.commands install dependencies in each worktree before the agent starts."));
  const editor = document.createElement("textarea");
  editor.className = "work-input ticket-editor settings-editor";
  editor.value = content || CONFIG_TEMPLATE;
  panel.append(editor);
  const foot = el("div", "work-launch");
  foot.append(el("span", "ticket-file", path));
  foot.append(
    btn("Save", "primary", async () => {
      try {
        await fetchJSON("/api/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: editor.value }),
        });
        toast("Config saved — it applies to the NEXT run you start.");
        overlay.remove();
      } catch (err) {
        toast(String(err), true);
      }
    }),
  );
  panel.append(foot);
  overlay.append(panel);
  document.body.append(overlay);
}

/* ------------------------- repo explorer ------------------------- */

function repoPath(): string {
  return (localStorage.getItem("factory.repo") ?? "").trim();
}

async function repoGet<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ repo: repoPath(), ...params });
  return fetchJSON<T>(`/api/repo/${endpoint}?${qs}`);
}

/** vscode://file/C:/path/file:line — opens the user's IDE, no server involved. */
function openInIDE(file: string, line = 1): void {
  const abs = repoPath().replace(/\\/g, "/") + "/" + file;
  window.location.href = `vscode://file/${abs}:${line}`;
}

function renderDiff(host: HTMLElement, diff: string): void {
  host.replaceChildren();
  const pre = el("pre", "diff-pre");
  for (const line of diff.split("\n")) {
    const cls = line.startsWith("+++") || line.startsWith("---") ? "diff-file"
      : line.startsWith("@@") ? "diff-hunk"
      : line.startsWith("+") ? "diff-add"
      : line.startsWith("-") ? "diff-del"
      : line.startsWith("commit ") ? "diff-file"
      : "";
    pre.append(el("div", `diff-line ${cls}`, line || " "));
  }
  host.append(pre);
}

async function showRepoExplorer(): Promise<void> {
  if (!repoPath()) {
    toast("Set a repository path in the New work panel first.", true);
    return;
  }
  const overlay = el("div", "overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = el("div", "log-panel repo-panel");
  const head = el("div", "log-head");
  const title = el("h3", "", `Repo — ${repoPath().split(/[\\/]/).pop()}`);
  head.append(title);

  /* branch picker + guarded switch */
  const branchPick = document.createElement("select");
  branchPick.className = "ws-picker";
  head.append(branchPick);
  head.append(btn("✕", "ghost close", () => overlay.remove()));
  panel.append(head);

  const body = el("div", "repo-body");
  const side = el("div", "repo-side");
  const tabs = el("div", "repo-tabs");
  const filesTab = btn("Files", "link", () => void loadTree());
  const historyTab = btn("History", "link", () => void loadHistory());
  tabs.append(filesTab, historyTab);
  side.append(tabs);
  const sideList = el("div", "repo-side-list");
  side.append(sideList);
  const main = el("div", "repo-main");
  main.append(el("p", "chat-hint", "Pick a file to preview it, or a commit to see its diff."));
  body.append(side, main);
  panel.append(body);
  overlay.append(panel);
  document.body.append(overlay);

  async function loadBranches(): Promise<void> {
    const { branches, current } = await repoGet<{ branches: string[]; current: string }>("branches");
    branchPick.replaceChildren();
    for (const b of branches) {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      opt.selected = b === current;
      branchPick.append(opt);
    }
    branchPick.onchange = async () => {
      try {
        await fetchJSON("/api/repo/switch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: repoPath(), branch: branchPick.value }),
        });
        toast(`Now on ${branchPick.value}.`);
        await loadTree();
      } catch (err) {
        toast(String(err), true);
        await loadBranches(); // reset selection to reality
      }
    };
  }

  async function loadTree(): Promise<void> {
    const { files } = await repoGet<{ files: string[] }>("tree");
    sideList.replaceChildren();
    // flat paths → collapsible folders
    const root: Record<string, unknown> = {};
    for (const f of files) {
      let node = root;
      const parts = f.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        node = (node[parts[i]!] ??= {}) as Record<string, unknown>;
      }
      node[parts[parts.length - 1]!] = f;
    }
    const build = (tree: Record<string, unknown>, host: HTMLElement): void => {
      const entries = Object.entries(tree).sort(([a, va], [b, vb]) => {
        const da = typeof va !== "string" ? 0 : 1;
        const db = typeof vb !== "string" ? 0 : 1;
        return da - db || a.localeCompare(b);
      });
      for (const [name, value] of entries) {
        if (typeof value === "string") {
          const row = btn(name, "tree-file", () => void openFile(value));
          host.append(row);
        } else {
          const details = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = name;
          details.append(summary);
          const inner = el("div", "tree-folder");
          build(value as Record<string, unknown>, inner);
          details.append(inner);
          host.append(details);
        }
      }
    };
    build(root, sideList);
  }

  async function openFile(path: string): Promise<void> {
    const { content } = await repoGet<{ content: string }>("file", { path });
    main.replaceChildren();
    const bar = el("div", "repo-file-bar");
    bar.append(el("span", "card-title", path));
    bar.append(btn("Open in IDE", "ghost", () => openInIDE(path)));
    main.append(bar);
    main.append(el("pre", "file-pre", content));
  }

  async function loadHistory(): Promise<void> {
    const { commits } = await repoGet<{
      commits: Array<{ hash: string; date: string; author: string; subject: string }>;
    }>("log");
    sideList.replaceChildren();
    for (const c of commits) {
      const row = btn("", "commit-row", () => void openDiff(c.hash));
      row.append(el("div", "commit-subject", c.subject));
      row.append(el("div", "commit-meta", `${c.hash} · ${c.author} · ${c.date}`));
      sideList.append(row);
    }
  }

  async function openDiff(commit: string): Promise<void> {
    const { diff } = await repoGet<{ diff: string }>("diff", { commit });
    main.replaceChildren();
    main.append(el("div", "repo-file-bar", `Commit ${commit}`));
    renderDiff(main, diff);
  }

  await loadBranches();
  await loadTree();
}

/* ------------------------- supervisor chat ------------------------- */

/** Chat history per workspace, kept for the lifetime of the page. */
const chatHistory = new Map<string, Array<{ who: "you" | "supervisor"; text: string }>>();

async function showSupervisor(): Promise<void> {
  const history = chatHistory.get(currentWs) ?? [];
  chatHistory.set(currentWs, history);

  const overlay = el("div", "overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = el("div", "log-panel chat-panel");
  const head = el("div", "log-head");
  head.append(el("h3", "", `Supervisor — ${currentWs}`));
  head.append(btn("✕", "ghost close", () => overlay.remove()));
  panel.append(head);

  const messages = el("div", "chat-messages");
  panel.append(messages);

  function renderMessages(thinking = false): void {
    messages.replaceChildren();
    if (!history.length) {
      messages.append(el("p", "chat-hint",
        "Ask anything about the current run — \"how is it going?\", \"why did task 2 fail?\" — " +
        "or give an instruction: \"kill task 3 and retry it with a note to use the internal lib\"."));
    }
    for (const m of history) {
      messages.append(el("div", `chat-msg ${m.who}`, m.text));
    }
    if (thinking) messages.append(el("div", "chat-msg supervisor thinking", "…"));
    messages.scrollTop = messages.scrollHeight;
  }

  const inputRow = el("div", "chat-input-row");
  const input = document.createElement("textarea");
  input.className = "work-input chat-input";
  input.placeholder = "Message the supervisor…";
  const sendBtn = btn("Send", "primary", () => void send()) as HTMLButtonElement;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  inputRow.append(input, sendBtn);
  panel.append(inputRow);

  async function send(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    history.push({ who: "you", text });
    renderMessages(true);
    sendBtn.disabled = true;
    try {
      await fetchJSON("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const timer = setInterval(async () => {
        const status = await fetchJSON<{ chat: { state: string; output: string } }>("/api/status");
        if (status.chat.state === "running") return;
        clearInterval(timer);
        sendBtn.disabled = false;
        const reply = status.chat.output.trim() ||
          (status.chat.state === "error" ? "The supervisor failed to answer — see server logs."
                                         : "(no answer)");
        history.push({ who: "supervisor", text: reply });
        renderMessages();
      }, 1500);
    } catch (err) {
      sendBtn.disabled = false;
      history.push({ who: "supervisor", text: `Error: ${String(err)}` });
      renderMessages();
    }
  }

  overlay.append(panel);
  document.body.append(overlay);
  renderMessages();
  input.focus();
}

async function showAddWorkspace(): Promise<void> {
  const overlay = el("div", "overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = el("div", "log-panel work-panel");
  const head = el("div", "log-head");
  head.append(el("h3", "", "Add a workspace"));
  head.append(btn("✕", "ghost close", () => overlay.remove()));
  panel.append(head);
  const form = el("div", "work-form");
  form.append(el("label", "work-label", "Name"));
  const nameInput = document.createElement("input");
  nameInput.className = "work-input";
  nameInput.placeholder = "my-project";
  form.append(nameInput);
  form.append(el("label", "work-label", "Folder (holds factory.yaml, backlog, runs)"));
  const dirInput = document.createElement("input");
  dirInput.className = "work-input";
  dirInput.placeholder = "C:\\path\\to\\a\\work\\folder";
  form.append(dirInput);
  form.append(
    btn("Add", "primary", async () => {
      try {
        await fetchJSON("/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: nameInput.value.trim(), workdir: dirInput.value.trim() }),
        });
        await loadWorkspaces();
        switchWorkspace(nameInput.value.trim());
        toast(`Workspace "${nameInput.value.trim()}" added.`);
        overlay.remove();
      } catch (err) {
        toast(String(err), true);
      }
    }),
  );
  panel.append(form);
  overlay.append(panel);
  document.body.append(overlay);
}

async function showWorkPanel(): Promise<void> {
  const overlay = el("div", "overlay");
  const panel = el("div", "log-panel work-panel");
  const head = el("div", "log-head");
  head.append(el("h3", "", "New work"));
  head.append(btn("✕", "ghost close", () => overlay.remove()));
  panel.append(head);
  const body = el("div", "log-body");
  panel.append(body);
  overlay.append(panel);
  document.body.append(overlay);

  /* --- step 1: goal + repo → plan --- */
  const form = el("div", "work-form");
  form.append(el("label", "work-label", "Repository path"));
  const repoInput = document.createElement("input");
  repoInput.className = "work-input";
  repoInput.placeholder = "C:\\path\\to\\your\\repo";
  repoInput.value = localStorage.getItem("factory.repo") ?? "";
  form.append(repoInput);

  /* repo tools: start from zero, publish, change visibility */
  const repoTools = el("div", "repo-tools");
  const visPick = document.createElement("select");
  visPick.className = "ws-picker";
  for (const v of ["private", "public"]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    visPick.append(opt);
  }
  const repoAction = async (endpoint: string, withVisibility: boolean) => {
    localStorage.setItem("factory.repo", repoInput.value);
    try {
      const body: Record<string, string> = { path: repoInput.value.trim() };
      if (withVisibility) body.visibility = visPick.value;
      const result = await fetchJSON<{ output?: string }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast(result.output?.slice(-280) || "Done.");
    } catch (err) {
      toast(String(err), true);
    }
  };
  repoTools.append(
    btn("🆕 Start project here", "ghost", () => void repoAction("/api/repo/init", false)),
    visPick,
    btn("⬆ Publish to GitHub", "ghost", () => void repoAction("/api/repo/publish", true)),
    confirmButton("Set visibility", "Sure? Click again",
      () => void repoAction("/api/repo/visibility", true)),
  );
  form.append(repoTools);
  form.append(el("label", "work-label", "What do you want done?"));
  const goalInput = document.createElement("textarea");
  goalInput.className = "work-input work-goal";
  goalInput.placeholder = "One or two sentences. The planner explores the repo and drafts the tickets.";
  form.append(goalInput);
  const planBtn = btn("✨ Draft tickets with AI", "primary", () => void startPlan()) as HTMLButtonElement;
  form.append(planBtn);
  const planOut = el("pre", "log-pre plan-out");
  planOut.style.display = "none";
  form.append(planOut);
  body.append(form);

  /* --- step 2: backlog, editable in place --- */
  const backlogZone = el("div", "work-backlog");
  body.append(backlogZone);

  /* --- step 3: launch --- */
  const launch = el("div", "work-launch");
  launch.append(el("label", "work-label inline", "Parallel agents"));
  const slotsInput = document.createElement("input");
  slotsInput.type = "number";
  slotsInput.min = "1";
  slotsInput.value = "3";
  slotsInput.className = "work-input slots";
  launch.append(slotsInput);
  const runBtn = btn("▶ Start run", "primary", () => void startRun()) as HTMLButtonElement;
  launch.append(runBtn);
  body.append(launch);

  async function refreshBacklog(): Promise<void> {
    const { tickets } = await fetchJSON<{ tickets: Ticket[] }>("/api/backlog");
    backlogZone.replaceChildren();
    launch.style.display = tickets.length ? "flex" : "none";
    if (!tickets.length) return;
    backlogZone.append(el("h2", "", `Tickets ready (${tickets.length})`));
    for (const ticket of tickets) {
      const row = el("div", "ticket-row");
      const label = el("div", "ticket-title", ticketTitle(ticket.content));
      label.append(el("span", "ticket-file", ` ${ticket.file}`));
      row.append(label);
      const actions = el("div", "card-actions");
      actions.append(
        btn("Edit", "ghost", () => {
          const editor = document.createElement("textarea");
          editor.className = "work-input ticket-editor";
          editor.value = ticket.content;
          const save = btn("Save", "primary", async () => {
            try {
              await fetchJSON(`/api/backlog/${encodeURIComponent(ticket.file)}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: editor.value }),
              });
              toast("Ticket saved.");
              await refreshBacklog();
            } catch (err) {
              toast(String(err), true);
            }
          });
          row.replaceChildren(editor, save);
        }),
        confirmButton("Delete", "Sure?", async () => {
          await fetchJSON(`/api/backlog/${encodeURIComponent(ticket.file)}`, { method: "DELETE" });
          toast("Ticket deleted.");
          await refreshBacklog();
        }),
      );
      row.append(actions);
      backlogZone.append(row);
    }
  }

  async function startPlan(): Promise<void> {
    try {
      localStorage.setItem("factory.repo", repoInput.value);
      await fetchJSON("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: goalInput.value, repo: repoInput.value }),
      });
    } catch (err) {
      toast(String(err), true);
      return;
    }
    planBtn.disabled = true;
    planBtn.textContent = "Planning… (the agent is exploring your repo)";
    planOut.style.display = "block";
    const timer = setInterval(async () => {
      const status = await fetchJSON<{ plan: { state: string; output: string } }>("/api/status");
      planOut.textContent = status.plan.output.slice(-3000) || "…";
      planOut.scrollTop = planOut.scrollHeight;
      if (status.plan.state === "running") return;
      clearInterval(timer);
      planBtn.disabled = false;
      planBtn.textContent = "✨ Draft tickets with AI";
      if (status.plan.state === "done") {
        toast("Tickets drafted — review them below.");
        await refreshBacklog();
      } else {
        toast("Planning failed — see the output.", true);
      }
    }, 1500);
  }

  async function startRun(): Promise<void> {
    try {
      await fetchJSON("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slots: Number(slotsInput.value) || undefined }),
      });
    } catch (err) {
      toast(String(err), true);
      return;
    }
    toast("Run starting — the board follows automatically.");
    overlay.remove();
    // Surface an early crash (e.g. preflight refusing a dirty repo).
    let checks = 0;
    const timer = setInterval(async () => {
      const status = await fetchJSON<{ run: { state: string; output: string } }>("/api/status");
      if (status.run.state === "error") {
        clearInterval(timer);
        toast(status.run.output.slice(-280) || "The run failed to start.", true);
      } else if (status.run.state !== "running" || ++checks > 20) {
        clearInterval(timer);
      }
    }, 2000);
  }

  await refreshBacklog();
}

/* ---------------------------------- wiring ---------------------------------- */

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

let source: EventSource | null = null;

function connectEvents(): void {
  source?.close();
  model = freshModel("");
  source = new EventSource(api("/api/events"));
  source.addEventListener("run", (e) => {
    const { run } = JSON.parse((e as MessageEvent).data) as { run: string | null };
    model = freshModel(run ?? "");
    scheduleRender();
  });
  source.onmessage = (e) => {
    try {
      reduce(JSON.parse(e.data) as FactoryEvent);
    } catch {
      return; // torn line mid-write: the next poll resends a complete one
    }
    scheduleRender();
  };
  scheduleRender();
}

// Live timers: re-render every second while something is running.
setInterval(() => {
  const active = [...model.tasks.values()].some((t) => t.runningSince !== null);
  if (active || model.ratePause) scheduleRender();
}, 1000);

void loadWorkspaces().then(connectEvents);
render();

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

/**
 * How many two-step confirms are currently armed. While > 0 the auto-render is
 * held: a re-render would replace the button node and reset it to step one, so
 * the second click could never land (this is why "stop" felt broken).
 */
let armedCount = 0;

/** Destructive actions use a two-step inline confirm — no popups. */
function confirmButton(label: string, confirmLabel: string, action: () => void): HTMLElement {
  const btn = el("button", "btn danger-soft", label) as HTMLButtonElement;
  let armed = false;
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    armedCount--;
    btn.textContent = label;
    btn.classList.remove("armed");
  };
  btn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      armedCount++;
      btn.textContent = confirmLabel;
      btn.classList.add("armed");
      setTimeout(disarm, 3000);
    } else {
      disarm();
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

/**
 * A run is "live" only if a dispatcher is actually running for it. If not
 * (finished, or its process died), operator commands like stop/kill reach a file
 * nobody reads — so we must not offer them; "Run again" is the real action.
 */
function runLive(): boolean {
  return Boolean(model.run) && !model.endedTs && runActive;
}

function headline(): { text: string; tone: string } {
  if (!model.run) {
    return { text: "No run yet — create some work.", tone: "warning" };
  }
  if (!model.endedTs && !runActive) {
    return {
      text: "This run is no longer active — its process has stopped. " +
        "Start a new run to finish the remaining work.",
      tone: "warning",
    };
  }
  const tasks = [...model.tasks.values()];
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const blocked = tasks.filter((t) => t.state === "BLOCKED").length;
  const done = tasks.filter((t) => t.state === "DONE").length;

  if (model.endedTs) {
    const queued = tasks.filter((t) => t.state === "QUEUED").length;
    if (model.stopped || queued > 0) {
      return {
        text: `Stopped — ${queued} task${queued > 1 ? "s" : ""} still waiting ` +
          "(usage limit or manual stop). They run on the next start.",
        tone: "warning",
      };
    }
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
    const timer = el("span", "card-timer", fmtDuration((Date.now() - t.runningSince) / 1000));
    timer.dataset["since"] = String(t.runningSince); // ticked in place, no re-render
    head.append(timer);
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
  const live = runLive();
  if (t.state === "FAILED" || t.state === "BLOCKED") {
    if (live) {
      actions.append(btn("↻ Try again", "primary", () => void sendControl("retry", t.id)));
    } else {
      // No live dispatcher: a retry command would have no reader. The ticket is
      // still in the backlog — a new run is the real retry.
      actions.append(btn("▶ Run again (new run)", "primary", () => void quickRun()));
    }
  }
  if (t.state === "RUNNING" && live) {
    actions.append(confirmButton("Stop this agent", "Sure? Click again", () => void sendControl("kill", t.id)));
  }
  const watching = inFlight(t.state);
  actions.append(btn(watching ? "👁 Watch live" : "What did it do?",
    watching ? "primary" : "ghost", () => void showLog(t.id, t.title)));
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
  const live = runLive();
  if (live) {
    if (model.manualPause || model.ratePause) {
      controls.append(btn("▶ Resume", "primary", () => void sendControl("resume")));
    } else {
      controls.append(btn("⏸ Pause", "ghost", () => void sendControl("pause")));
    }
    controls.append(confirmButton("⏹ Stop run", "Sure? Click again", () => void sendControl("stop")));
  } else if (model.run && tasks.some((t) => t.state !== "DONE")) {
    // Not live but work remains (queued, or a task the dead run never finished):
    // a fresh run is the only thing that actually moves it forward.
    controls.append(btn("▶ Run again (new run)", "primary", () => void quickRun()));
  }
  controls.append(btn("🌐 View result", "ghost", () => void viewResult()));
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

interface ContentItem {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}
interface StreamRecord {
  type?: string;
  message?: { content?: ContentItem[] };
  result?: string;
}

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** A short, human label for what a tool call is doing. */
function toolDetail(input: Record<string, unknown>): string {
  const pick = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  return (
    pick("file_path") ?? pick("command") ?? pick("pattern") ??
    pick("url") ?? pick("query") ?? pick("path") ??
    pick("description") ?? pick("prompt") ?? ""
  );
}

function clip(text: string, n = 200): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function toolResultText(content: ContentItem["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text ?? "").join(" ").trim();
  }
  return "";
}

/** Turn the raw stream-json into a story: what the agent did, step by step. */
function narrateLog(raw: string): HTMLElement {
  const story = el("div", "story");
  const delegated = new Set<string>(); // tool_use ids of sub-agent spawns
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
          if (SUBAGENT_TOOLS.has(item.name)) {
            // A sub-agent spawn: make it prominent — this is a whole nested
            // session. Show who it is and the mission it was given.
            if (item.id) delegated.add(item.id);
            const who = (input["subagent_type"] as string) ?? "sub-agent";
            const mission = clip(
              (input["description"] as string) ?? (input["prompt"] as string) ?? "", 240,
            );
            const block = el("div", "story-delegate");
            block.append(el("div", "delegate-head", `🤖 delegated to ${who}`));
            if (mission) block.append(el("div", "delegate-mission", mission));
            story.append(block);
          } else {
            const short = clip(toolDetail(input), 90);
            story.append(el("div", "story-act", `▸ ${item.name}  ${short}`));
          }
        }
      }
    } else if (record.type === "user" && record.message?.content) {
      // A tool result. We surface only sub-agent results — the finished output
      // of a nested session — since ordinary tool outputs are noise here.
      for (const item of record.message.content) {
        if (item.type === "tool_result" && item.tool_use_id && delegated.has(item.tool_use_id)) {
          const text = clip(toolResultText(item.content), 400);
          if (text) story.append(el("div", "story-subresult", `↳ ${text}`));
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

const IN_FLIGHT: TaskState[] = ["RUNNING", "VERIFYING", "REVIEWING", "MERGING", "MERGE_QUEUED"];
function inFlight(state: TaskState | undefined): boolean {
  return state !== undefined && IN_FLIGHT.includes(state);
}

/**
 * Window into one ticket's Claude session. While the agent is still working it
 * FOLLOWS live — polling the growing stream and re-narrating, auto-scrolling to
 * the newest step — so the run stops feeling opaque. Stops on its own when the
 * ticket reaches a terminal state or the panel is closed.
 */
async function showLog(taskId: string, title: string): Promise<void> {
  const overlay = el("div", "overlay");
  let timer: ReturnType<typeof setInterval> | null = null;
  const close = (): void => {
    if (timer) clearInterval(timer);
    overlay.remove();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const panel = el("div", "log-panel");
  const head = el("div", "log-head");
  const titleWrap = el("div", "log-title");
  titleWrap.append(el("h3", "", title));
  const liveTag = el("span", "live-tag", "● live");
  liveTag.style.display = "none";
  titleWrap.append(liveTag);
  head.append(titleWrap);
  head.append(btn("✕", "ghost close", close));
  panel.append(head);
  const bodyHost = el("div", "log-body", "loading…");
  panel.append(bodyHost);

  const foot = el("div", "log-foot");
  let rawMode = false;
  const rawToggle = btn("Show raw log", "link", () => {
    rawMode = !rawMode;
    (rawToggle as HTMLButtonElement).textContent = rawMode ? "Show as story" : "Show raw log";
    void refresh();
  }) as HTMLButtonElement;
  foot.append(rawToggle);
  panel.append(foot);
  overlay.append(panel);
  document.body.append(overlay);

  let hasContent = false;
  async function refresh(): Promise<void> {
    let raw: string;
    try {
      const res = await fetch(api(`/api/log?task=${encodeURIComponent(taskId)}`));
      if (!res.ok) {
        if (!hasContent) bodyHost.textContent = "Nothing recorded for this task yet.";
        return;
      }
      raw = await res.text();
    } catch {
      return; // transient — keep what's on screen, next tick retries
    }
    hasContent = true;
    // Stay pinned to the newest step unless the reader scrolled up to look back.
    const stick = bodyHost.scrollHeight - bodyHost.scrollTop - bodyHost.clientHeight < 60;
    bodyHost.replaceChildren(rawMode ? el("pre", "log-pre", raw) : narrateLog(raw));
    if (stick) bodyHost.scrollTop = bodyHost.scrollHeight;
  }

  await refresh();

  if (inFlight(model.tasks.get(taskId)?.state)) {
    liveTag.style.display = "";
    timer = setInterval(async () => {
      await refresh();
      if (!inFlight(model.tasks.get(taskId)?.state)) {
        liveTag.style.display = "none";
        if (timer) clearInterval(timer);
        timer = null;
      }
    }, 1500);
  }
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

interface Settings {
  slots: number;
  internet: boolean;
  project: "node" | "python" | "other";
  setupCommands: string; // comma-separated, human-entered
  reviewer: boolean;
  reviewerModel: string;
  effort: string; // "" = the CLI's own default; otherwise low…ultracode
  maxRetries: number; // retries a failing ticket gets before FAILED
}

// Capped at High on purpose: xhigh/max/ultracode burn far more tokens. They stay
// reachable for power users via the Advanced raw YAML (effort: xhigh), just not
// one click away where they'd be picked by accident.
const EFFORT_CHOICES: Array<[string, string]> = [
  ["", "Default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
];

/** Read our known knobs out of the stored YAML (tolerant, regex-based). */
function parseSettings(content: string): Settings {
  const section = (name: string): string => {
    const match = content.match(new RegExp(`^${name}:([\\s\\S]*?)(?=^[a-z]|$(?![\\s\\S]))`, "m"));
    return match?.[1] ?? "";
  };
  const setup = section("setup");
  const review = section("review");
  const setupCmds = [...setup.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
    .filter((c) => !/^\d+$/.test(c));
  const hasNpm = /npm|npx|node/.test(content);
  const hasPy = /pytest|uv sync|ruff/.test(content);
  return {
    slots: Number(content.match(/max_slots:\s*(\d+)/)?.[1] ?? 3),
    internet: /WebSearch/.test(content),
    project: hasNpm ? "node" : hasPy ? "python" : "other",
    setupCommands: setupCmds.join(", "),
    reviewer: /enabled:\s*true/.test(review),
    reviewerModel: review.match(/model:\s*"?(\w+)"?/)?.[1] ?? "haiku",
    effort: content.match(/^\s*effort:\s*"?(\w+)"?/m)?.[1] ?? "",
    maxRetries: Number(content.match(/max_retries:\s*(\d+)/)?.[1] ?? 1),
  };
}

/** The single source of truth the form compiles down to. */
function generateConfig(s: Settings): string {
  const base = [
    '"Bash(git add:*)"', '"Bash(git commit:*)"', '"Bash(git status:*)"',
    '"Bash(git diff:*)"', '"Bash(git log:*)"',
  ];
  const presets: Record<Settings["project"], string[]> = {
    node: ['"Bash(npm install:*)"', '"Bash(npm ci:*)"', '"Bash(npm test:*)"',
      '"Bash(npm run:*)"', '"Bash(npx:*)"', '"Bash(node:*)"'],
    python: ['"Bash(uv sync:*)"', '"Bash(uv run:*)"', '"Bash(pytest:*)"',
      '"Bash(python:*)"', '"Bash(ruff:*)"'],
    other: ['"Bash(python:*)"'],
  };
  const tools = [...base, ...presets[s.project]];
  if (s.internet) tools.push('"WebSearch"', '"WebFetch"');
  const setup = s.setupCommands.split(",").map((c) => c.trim()).filter(Boolean);
  return [
    "# Generated by the dashboard Settings panel — read at the start of each run.",
    "repo_defaults:",
    "  base_branch: main",
    "",
    "concurrency:",
    `  max_slots: ${s.slots}`,
    "  stagger_seconds: 15",
    `  max_retries: ${s.maxRetries}`,
    "",
    "agent:",
    "  command: claude",
    "  permission_mode: acceptEdits",
    ...(s.effort ? [`  effort: ${s.effort}`] : []),
    "  allowed_tools:",
    ...tools.map((t) => `    - ${t}`),
    "",
    "setup:",
    `  commands: [${setup.map((c) => `"${c}"`).join(", ")}]`,
    "  timeout_s: 600",
    "",
    "review:",
    `  enabled: ${s.reviewer}`,
    `  model: ${s.reviewerModel}`,
    "  timeout_min: 10",
    "",
    "supervisor:",
    '  allowed_tools: ["Read", "Glob", "Grep", "Write", "Edit"]',
    "",
  ].join("\n");
}

async function showSettings(): Promise<void> {
  const { content } = await fetchJSON<{ content: string; path: string }>("/api/config");
  const s = parseSettings(content);

  const overlay = el("div", "overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = el("div", "log-panel work-panel");
  const head = el("div", "log-head");
  head.append(el("h3", "", `Settings — ${currentWs}`));
  head.append(btn("✕", "ghost close", () => overlay.remove()));
  panel.append(head);
  const body = el("div", "log-body settings-form");
  panel.append(body);

  let rawTouched = false;

  const row = (label: string, hint: string, control: HTMLElement): HTMLElement => {
    const node = el("div", "setting-row");
    const text = el("div", "setting-text");
    text.append(el("div", "setting-label", label), el("div", "setting-hint", hint));
    node.append(text, control);
    return node;
  };
  const toggle = (checked: boolean, onChange: (v: boolean) => void): HTMLElement => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "switch";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    return input;
  };

  /* internet */
  body.append(row(
    "Internet access",
    "Agents may search and read the web. Needed for research tasks; adds exposure to web content.",
    toggle(s.internet, (v) => { s.internet = v; sync(); }),
  ));

  /* project type */
  const projWrap = el("div", "chip-choice");
  const projects: Array<[Settings["project"], string]> = [
    ["node", "Node / JS"], ["python", "Python"], ["other", "Other"],
  ];
  for (const [value, label] of projects) {
    const chip = btn(label, "choice" + (s.project === value ? " on" : ""), () => {
      s.project = value;
      s.setupCommands = value === "node" ? "npm install" : value === "python" ? "uv sync" : "";
      setupInput.value = s.setupCommands;
      for (const c of projWrap.children) c.classList.toggle("on", c === chip);
      sync();
    });
    projWrap.append(chip);
  }
  body.append(row(
    "Project type",
    "Grants the matching build tools to agents and preselects the dependency install.",
    projWrap,
  ));

  /* setup commands */
  const setupInput = document.createElement("input");
  setupInput.className = "work-input setting-input";
  setupInput.placeholder = "npm install";
  setupInput.value = s.setupCommands;
  setupInput.addEventListener("input", () => { s.setupCommands = setupInput.value; sync(); });
  body.append(row(
    "Install dependencies",
    "Run in every agent's fresh copy of the repo, before work starts. Comma-separated.",
    setupInput,
  ));

  /* reviewer */
  const reviewControls = el("div", "chip-choice");
  const reviewToggle = toggle(s.reviewer, (v) => { s.reviewer = v; sync(); });
  reviewControls.append(reviewToggle);
  body.append(row(
    "Code reviewer",
    "A second AI double-checks every change before it is merged: scope, gamed tests, obvious bugs.",
    reviewControls,
  ));

  /* reasoning effort */
  const effortPick = document.createElement("select");
  effortPick.className = "ws-picker";
  const effortChoices = [...EFFORT_CHOICES];
  // Preserve an advanced-set expensive level (xhigh/max/…) instead of dropping it.
  if (s.effort && !effortChoices.some(([v]) => v === s.effort)) {
    effortChoices.push([s.effort, `${s.effort} (expensive)`]);
  }
  for (const [value, label] of effortChoices) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    opt.selected = value === s.effort;
    effortPick.append(opt);
  }
  effortPick.addEventListener("change", () => { s.effort = effortPick.value; sync(); });
  body.append(row(
    "Reasoning effort",
    "How hard each agent thinks. Higher digs deeper but is slower and spends more; " +
    "'Default' leaves it to Claude Code. Raise it for tricky tasks (charts, data, logic).",
    effortPick,
  ));

  /* retries — the cost guard the user asked for */
  const retriesInput = document.createElement("input");
  retriesInput.type = "number";
  retriesInput.min = "0";
  retriesInput.className = "work-input slots";
  retriesInput.value = String(s.maxRetries);
  retriesInput.addEventListener("input", () => {
    s.maxRetries = Math.max(0, Number(retriesInput.value) || 0);
    sync();
  });
  body.append(row(
    "Retries per task",
    "How many times a failing ticket is re-attempted before giving up. Each retry is a " +
    "full agent run that spends usage — keep it low (0 or 1) for costly research tasks.",
    retriesInput,
  ));

  /* parallel agents */
  const slotsInput = document.createElement("input");
  slotsInput.type = "number";
  slotsInput.min = "1";
  slotsInput.className = "work-input slots";
  slotsInput.value = String(s.slots);
  slotsInput.addEventListener("input", () => {
    s.slots = Math.max(1, Number(slotsInput.value) || 3);
    sync();
  });
  body.append(row(
    "Parallel agents",
    "How many agents work at the same time. 3 is a sane default on a subscription plan.",
    slotsInput,
  ));

  /* advanced: the generated file, for engineers */
  const advanced = document.createElement("details");
  advanced.className = "settings-advanced";
  const advSummary = document.createElement("summary");
  advSummary.textContent = "Advanced (raw configuration)";
  advanced.append(advSummary);
  const raw = document.createElement("textarea");
  raw.className = "work-input ticket-editor settings-editor";
  raw.value = content || generateConfig(s);
  raw.addEventListener("input", () => { rawTouched = true; });
  advanced.append(raw);
  body.append(advanced);

  function sync(): void {
    if (!rawTouched) raw.value = generateConfig(s);
  }
  if (!content) sync();

  const testResult = el("pre", "doctor-result");
  testResult.style.display = "none";
  body.append(testResult);

  async function saveConfig(): Promise<void> {
    const finalContent = rawTouched ? raw.value : generateConfig(s);
    await fetchJSON("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: finalContent }),
    });
  }

  const foot = el("div", "work-launch");
  const testBtn = btn("🧪 Test these settings", "ghost", async () => {
    try {
      await saveConfig(); // test what you see, not what was on disk
      await fetchJSON("/api/doctor", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } catch (err) {
      toast(String(err), true);
      return;
    }
    (testBtn as HTMLButtonElement).disabled = true;
    testResult.style.display = "block";
    testResult.textContent = "Testing for real — one tiny agent tries the web and your commands (~30s)…";
    const timer = setInterval(async () => {
      const status = await fetchJSON<{ doctor: { state: string; output: string } }>("/api/status");
      if (status.doctor.state === "running") return;
      clearInterval(timer);
      (testBtn as HTMLButtonElement).disabled = false;
      testResult.textContent = status.doctor.output.trim() ||
        (status.doctor.state === "error" ? "The check failed — see server logs." : "(no result)");
    }, 2000);
  }) as HTMLButtonElement;
  foot.append(testBtn);
  foot.append(el("span", "setting-hint", "Applies to the next run you start."));
  foot.append(
    btn("Save", "primary", async () => {
      try {
        await saveConfig();
        toast("Saved. Your next run uses these settings.");
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

/* ------------------------- live preview ("View result") ------------------------- */

interface PreviewStatus {
  kind: "web" | "static" | "none";
  state: "idle" | "starting" | "ready" | "error";
  url: string | null;
  output: string;
}

/** One click: figure out what the product is and open it in the browser. */
async function viewResult(): Promise<void> {
  const repo = repoPath();
  if (!repo) {
    toast("Set a repository path in the New work panel first.", true);
    return;
  }
  let detected: { kind: PreviewStatus["kind"]; script?: string };
  try {
    detected = await fetchJSON(`/api/preview/detect?repo=${encodeURIComponent(repo)}`);
  } catch (err) {
    toast(String(err), true);
    return;
  }
  if (detected.kind === "none") {
    // Not a web app — the "result" is the code itself. Show the files instead.
    toast("Not a web project — opening the files instead.");
    void showRepoExplorer();
    return;
  }
  try {
    await fetchJSON("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo }),
    });
  } catch (err) {
    toast(String(err), true);
    return;
  }
  showPreviewModal(detected.kind);
}

function showPreviewModal(kind: PreviewStatus["kind"]): void {
  const overlay = el("div", "overlay");
  let timer: ReturnType<typeof setInterval> | null = null;
  const close = (): void => {
    if (timer) clearInterval(timer);
    overlay.remove();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const panel = el("div", "log-panel preview-panel");
  const head = el("div", "log-head");
  head.append(el("h3", "", "Live preview"));
  head.append(btn("✕", "ghost close", close));
  panel.append(head);
  const status = el("div", "preview-status",
    kind === "web"
      ? "Booting the dev server… first start can take a moment while it installs and compiles."
      : "Serving the site…");
  const actions = el("div", "card-actions");
  const out = el("pre", "log-pre preview-out");
  out.style.display = "none";
  panel.append(status, actions, out);
  overlay.append(panel);
  document.body.append(overlay);

  let opened = false;
  timer = setInterval(async () => {
    let p: PreviewStatus;
    try {
      p = await fetchJSON<PreviewStatus>("/api/preview");
    } catch {
      return;
    }
    if (p.output.trim()) {
      out.style.display = "block";
      out.textContent = p.output.slice(-1500);
      out.scrollTop = out.scrollHeight;
    }
    if (p.state === "ready" && p.url) {
      const url = p.url;
      status.textContent = `Ready — the site is live at ${url}`;
      actions.replaceChildren(
        btn("▸ Open the site", "primary", () => window.open(url, "_blank")),
        confirmButton("Stop the preview server", "Sure? Click again", async () => {
          try {
            await fetchJSON("/api/preview/stop", { method: "POST" });
            toast("Preview server stopped.");
          } catch (err) {
            toast(String(err), true);
          }
          close();
        }),
      );
      // Try to auto-open once; popup blockers may swallow it, hence the button.
      if (!opened) {
        opened = true;
        window.open(url, "_blank");
      }
      if (timer) clearInterval(timer);
      timer = null;
    } else if (p.state === "error") {
      status.textContent = "Could not start the preview — see the output below.";
      out.style.display = "block";
      if (timer) clearInterval(timer);
      timer = null;
    } else if (p.state === "idle") {
      status.textContent = "The preview server stopped.";
      if (timer) clearInterval(timer);
      timer = null;
    }
  }, 1500);
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

/**
 * Rendering replaces the whole board, which would wipe out whatever the operator
 * is doing (an armed confirm, a focused field, a value being typed). So renders
 * are coalesced through a dirty flag and HELD while an interaction is in flight —
 * the board catches up the instant the interaction ends. This is what made the
 * dashboard feel unusable before: it rebuilt itself under the user's cursor.
 */
let dirty = false;
function scheduleRender(): void {
  dirty = true;
}

function renderHeld(): boolean {
  if (armedCount > 0) return true;
  if (document.querySelector(".overlay")) return true; // a modal owns the screen
  const active = document.activeElement as HTMLElement | null;
  if (active && active.closest("#app") && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
    return true;
  }
  return false;
}

// One flusher: renders at most ~7×/s, and never on top of an interaction.
setInterval(() => {
  if (dirty && !renderHeld()) {
    dirty = false;
    render();
  }
}, 150);

// Live timers update IN PLACE — no full re-render, so they never fight the user.
setInterval(() => {
  const now = Date.now();
  for (const node of document.querySelectorAll<HTMLElement>("[data-since]")) {
    node.textContent = fmtDuration((now - Number(node.dataset["since"])) / 1000);
  }
  // The rate-limit countdown lives in the headline; refresh it via a normal
  // (held-aware) render, which is fine because nobody clicks during a pause.
  if (model.ratePause) scheduleRender();
}, 1000);

/**
 * Is a dispatcher actually alive for the shown run? A run started in a previous
 * server process (or one whose process was killed) leaves the board showing live
 * controls that write to a control file nobody reads. We poll the server's own
 * job state to tell the truth and offer "Run again" instead of dead buttons.
 */
let runActive = true;
async function pollRunActive(): Promise<void> {
  try {
    const status = await fetchJSON<{ run: { state: string } }>("/api/status");
    const active = status.run.state === "running";
    if (active !== runActive) {
      runActive = active;
      scheduleRender();
    }
  } catch {
    /* transient — keep the last known value */
  }
}
setInterval(() => void pollRunActive(), 3000);

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

void loadWorkspaces().then(() => {
  connectEvents();
  void pollRunActive();
});
render();

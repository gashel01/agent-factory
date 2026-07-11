/**
 * Dashboard client: replays the SSE event stream into an in-memory model and
 * renders a status board. No framework — the DOM is small and the state is tiny.
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

interface TaskModel {
  id: string;
  title: string;
  state: TaskState;
  turns: number | null;
  wallS: number | null;
  note: string;
  retries: number;
}

interface Model {
  run: string;
  slots: number | null;
  startedTs: string | null;
  endedTs: string | null;
  stopped: boolean;
  pause: PausedEvent | null;
  tasks: Map<string, TaskModel>;
  feed: FactoryEvent[];
}

const FEED_LIMIT = 150;

function freshModel(run: string): Model {
  return {
    run,
    slots: null,
    startedTs: null,
    endedTs: null,
    stopped: false,
    pause: null,
    tasks: new Map(),
    feed: [],
  };
}

let model = freshModel("");

function task(id: string): TaskModel {
  let entry = model.tasks.get(id);
  if (!entry) {
    entry = { id, title: id, state: "QUEUED", turns: null, wallS: null, note: "", retries: 0 };
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
      task(e.task).state = e.to;
      if (e.to === "RUNNING") model.pause = null; // work resumed
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
    case "failure": {
      const e = event as FailureEvent;
      task(e.task).note = e.reason;
      break;
    }
    case "blocked": {
      const e = event as BlockedEvent;
      task(e.task).note = `needs a human: ${e.question}`;
      break;
    }
    case "paused_ratelimit":
      model.pause = event as PausedEvent;
      break;
    case "run_end": {
      const e = event as RunEndEvent;
      model.endedTs = e.ts;
      model.stopped = e.stopped;
      model.pause = null;
      break;
    }
  }
}

/* ---------------------------------- render ---------------------------------- */

// Status roles (icon + label ALWAYS accompany color — color never carries alone).
const STATE_META: Record<TaskState, { icon: string; role: string }> = {
  QUEUED: { icon: "◷", role: "muted" },
  RUNNING: { icon: "▶", role: "active" },
  VERIFYING: { icon: "🔎", role: "active" },
  MERGE_QUEUED: { icon: "⇥", role: "active" },
  MERGING: { icon: "⇄", role: "active" },
  DONE: { icon: "✓", role: "good" },
  FAILED: { icon: "✕", role: "critical" },
  BLOCKED: { icon: "⚠", role: "warning" },
};

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

function runBadge(): HTMLElement {
  if (model.pause) {
    return el("span", "badge warning", `⏸ paused (rate limit #${model.pause.pause_n})`);
  }
  if (model.endedTs) {
    return el("span", `badge ${model.stopped ? "warning" : "good"}`,
      model.stopped ? "⏹ stopped" : "✓ finished");
  }
  return el("span", "badge active", "▶ live");
}

function render(): void {
  const root = document.getElementById("app")!;
  root.replaceChildren();

  // header
  const header = el("header", "header");
  const title = el("div", "run-title");
  title.append(el("h1", "", `run ${model.run || "…"}`), runBadge());
  header.append(title);
  header.append(el("div", "run-meta",
    `slots ${model.slots ?? "?"} · started ${model.startedTs ?? "…"}` +
    (model.endedTs ? ` · finished ${model.endedTs}` : "")));
  root.append(header);

  // stat tiles
  const counts = new Map<TaskState, number>();
  for (const t of model.tasks.values()) counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
  const tiles = el("section", "tiles");
  const tileOrder: Array<[string, TaskState[]]> = [
    ["done", ["DONE"]],
    ["running", ["RUNNING", "VERIFYING", "MERGING", "MERGE_QUEUED"]],
    ["queued", ["QUEUED"]],
    ["failed", ["FAILED"]],
    ["blocked", ["BLOCKED"]],
  ];
  for (const [label, states] of tileOrder) {
    const value = states.reduce((sum, s) => sum + (counts.get(s) ?? 0), 0);
    const tile = el("div", `tile ${label}`);
    tile.append(el("div", "tile-value", String(value)), el("div", "tile-label", label));
    tiles.append(tile);
  }
  root.append(tiles);

  // task cards
  const grid = el("section", "grid");
  for (const t of [...model.tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const meta = STATE_META[t.state];
    const card = el("article", `card ${meta.role}`);
    const head = el("div", "card-head");
    head.append(
      el("span", `chip ${meta.role}`, `${meta.icon} ${t.state}`),
      el("span", "card-id", t.id),
    );
    card.append(head);
    card.append(el("div", "card-title", t.title));
    const facts: string[] = [];
    if (t.turns !== null) facts.push(`${t.turns} turns`);
    if (t.wallS !== null) facts.push(fmtDuration(t.wallS));
    if (t.retries > 0) facts.push(`retry ${t.retries}`);
    if (facts.length) card.append(el("div", "card-facts", facts.join(" · ")));
    if (t.note) card.append(el("div", "card-note", t.note));
    const logBtn = el("button", "log-btn", "agent log") as HTMLButtonElement;
    logBtn.addEventListener("click", () => void showLog(t.id));
    card.append(logBtn);
    grid.append(card);
  }
  root.append(grid);

  // event feed (table view of the raw stream — the accessibility fallback)
  const feed = el("section", "feed");
  feed.append(el("h2", "", "events"));
  const list = el("div", "feed-list");
  for (const event of [...model.feed].reverse()) {
    const line = el("div", "feed-line");
    const time = event.ts?.slice(11, 19) ?? "";
    line.append(el("span", "feed-ts", time), el("span", "feed-body", describe(event)));
    list.append(line);
  }
  feed.append(list);
  root.append(feed);
}

function describe(event: FactoryEvent): string {
  const task = event.task ? `[${event.task}] ` : "";
  switch (event.event) {
    case "state": {
      const e = event as StateEvent;
      return `${task}${e.from} → ${e.to}`;
    }
    case "agent_result": {
      const e = event as AgentResultEvent;
      return `${task}agent ${e.status} (${e.turns ?? "?"} turns, ${fmtDuration(e.wall_s)})`;
    }
    case "verify": {
      const e = event as VerifyEvent;
      return `${task}verify ${e.ok ? "ok" : "FAILED: " + e.failures.join("; ")}`;
    }
    case "retry": {
      const e = event as RetryEvent;
      return `${task}retry #${e.attempt}: ${e.reason}`;
    }
    case "failure":
      return `${task}failed: ${(event as FailureEvent).reason}`;
    case "blocked":
      return `${task}blocked: ${(event as BlockedEvent).question}`;
    case "paused_ratelimit": {
      const e = event as PausedEvent;
      return `rate limit — global pause #${e.pause_n} (${fmtDuration(e.cooldown_s)})`;
    }
    case "merged":
      return `${task}merged into base`;
    case "run_start":
      return `run started (${(event as RunStartEvent).slots} slots)`;
    case "run_end": {
      const e = event as RunEndEvent;
      const counts = Object.entries(e.counts).map(([k, v]) => `${k}=${v}`).join(" ");
      return `run ${e.stopped ? "stopped" : "finished"}: ${counts}`;
    }
    default:
      return `${task}${event.event}`;
  }
}

async function showLog(taskId: string): Promise<void> {
  const overlay = el("div", "overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = el("div", "log-panel");
  panel.append(el("h3", "", `agent log — task ${taskId} (tail)`));
  const pre = el("pre", "log-pre", "loading…");
  panel.append(pre);
  overlay.append(panel);
  document.body.append(overlay);
  const res = await fetch(`/api/log?task=${encodeURIComponent(taskId)}`);
  pre.textContent = res.ok ? await res.text() : `(${res.status}) ${await res.text()}`;
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

const source = new EventSource("/api/events");
source.addEventListener("run", (e) => {
  const { run } = JSON.parse((e as MessageEvent).data) as { run: string };
  model = freshModel(run);
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

render();

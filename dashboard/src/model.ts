/** Pure state + formatting logic, shared by the React app. No DOM, no React. */

import type {
  AgentResultEvent,
  BlockedEvent,
  BudgetEvent,
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

export interface TaskModel {
  id: string;
  title: string;
  state: TaskState;
  turns: number | null;
  wallS: number | null;
  note: string;
  retries: number;
  runningSince: number | null;
  finishedAt: string | null;
  costUsd: number;
  tokens: number;
}

export interface Model {
  run: string;
  slots: number | null;
  startedTs: string | null;
  endedTs: string | null;
  stopped: boolean;
  ratePause: PausedEvent | null;
  manualPause: boolean;
  tasks: Map<string, TaskModel>;
  feed: FactoryEvent[];
  spentUsd: number;
  budgetUsd: number | null;
  budgetHit: boolean;
}

const FEED_LIMIT = 200;

export function freshModel(run: string): Model {
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
    spentUsd: 0,
    budgetUsd: null,
    budgetHit: false,
  };
}

function task(model: Model, id: string): TaskModel {
  let entry = model.tasks.get(id);
  if (!entry) {
    entry = {
      id, title: id, state: "QUEUED", turns: null, wallS: null, note: "",
      retries: 0, runningSince: null, finishedAt: null, costUsd: 0, tokens: 0,
    };
    model.tasks.set(id, entry);
  }
  return entry;
}

/** Fold one event into the model (mutates and returns it). */
export function reduce(model: Model, event: FactoryEvent): Model {
  model.feed.push(event);
  if (model.feed.length > FEED_LIMIT) model.feed.shift();

  switch (event.event) {
    case "run_start": {
      const e = event as RunStartEvent;
      model.slots = e.slots;
      model.startedTs = e.ts;
      model.budgetUsd = e.budget_usd ?? null;
      for (const t of e.tasks) {
        const id = typeof t === "string" ? t : t.id;
        const entry = task(model, id);
        if (typeof t !== "string") entry.title = t.title;
      }
      break;
    }
    case "state": {
      const e = event as StateEvent;
      const entry = task(model, e.task);
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
      const entry = task(model, e.task);
      entry.turns = e.turns;
      entry.wallS = e.wall_s;
      if (e.summary) entry.note = e.summary;
      entry.costUsd += e.cost_usd ?? 0;
      entry.tokens += (e.input_tokens ?? 0) + (e.output_tokens ?? 0);
      if (typeof e.spent_usd === "number") model.spentUsd = e.spent_usd;
      break;
    }
    case "verify": {
      const e = event as VerifyEvent;
      if (!e.ok) task(model, e.task).note = e.failures.join("; ");
      break;
    }
    case "retry": {
      const e = event as RetryEvent;
      const entry = task(model, e.task);
      entry.retries = e.attempt;
      entry.note = e.reason;
      break;
    }
    case "failure":
      task(model, (event as FailureEvent).task).note = (event as FailureEvent).reason;
      break;
    case "blocked":
      task(model, (event as BlockedEvent).task).note = (event as BlockedEvent).question;
      break;
    case "budget_exceeded":
      model.budgetHit = true;
      model.spentUsd = (event as BudgetEvent).spent_usd;
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
  return model;
}

/* ------------------------------ human language ------------------------------ */

export const ACTIVITY: Record<TaskState, string> = {
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

export const STATE_ICON: Record<TaskState, string> = {
  QUEUED: "◷", RUNNING: "●", VERIFYING: "🔎", REVIEWING: "⚖", MERGE_QUEUED: "✓",
  MERGING: "⇄", DONE: "✓", FAILED: "✕", BLOCKED: "✋",
};

export const IN_FLIGHT_STATES: TaskState[] =
  ["RUNNING", "VERIFYING", "REVIEWING", "MERGING", "MERGE_QUEUED"];
export function inFlight(state: TaskState | undefined): boolean {
  return state !== undefined && IN_FLIGHT_STATES.includes(state);
}

export function fmtDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 90) return `${m}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ago(ts: string): string {
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

export function fmtUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  return `$${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/* ------------------------------ agent log story ------------------------------ */

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

export type StoryItem =
  | { kind: "say" | "final" | "act" | "subresult"; text: string }
  | { kind: "delegate"; who: string; mission: string };

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

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
  if (Array.isArray(content)) return content.map((c) => c.text ?? "").join(" ").trim();
  return "";
}

/** Parse the raw stream-json into an ordered list of story items. */
export function narrate(raw: string): StoryItem[] {
  const story: StoryItem[] = [];
  const delegated = new Set<string>();
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
          story.push({ kind: "say", text: item.text.trim() });
        } else if (item.type === "tool_use" && item.name) {
          const input = item.input ?? {};
          if (SUBAGENT_TOOLS.has(item.name)) {
            if (item.id) delegated.add(item.id);
            story.push({
              kind: "delegate",
              who: (input["subagent_type"] as string) ?? "sub-agent",
              mission: clip((input["description"] as string) ?? (input["prompt"] as string) ?? "", 240),
            });
          } else {
            story.push({ kind: "act", text: `${item.name}  ${clip(toolDetail(input), 90)}` });
          }
        }
      }
    } else if (record.type === "user" && record.message?.content) {
      for (const item of record.message.content) {
        if (item.type === "tool_result" && item.tool_use_id && delegated.has(item.tool_use_id)) {
          const text = clip(toolResultText(item.content), 400);
          if (text) story.push({ kind: "subresult", text });
        }
      }
    } else if (record.type === "result" && record.result) {
      const last = story[story.length - 1];
      if (!last || (last.kind !== "final" && last.kind !== "say") ||
          ("text" in last && last.text.trim() !== record.result.trim())) {
        story.push({ kind: "final", text: record.result.trim() });
      }
    }
  }
  return story;
}

/* ------------------------------ settings <-> yaml ------------------------------ */

export interface Settings {
  slots: number;
  internet: boolean;
  project: "node" | "python" | "other";
  setupCommands: string;
  reviewer: boolean;
  reviewerModel: string;
  effort: string;
  maxRetries: number;
  budgetUsd: string;
}

export const EFFORT_CHOICES: Array<[string, string]> = [
  ["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"],
];

export function parseSettings(content: string): Settings {
  const section = (name: string): string => {
    const match = content.match(new RegExp(`^${name}:([\\s\\S]*?)(?=^[a-z]|$(?![\\s\\S]))`, "m"));
    return match?.[1] ?? "";
  };
  const setup = section("setup");
  const review = section("review");
  const setupCmds = [...setup.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((c) => !/^\d+$/.test(c));
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
    budgetUsd: content.match(/max_usd:\s*([\d.]+)/)?.[1] ?? "",
  };
}

export function generateConfig(s: Settings): string {
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
    ...(s.budgetUsd ? ["budget:", `  max_usd: ${s.budgetUsd}`, ""] : []),
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

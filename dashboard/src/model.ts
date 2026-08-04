/** Pure state + formatting logic, shared by the React app. No DOM, no React. */

import type {
  AgentProgressEvent,
  AgentResultEvent,
  BlockedContext,
  BlockedEvent,
  BudgetEvent,
  FactoryEvent,
  FailureEvent,
  PausedEvent,
  PlanLimitEvent,
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
  liveTurns: number;   // C6: current attempt's turn count while running (0 when idle)
  liveTokens: number;  // C6: current attempt's token estimate while running
  diff: { repo: string; from: string; to: string } | null;
  model: string | null;
  effort: string | null;
  prUrl: string | null;
  blockedContext: BlockedContext | null;  // git ground truth when BLOCKED (else null)
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
  integration: { running: boolean; results: Array<{ repo: string; ok: boolean; failures: string[] }> };
  sync: { ahead: number; behind: number; pulled: boolean } | null;
  mode: "subscription" | "api";
  planLimit: { status: string; resetsAt: number | null; window: string } | null;
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
    integration: { running: false, results: [] },
    sync: null,
    mode: "subscription",
    planLimit: null,
  };
}

function task(model: Model, id: string): TaskModel {
  let entry = model.tasks.get(id);
  if (!entry) {
    entry = {
      id, title: id, state: "QUEUED", turns: null, wallS: null, note: "",
      retries: 0, runningSince: null, finishedAt: null, costUsd: 0, tokens: 0,
      liveTurns: 0, liveTokens: 0, diff: null,
      model: null, effort: null, prUrl: null, blockedContext: null,
    };
    model.tasks.set(id, entry);
  }
  return entry;
}

export interface HistoryTicket {
  id: string;
  title: string;
  costUsd: number;
  tokens: number;
  finishedAt: string | null;
  diff: { repo: string; from: string; to: string } | null;
}

/** Seed the board with merged tickets from earlier runs so the work is
 *  cumulative. Applied before the live run's events, which overwrite any
 *  shared id — so a ticket being re-run shows its live state, not the stale one. */
export function seedHistory(model: Model, tickets: HistoryTicket[]): Model {
  for (const h of tickets) {
    const entry = task(model, h.id);
    entry.title = h.title;
    entry.state = "DONE";
    entry.costUsd = h.costUsd;
    entry.tokens = h.tokens;
    entry.finishedAt = h.finishedAt;
    entry.diff = h.diff;
  }
  return model;
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
      model.mode = e.mode === "api" ? "api" : "subscription";
      for (const t of e.tasks) {
        const id = typeof t === "string" ? t : t.id;
        const entry = task(model, id);
        if (typeof t !== "string") {
          entry.title = t.title;
          if (t.model) entry.model = t.model;
          if (t.effort) entry.effort = t.effort;
        }
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
        entry.blockedContext = null;  // fresh attempt: last block's facts are stale
        entry.liveTurns = 0; entry.liveTokens = 0;  // fresh attempt: reset live counters
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
      entry.liveTurns = 0; entry.liveTokens = 0;  // attempt done — authoritative totals folded in
      if (typeof e.spent_usd === "number") model.spentUsd = e.spent_usd;
      break;
    }
    case "agent_progress": {
      const e = event as AgentProgressEvent;
      const entry = task(model, e.task);
      entry.liveTurns = e.turns;
      entry.liveTokens = e.tokens;
      break;
    }
    case "plan_limit": {
      const e = event as PlanLimitEvent;
      model.planLimit = { status: e.status, resetsAt: e.resets_at ?? null, window: e.window };
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
    case "blocked": {
      const e = event as BlockedEvent;
      const entry = task(model, e.task);
      entry.note = e.question;
      entry.blockedContext = e.context ?? null;
      break;
    }
    case "merged": {
      const e = event as unknown as { task: string; repo?: string; base?: string; commit?: string };
      if (e.repo && e.base && e.commit) {
        task(model, e.task).diff = { repo: e.repo, from: e.base, to: e.commit };
      }
      break;
    }
    case "awaiting_approval": {
      // Same shape as `merged`: capture the diff range so "Revoir" can open it
      // even before (and after) the branch is merged/deleted.
      const e = event as unknown as { task: string; repo?: string; base?: string; commit?: string };
      if (e.repo && e.base && e.commit) {
        task(model, e.task).diff = { repo: e.repo, from: e.base, to: e.commit };
      }
      break;
    }
    case "pr_opened": {
      const e = event as unknown as { task: string; url?: string };
      task(model, e.task).prUrl = e.url || "";
      break;
    }
    case "sync": {
      const e = event as unknown as { ahead?: number; behind?: number; pulled?: boolean };
      model.sync = { ahead: e.ahead ?? 0, behind: e.behind ?? 0, pulled: Boolean(e.pulled) };
      break;
    }
    case "integration_start":
      model.integration.running = true;
      break;
    case "integration": {
      const e = event as unknown as { repo?: string; ok?: boolean; failures?: string[] };
      model.integration.running = false;
      model.integration.results.push({
        repo: e.repo ?? "", ok: Boolean(e.ok), failures: e.failures ?? [],
      });
      break;
    }
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
  AWAITING_APPROVAL: "Ready for your approval before it merges",
  MERGE_QUEUED: "Work approved — waiting to merge",
  MERGING: "Merging into your branch",
  DONE: "Merged",
  FAILED: "Failed",
  BLOCKED: "The agent has a question",
};

// Note: AWAITING_APPROVAL is deliberately NOT here — it needs a human, so the UI
// treats it like "needs you", not like busy work in flight.
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
  if (!Number.isFinite(s) || s < 0) return "just now";
  if (s < 45) return "just now";
  if (s < 90) return "a minute ago";
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  const m = s / 60;
  if (m < 60) return plural(Math.round(m), "min");
  const h = m / 60;
  if (h < 24) return plural(Math.round(h), "hour");
  const d = h / 24;
  if (d < 7) return plural(Math.round(d), "day");
  if (d < 30) return plural(Math.round(d / 7), "week");
  if (d < 365) return plural(Math.round(d / 30), "month");
  return plural(Math.round(d / 365), "year");
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

/* ------------------------------ unified diff parsing ------------------------------ */

export interface DiffLine { kind: "add" | "del" | "ctx" | "hunk"; text: string; n?: number }
export interface DiffFile { path: string; adds: number; dels: number; lines: DiffLine[] }
export interface ParsedDiff { preamble: string[]; files: DiffFile[] }

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)/;

/** Split a `git diff` into per-file groups with add/del tallies, so the UI can
 *  render each file as its own collapsible section. Anything before the first
 *  file (a commit header from `git show`) becomes `preamble`. */
export function parseDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  const preamble: string[] = [];
  let cur: DiffFile | null = null;
  let newLine = 0; // running line number on the new side of the current hunk
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/ b\/(.+)$/);
      cur = { path: m ? m[1]! : "?", adds: 0, dels: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) { if (raw.trim()) preamble.push(raw); continue; }
    if (raw.startsWith("+++")) {
      const m = raw.match(/^\+\+\+ b?\/?(.+)$/);
      if (m && m[1] && m[1] !== "/dev/null") cur.path = m[1];
      continue;
    }
    if (
      raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("new file") ||
      raw.startsWith("deleted file") || raw.startsWith("similarity ") ||
      raw.startsWith("rename ") || raw.startsWith("old mode") || raw.startsWith("new mode") ||
      raw.startsWith("Binary ")
    ) continue;
    if (raw.startsWith("@@")) {
      const hm = raw.match(HUNK);
      newLine = hm ? Number(hm[1]) : newLine;
      cur.lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) { cur.adds++; cur.lines.push({ kind: "add", text: raw.slice(1), n: newLine++ }); continue; }
    if (raw.startsWith("-")) { cur.dels++; cur.lines.push({ kind: "del", text: raw.slice(1) }); continue; }
    cur.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, n: newLine++ });
  }
  return { preamble, files };
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

/** Drop the run-worktree prefix (…\runs\<ts>\wt\<n>\) so a file path reads as the
 *  useful relative path (src/game/platforms.ts), not the unreadable absolute noise. */
function shortPath(p: string): string {
  return p.replace(/^.*[\\/]wt[\\/]\d+[\\/]/i, "").replace(/\\/g, "/") || p;
}

function toolDetail(input: Record<string, unknown>): string {
  const pick = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  const fp = pick("file_path") ?? pick("path");
  if (fp) return shortPath(fp);
  const cmd = pick("command");
  if (cmd) {
    // Agents run `cd "<worktree>" && <real command>`; show the real command, not
    // the boilerplate cd into an absolute path.
    const afterCd = cmd.replace(/^cd\s+"[^"]*"\s*&&\s*/i, "").trim();
    return afterCd || shortPath(cmd);
  }
  return pick("pattern") ?? pick("url") ?? pick("query") ?? pick("description") ?? pick("prompt") ?? "";
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
            story.push({ kind: "act", text: `${item.name}  ${clip(toolDetail(input), 120)}` });
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
  integrationCommands: string;
  reviewer: boolean;
  reviewerModel: string;
  planModel: string;
  model: string; // default model for the coding agents ("" = the CLI's own default)
  effort: string;
  maxRetries: number;
  budgetUsd: string;
  manualApproval: boolean;
  prNative: boolean;
  webhookUrl: string;
  executionMode: "subscription" | "api";
  isolation: "direct" | "sandbox"; // run agents as host subprocess vs hardened Docker box
  knowledge: boolean; // agent.mcp_config wired to the project knowledge base (ragmcp)
}

export const EFFORT_CHOICES: Array<[string, string]> = [
  ["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"],
];

/** Model tiers for the coding agents; "" = let the CLI pick its own default. */
export const MODEL_CHOICES: Array<[string, string]> = [
  ["", "Default (CLI's choice)"], ["haiku", "Haiku — fastest, cheapest"],
  ["sonnet", "Sonnet — balanced"], ["opus", "Opus — deepest, priciest"],
];

export function parseSettings(content: string): Settings {
  const section = (name: string): string => {
    const match = content.match(new RegExp(`^${name}:([\\s\\S]*?)(?=^[a-z]|$(?![\\s\\S]))`, "m"));
    return match?.[1] ?? "";
  };
  const setup = section("setup");
  const agent = section("agent");
  const integration = section("integration");
  const review = section("review");
  const plan = section("plan");
  const approval = section("approval");
  const prSec = section("pr");
  const notify = section("notify");
  const execution = section("execution");
  const cmds = (s: string): string =>
    [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((c) => !/^\d+$/.test(c)).join(", ");
  const setupCmds = cmds(setup);
  const hasNpm = /npm|npx|node/.test(content);
  const hasPy = /pytest|uv sync|ruff/.test(content);
  return {
    slots: Number(content.match(/max_slots:\s*(\d+)/)?.[1] ?? 3),
    internet: /WebSearch/.test(content),
    project: hasNpm ? "node" : hasPy ? "python" : "other",
    setupCommands: setupCmds,
    integrationCommands: cmds(integration),
    reviewer: /enabled:\s*true/.test(review),
    reviewerModel: review.match(/model:\s*"?(\w+)"?/)?.[1] ?? "haiku",
    planModel: plan.match(/model:\s*"?([\w-]+)"?/)?.[1] ?? "",
    model: agent.match(/model:\s*"?([\w.-]+)"?/)?.[1] ?? "",
    effort: content.match(/^\s*effort:\s*"?(\w+)"?/m)?.[1] ?? "",
    maxRetries: Number(content.match(/max_retries:\s*(\d+)/)?.[1] ?? 1),
    budgetUsd: content.match(/max_usd:\s*([\d.]+)/)?.[1] ?? "",
    manualApproval: /manual:\s*true/.test(approval),
    prNative: /enabled:\s*true/.test(prSec),
    webhookUrl: notify.match(/webhook:\s*"?([^"\n]+)"?/)?.[1]?.trim() ?? "",
    executionMode: /mode:\s*api/.test(execution) ? "api" : "subscription",
    isolation: /isolation:\s*sandbox/.test(execution) ? "sandbox" : "direct",
    knowledge: /mcp_config:/.test(agent),
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
  const integration = s.integrationCommands.split(",").map((c) => c.trim()).filter(Boolean);
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
    ...(s.manualApproval ? ["approval:", "  manual: true", ""] : []),
    ...(s.executionMode === "api" || s.isolation === "sandbox"
      ? [
          "execution:",
          ...(s.executionMode === "api" ? ["  mode: api"] : []),
          ...(s.isolation === "sandbox" ? ["  isolation: sandbox"] : []),
          "",
        ]
      : []),
    ...(s.prNative ? ["pr:", "  enabled: true", ""] : []),
    ...(s.webhookUrl.trim() ? ["notify:", `  webhook: "${s.webhookUrl.trim()}"`, ""] : []),
    ...(s.planModel ? ["plan:", `  model: ${s.planModel}`, ""] : []),
    "agent:",
    "  command: claude",
    "  permission_mode: acceptEdits",
    ...(s.knowledge ? ["  mcp_config: knowledge/mcp.json"] : []),
    ...(s.model ? [`  model: ${s.model}`] : []),
    ...(s.effort ? [`  effort: ${s.effort}`] : []),
    "  allowed_tools:",
    ...tools.map((t) => `    - ${t}`),
    "",
    "setup:",
    `  commands: [${setup.map((c) => `"${c}"`).join(", ")}]`,
    "  timeout_s: 600",
    "",
    ...(integration.length
      ? ["integration:", `  commands: [${integration.map((c) => `"${c}"`).join(", ")}]`, "  command_timeout_s: 1200", ""]
      : []),
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

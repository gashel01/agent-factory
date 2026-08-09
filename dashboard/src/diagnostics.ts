/** Failure diagnostics — the pure core that answers "why did this ticket fail?".
 *
 *  Deterministic and total by construction: no I/O, no clock, no randomness, no
 *  module-level mutable state. Same inputs always produce the same output, and
 *  `diagnose` never throws — the operator gets an honest "unknown" rather than a
 *  broken modal when the evidence is missing, truncated or pure garbage.
 *
 *  Evidence excerpts are VERBATIM slices of the input (only truncated, with a
 *  marker). Paraphrasing the agent's own words would let a wrong diagnosis look
 *  well-sourced, which is exactly the failure mode this module exists to avoid. */

import type { FactoryEvent } from "./types.js";

/* ============================ Public shapes ============================ */

export type DiagnosisCategory =
  | "verify_failed"
  | "agent_error"
  | "blocked"
  | "merge_conflict"
  | "timeout"
  | "rate_limit"
  | "budget"
  | "stopped"
  | "unknown";

export type TimelineTone = "neutral" | "good" | "warn" | "bad";

export interface TimelineStep {
  ts: string;
  label: string;
  tone: TimelineTone;
}

/** Where an excerpt was taken from, so the modal can label it honestly. */
export type EvidenceSource =
  | "verify"
  | "failure"
  | "retry"
  | "blocked"
  | "agent_result"
  | "agent_log"
  | "run";

export interface Evidence {
  source: EvidenceSource;
  excerpt: string;
}

/** The `op` values accepted by POST /api/control. */
export type ControlOp =
  | "pause"
  | "resume"
  | "stop"
  | "kill"
  | "retry"
  | "answer"
  | "approve"
  | "changes"
  | "undo";

export interface Recommendation {
  label: string;
  detail: string;
  op?: ControlOp;
  task?: string;
}

export interface Diagnosis {
  taskId: string;
  category: DiagnosisCategory;
  headline: string;
  detail: string;
  confidence: number;
  timeline: TimelineStep[];
  evidence: Evidence[];
  recommendations: Recommendation[];
}

export interface DiagnoseInput {
  taskId: string;
  events: FactoryEvent[];
  agentLog?: string;
}

export interface AgentToolUse {
  name: string;
  id: string;
  input: string; // short, ANSI-free preview of the tool input
}

export interface AgentLogResult {
  subtype: string;
  isError: boolean;
  text: string;
  turns: number | null;
  durationMs: number | null;
  costUsd: number | null;
}

export interface AgentLogView {
  records: unknown[];
  totalLines: number;
  parsedLines: number;
  skippedLines: number;
  assistantTurns: number;
  texts: string[];
  toolUses: AgentToolUse[];
  toolErrors: string[];
  result: AgentLogResult | null;
  tail: string[];
}

/* ============================ Small helpers ============================ */

const EXCERPT_MAX = 400;
const TRUNCATION_MARK = "… [truncated]";
const TAIL_LINES = 20;

/** Matches CSI/OSC escape sequences. Agent stdout is a terminal stream: colour
 *  codes would otherwise leak into evidence the operator reads. */
const ANSI_RE =
  /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function stripAnsi(s: string): string {
  if (typeof s !== "string" || s.length === 0) return "";
  return s.replace(ANSI_RE, "").replace(/[\u001B\u009B]/g, "");
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === "string") out.push(x);
  return out;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Verbatim slice, only ever shortened — never reworded. */
export function truncate(s: string, max = EXCERPT_MAX): string {
  if (typeof s !== "string") return "";
  return s.length <= max ? s : s.slice(0, max) + TRUNCATION_MARK;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const c = n < 0 ? 0 : n > 1 ? 1 : n;
  return Math.round(c * 100) / 100;
}

function matches(re: RegExp, ...parts: string[]): boolean {
  for (const p of parts) if (p && re.test(p)) return true;
  return false;
}

/* ============================ Agent log parsing ============================ */

/** Flatten a content block (string, {text}, {content}, or an array of those)
 *  into plain text. Stream-json shapes vary across versions; assume nothing. */
function blockText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(blockText).filter(Boolean).join("\n");
  const r = asRecord(v);
  if (typeof r.text === "string") return r.text;
  if (r.content !== undefined) return blockText(r.content);
  return "";
}

function previewInput(v: unknown): string {
  try {
    if (v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return truncate(stripAnsi(str(s)), 200);
  } catch {
    return "";
  }
}

/** Tolerant line-by-line parse of an agent stdout stream. Non-JSON noise (tool
 *  banners, stack traces, ANSI art) is skipped, never fatal. */
export function parseAgentLog(text: string): AgentLogView {
  const raw = typeof text === "string" ? text : "";
  const lines = raw.split(/\r?\n/);

  const records: unknown[] = [];
  const texts: string[] = [];
  const toolUses: AgentToolUse[] = [];
  const toolErrors: string[] = [];
  const tail: string[] = [];
  let totalLines = 0;
  let parsedLines = 0;
  let skippedLines = 0;
  let assistantTurns = 0;
  let result: AgentLogResult | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    totalLines++;
    tail.push(stripAnsi(line));
    if (tail.length > TAIL_LINES) tail.shift();

    const clean = stripAnsi(trimmed);
    if (!clean.startsWith("{") && !clean.startsWith("[")) {
      skippedLines++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      skippedLines++; // truncated or interleaved output — not our problem
      continue;
    }
    parsedLines++;
    records.push(parsed);

    const r = asRecord(parsed);
    const message = asRecord(r.message);
    const type = str(r.type);
    const role = str(r.role) || str(message.role);
    const content = message.content !== undefined ? message.content : r.content;

    if (type === "assistant" || role === "assistant") {
      assistantTurns++;
      for (const block of list(content)) {
        const b = asRecord(block);
        const bt = str(b.type);
        if (bt === "tool_use") {
          toolUses.push({ name: str(b.name), id: str(b.id), input: previewInput(b.input) });
        } else if (bt === "text" || typeof b.text === "string") {
          const t = stripAnsi(str(b.text));
          if (t.trim() !== "") texts.push(t);
        }
      }
      if (typeof content === "string") {
        const t = stripAnsi(content);
        if (t.trim() !== "") texts.push(t);
      }
      continue;
    }

    if (type === "user" || role === "user") {
      for (const block of list(content)) {
        const b = asRecord(block);
        if (str(b.type) === "tool_result" && b.is_error === true) {
          const t = stripAnsi(blockText(b.content));
          if (t.trim() !== "") toolErrors.push(t);
        }
      }
      continue;
    }

    if (type === "result") {
      result = {
        subtype: str(r.subtype),
        isError: r.is_error === true,
        text: stripAnsi(str(r.result) || blockText(r.content)),
        turns: num(r.num_turns),
        durationMs: num(r.duration_ms),
        costUsd: num(r.total_cost_usd),
      };
    }
  }

  return {
    records,
    totalLines,
    parsedLines,
    skippedLines,
    assistantTurns,
    texts,
    toolUses,
    toolErrors,
    result,
    tail,
  };
}

/* ============================ Event views ============================ */

const RUN_LEVEL_EVENTS = ["budget_exceeded", "paused_ratelimit", "plan_limit", "run_end"];

interface EventView {
  ts: string;
  event: string;
  task: string;
  r: Record<string, unknown>;
}

function viewOf(e: unknown): EventView {
  const r = asRecord(e);
  return { ts: str(r.ts), event: str(r.event), task: str(r.task), r };
}

function lastOf<T>(arr: T[]): T | null {
  return arr.length > 0 ? (arr[arr.length - 1] as T) : null;
}

/* ============================ Timeline ============================ */

function stateTone(to: string): TimelineTone {
  if (to === "DONE") return "good";
  if (to === "FAILED") return "bad";
  if (to === "BLOCKED" || to === "AWAITING_APPROVAL") return "warn";
  return "neutral";
}

function buildTimeline(views: EventView[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  for (const v of views) {
    const r = v.r;
    switch (v.event) {
      case "state": {
        const to = str(r.to);
        const from = str(r.from);
        steps.push({ ts: v.ts, label: `${from || "?"} → ${to || "?"}`, tone: stateTone(to) });
        break;
      }
      case "agent_result": {
        const status = str(r.status, "?");
        const turns = num(r.turns);
        const wall = num(r.wall_s);
        const bits: string[] = [];
        if (turns !== null) bits.push(`${turns} turns`);
        if (wall !== null) bits.push(`${Math.round(wall)}s`);
        const suffix = bits.length > 0 ? ` (${bits.join(", ")})` : "";
        steps.push({
          ts: v.ts,
          label: `Agent finished: ${status}${suffix}`,
          tone: isGoodStatus(status) ? "good" : "bad",
        });
        break;
      }
      case "verify": {
        const ok = r.ok === true;
        const n = strList(r.failures).length;
        steps.push({
          ts: v.ts,
          label: ok ? "Verification passed" : `Verification failed${n > 0 ? ` (${n} check${n > 1 ? "s" : ""})` : ""}`,
          tone: ok ? "good" : "bad",
        });
        break;
      }
      case "retry": {
        const attempt = num(r.attempt);
        const reason = oneLine(str(r.reason));
        steps.push({
          ts: v.ts,
          label: `Retry${attempt !== null ? ` #${attempt}` : ""}${reason ? `: ${truncate(reason, 80)}` : ""}`,
          tone: "warn",
        });
        break;
      }
      case "failure": {
        const reason = oneLine(str(r.reason));
        steps.push({ ts: v.ts, label: `Failed${reason ? `: ${truncate(reason, 80)}` : ""}`, tone: "bad" });
        break;
      }
      case "blocked": {
        const q = oneLine(str(r.question));
        steps.push({ ts: v.ts, label: `Blocked${q ? `: ${truncate(q, 80)}` : ""}`, tone: "warn" });
        break;
      }
      case "paused_ratelimit": {
        const cooldown = num(r.cooldown_s);
        steps.push({
          ts: v.ts,
          label: `Run paused for a rate limit${cooldown !== null ? ` (${Math.round(cooldown)}s cooldown)` : ""}`,
          tone: "warn",
        });
        break;
      }
      case "plan_limit": {
        steps.push({ ts: v.ts, label: `Plan limit: ${str(r.status, "?")} (${str(r.window, "?")})`, tone: "warn" });
        break;
      }
      case "budget_exceeded": {
        const spent = num(r.spent_usd);
        const budget = num(r.budget_usd);
        const amounts = spent !== null && budget !== null ? ` ($${spent.toFixed(2)} of $${budget.toFixed(2)})` : "";
        steps.push({ ts: v.ts, label: `Budget exceeded${amounts}`, tone: "bad" });
        break;
      }
      case "run_end": {
        const stopped = r.stopped === true;
        steps.push({ ts: v.ts, label: stopped ? "Run stopped by the operator" : "Run ended", tone: stopped ? "warn" : "neutral" });
        break;
      }
      default:
        break; // agent_progress and friends are noise in a post-mortem
    }
  }
  return steps;
}

function isGoodStatus(status: string): boolean {
  return /^(done|ok|success|completed|passed)$/i.test(status.trim());
}

/* ============================ Diagnosis ============================ */

const FLAKY_RE = /\b(timed? ?out|timeout|etimedout|econnreset|econnrefused|socket hang up|network|dns|flake|flaky|temporar|503|502|429)\b/i;
const TIMEOUT_RE = /\b(timed? ?out|timeout|deadline exceeded|max[_ ]?turns|turn limit|wall[- ]clock)\b/i;
const MERGE_RE = /\b(merge conflict|conflict|cannot merge|merge failed|rebase|non-fast-forward|unmerged)\b/i;
const STOPPED_RE = /\b(stopped|killed|kill|aborted|abort|cancell?ed|interrupted|sigterm|sigkill)\b/i;
const RATE_RE = /\b(rate[- ]?limit|usage limit|quota|429|overloaded)\b/i;

function pushEvidence(into: Evidence[], source: EvidenceSource, text: string): void {
  if (typeof text !== "string" || text.trim() === "") return;
  const excerpt = truncate(text);
  for (const e of into) if (e.source === source && e.excerpt === excerpt) return;
  into.push({ source, excerpt });
}

/** Evidence pulled from the agent's own log — the operator's last resort when
 *  the events say only "it failed". */
function agentLogEvidence(log: AgentLogView | null, into: Evidence[], limit = 3): void {
  if (!log) return;
  for (const err of log.toolErrors.slice(-limit)) pushEvidence(into, "agent_log", err);
  if (log.result && log.result.text.trim() !== "") pushEvidence(into, "agent_log", log.result.text);
  else {
    const lastText = lastOf(log.texts);
    if (lastText) pushEvidence(into, "agent_log", lastText);
  }
}

export function diagnose(input: DiagnoseInput): Diagnosis {
  try {
    return diagnoseInner(input);
  } catch {
    // Totality is the contract: a bug in here must still yield a usable card.
    const taskId = str(asRecord(input).taskId, "?");
    return {
      taskId,
      category: "unknown",
      headline: `Could not diagnose ${taskId || "this task"} — the evidence could not be read.`,
      detail:
        "The events and the agent log did not have a shape this diagnosis could read. Open the raw log for this task and judge it by hand.",
      confidence: 0,
      timeline: [],
      evidence: [],
      recommendations: unknownRecommendations(taskId),
    };
  }
}

function diagnoseInner(input: DiagnoseInput): Diagnosis {
  const inp = asRecord(input);
  const taskId = str(inp.taskId);
  const allEvents = list(inp.events);
  const agentLogText = str(inp.agentLog);
  const log = agentLogText.trim() === "" ? null : parseAgentLog(agentLogText);

  const views: EventView[] = [];
  const forTask: EventView[] = [];
  for (const e of allEvents) {
    const v = viewOf(e);
    const mine = taskId !== "" && v.task === taskId;
    const runLevel = v.task === "" && RUN_LEVEL_EVENTS.includes(v.event);
    if (mine) forTask.push(v);
    if (mine || runLevel) views.push(v);
  }

  const timeline = buildTimeline(views);

  const states = forTask.filter((v) => v.event === "state");
  const lastState = str(lastOf(states)?.r.to);
  const verifies = forTask.filter((v) => v.event === "verify");
  const lastVerify = lastOf(verifies);
  const failedVerifies = verifies.filter((v) => v.r.ok !== true);
  const failures = forTask.filter((v) => v.event === "failure");
  const lastFailure = lastOf(failures);
  const failureReason = str(lastFailure?.r.reason);
  const retries = forTask.filter((v) => v.event === "retry");
  const blocked = lastOf(forTask.filter((v) => v.event === "blocked"));
  const agentResults = forTask.filter((v) => v.event === "agent_result");
  const lastAgent = lastOf(agentResults);
  const agentStatus = str(lastAgent?.r.status);
  const agentSummary = str(lastAgent?.r.summary);
  const budget = lastOf(views.filter((v) => v.event === "budget_exceeded"));
  const paused = views.filter((v) => v.event === "paused_ratelimit");
  const planLimit = views.filter((v) => v.event === "plan_limit" && str(v.r.status) !== "allowed");
  const runEnd = lastOf(views.filter((v) => v.event === "run_end"));
  const runStopped = runEnd?.r.stopped === true;

  const logText = log ? [log.result?.text ?? "", ...log.toolErrors, ...log.texts.slice(-3)].join("\n") : "";
  const evidence: Evidence[] = [];

  /* --- No trace of this task at all --------------------------------- */
  if (forTask.length === 0) {
    const headline =
      taskId === ""
        ? "No task was named, so there is nothing to diagnose."
        : `No events were recorded for ${taskId}, so its outcome is unknown.`;
    const detail =
      "The run log holds no entry for this task: it may never have started, the run file may be truncated, or the id may not match. " +
      (log && log.parsedLines > 0
        ? "The agent log does hold output — read it directly, since the run events cannot corroborate it."
        : "There is no agent output either.");
    agentLogEvidence(log, evidence);
    return {
      taskId,
      category: "unknown",
      headline,
      detail,
      confidence: 0.1,
      timeline,
      evidence,
      recommendations: unknownRecommendations(taskId),
    };
  }

  /* --- The task actually succeeded ---------------------------------- */
  if (lastState === "DONE" && failures.length === 0 && !blocked && (!lastVerify || lastVerify.r.ok === true)) {
    return {
      taskId,
      category: "unknown",
      headline: `${taskId} finished successfully — there is no failure to explain.`,
      detail:
        "The task reached DONE with no failure event" +
        (verifies.length > 0 ? " and its verification passed" : "") +
        (retries.length > 0 ? `, after ${retries.length} retry attempt${retries.length > 1 ? "s" : ""}` : "") +
        ".",
      confidence: 0.5,
      timeline,
      evidence,
      recommendations: [
        {
          label: "Nothing to do",
          detail: "This task is done. If its result still looks wrong, the ticket's verification was too weak — tighten it and re-run.",
        },
      ],
    };
  }

  /* --- Rules, most specific first ------------------------------------ */

  // 1. Blocked: the agent itself told us why it stopped.
  if (blocked || lastState === "BLOCKED") {
    const question = str(blocked?.r.question);
    const ctx = asRecord(blocked?.r.context);
    const clean = ctx.clean === true;
    const commits = num(ctx.commits);
    pushEvidence(evidence, "blocked", question);
    for (const line of strList(ctx.status).slice(0, 5)) pushEvidence(evidence, "blocked", line);
    agentLogEvidence(log, evidence, 1);
    let confidence = 0.85;
    if (blocked && lastState === "BLOCKED") confidence += 0.1;
    if (/blocked/i.test(agentStatus)) confidence += 0.05;
    const gitNote =
      blocked && ctx.clean !== undefined
        ? ` When it stopped, its worktree was ${clean ? "clean" : "dirty"} with ${commits ?? 0} commit${commits === 1 ? "" : "s"}.`
        : "";
    return {
      taskId,
      category: "blocked",
      headline: `${taskId} is waiting on you — the agent asked a question it could not answer itself.`,
      detail:
        (question
          ? "The agent stopped and asked for a decision rather than guessing."
          : "The task moved to BLOCKED, but no question was recorded — the agent stopped without saying what it needed.") +
        gitNote +
        " Nothing is running for this task until you reply.",
      confidence: clamp01(confidence),
      timeline,
      evidence,
      recommendations: [
        {
          label: "Answer the question",
          detail: "Send the decision the agent is missing; it resumes from where it stopped instead of starting over.",
          op: "answer",
          task: taskId,
        },
        {
          label: "Check the git facts before you answer",
          detail:
            "The worktree status captured at the moment of the block is ground truth. An agent asking to undo work on a clean worktree with no commits is confused, not stuck.",
        },
        {
          label: "Drop the task and rewrite the ticket",
          detail: "If the question shows the ticket is under-specified, stopping it and rewriting the ticket beats negotiating with the agent.",
          op: "stop",
          task: taskId,
        },
      ],
    };
  }

  // 2. Merge conflict: it got as far as merging and lost there.
  const mergedFrom = states.some((v) => str(v.r.from) === "MERGING" || str(v.r.from) === "MERGE_QUEUED");
  if (matches(MERGE_RE, failureReason, agentSummary) || (mergedFrom && lastState === "FAILED")) {
    pushEvidence(evidence, "failure", failureReason);
    pushEvidence(evidence, "agent_result", agentSummary);
    agentLogEvidence(log, evidence, 1);
    let confidence = 0.7;
    if (matches(MERGE_RE, failureReason)) confidence += 0.15;
    if (mergedFrom) confidence += 0.1;
    return {
      taskId,
      category: "merge_conflict",
      headline: `${taskId} did its work but could not be merged back.`,
      detail:
        "The task reached the merge step and failed there, which points at a conflict with what landed before it rather than at the agent's code. " +
        "The branch still holds the work — only the merge needs a human.",
      confidence: clamp01(confidence),
      timeline,
      evidence,
      recommendations: [
        {
          label: "Resolve the conflict by hand",
          detail: "Check out the task branch, merge the base branch into it and settle the overlapping edits yourself.",
        },
        {
          label: "Retry the merge",
          detail: "If the conflicting task has since been fixed or dropped, a retry replays the merge from a clean base.",
          op: "retry",
          task: taskId,
        },
        {
          label: "Undo the last merge",
          detail: "If the branch that landed first is the wrong one, undo it and let this task merge instead.",
          op: "undo",
          task: taskId,
        },
      ],
    };
  }

  // 3. Explicitly stopped or killed.
  if (matches(STOPPED_RE, failureReason, agentStatus)) {
    pushEvidence(evidence, "failure", failureReason);
    pushEvidence(evidence, "agent_result", agentSummary);
    let confidence = 0.75;
    if (runStopped) confidence += 0.15;
    return {
      taskId,
      category: "stopped",
      headline: `${taskId} was stopped before it could finish.`,
      detail:
        "The task ended because it was stopped or killed, not because the work failed on its own. Whatever it had done is on its branch, unverified.",
      confidence: clamp01(confidence),
      timeline,
      evidence,
      recommendations: stoppedRecommendations(taskId),
    };
  }

  // 4. Ran out of time or turns.
  const logTimeout = log?.result?.subtype === "error_max_turns";
  if (matches(TIMEOUT_RE, failureReason, agentStatus, agentSummary) || logTimeout) {
    const stillRunning = lastState === "RUNNING" || lastState === "VERIFYING";
    pushEvidence(evidence, "failure", failureReason);
    pushEvidence(evidence, "agent_result", agentSummary);
    agentLogEvidence(log, evidence, 1);
    let confidence = 0.7;
    if (logTimeout) confidence += 0.15;
    if (matches(TIMEOUT_RE, failureReason)) confidence += 0.1;
    const turns = num(lastAgent?.r.turns) ?? log?.result?.turns;
    const recs: Recommendation[] = [];
    if (stillRunning) {
      recs.push({
        label: "Kill the agent",
        detail: "It is still burning turns with no sign of converging. Killing it frees the slot for the rest of the queue.",
        op: "kill",
        task: taskId,
      });
    }
    recs.push(
      {
        label: "Split the ticket",
        detail: "Hitting the turn or time ceiling almost always means the ticket asks for more than one agent can hold. Two smaller tickets beat one retry.",
      },
      {
        label: "Retry as is",
        detail: "Worth one shot if the agent was clearly close when it ran out — otherwise it will run out again.",
        op: "retry",
        task: taskId,
      },
    );
    return {
      taskId,
      category: "timeout",
      headline: `${taskId} ran out of time or turns before it finished.`,
      detail:
        `The agent hit its ceiling${turns ? ` after ${turns} turns` : ""} rather than reporting a result. ` +
        "That is a sizing problem: the ticket is too broad, or the agent was looping over the same ground.",
      confidence: clamp01(confidence),
      timeline,
      evidence,
      recommendations: recs,
    };
  }

  // 5. Budget: a run-level ceiling that explains a task ending early.
  if (budget) {
    const spent = num(budget.r.spent_usd);
    const cap = num(budget.r.budget_usd);
    pushEvidence(
      evidence,
      "run",
      `budget_exceeded: spent_usd=${spent ?? "?"} budget_usd=${cap ?? "?"}`,
    );
    pushEvidence(evidence, "failure", failureReason);
    return {
      taskId,
      category: "budget",
      headline: `${taskId} stopped because the run hit its spending cap.`,
      detail:
        `The run spent ${spent !== null ? `$${spent.toFixed(2)}` : "its budget"}` +
        (cap !== null ? ` against a $${cap.toFixed(2)} cap` : "") +
        ", so the factory stopped handing out work. This says nothing about whether the task itself was on track.",
      confidence: clamp01(0.8 + (failures.length > 0 ? 0.1 : 0)),
      timeline,
      evidence,
      recommendations: [
        {
          label: "Raise the cap, then resume",
          detail: "Set a higher budget in factory.yaml and resume the run; queued tasks pick up where they stopped.",
          op: "resume",
          task: taskId,
        },
        {
          label: "Stop the run and re-plan",
          detail: "If the spend surprised you, stop here and cut the backlog down before spending more.",
          op: "stop",
        },
        {
          label: "Retry this ticket alone",
          detail: "Running the one ticket you care about is cheaper than resuming the whole queue.",
          op: "retry",
          task: taskId,
        },
      ],
    };
  }

  // 6. Rate limit: the provider, not the code.
  if ((paused.length > 0 || planLimit.length > 0 || matches(RATE_RE, failureReason, logText)) && lastState !== "DONE") {
    const lastPlan = lastOf(planLimit);
    pushEvidence(evidence, "failure", failureReason);
    if (lastPlan) pushEvidence(evidence, "run", `plan_limit: status=${str(lastPlan.r.status, "?")} window=${str(lastPlan.r.window, "?")}`);
    agentLogEvidence(log, evidence, 1);
    let confidence = 0.6;
    if (paused.length > 0) confidence += 0.15;
    if (planLimit.length > 0) confidence += 0.1;
    if (matches(RATE_RE, failureReason)) confidence += 0.1;
    return {
      taskId,
      category: "rate_limit",
      headline: `${taskId} was held up by a provider rate limit.`,
      detail:
        `The run hit a usage limit${paused.length > 0 ? ` and paused ${paused.length} time${paused.length > 1 ? "s" : ""} waiting for it to clear` : ""}. ` +
        "Nothing is wrong with the ticket — the work simply could not proceed while the window was closed.",
      confidence: clamp01(confidence),
      timeline,
      evidence,
      recommendations: [
        {
          label: "Resume once the window resets",
          detail: "The limit clears on its own. Resuming after the reset costs nothing and keeps the queue moving.",
          op: "resume",
          task: taskId,
        },
        {
          label: "Retry this ticket",
          detail: "If only this task was cut short, replaying it alone is the fastest way back to a clean board.",
          op: "retry",
          task: taskId,
        },
        {
          label: "Cut the parallelism",
          detail: "Fewer slots in factory.yaml means fewer concurrent calls and fewer pauses on the next run.",
        },
      ],
    };
  }

  // 7. Verification failed: the sharpest evidence there is.
  if (lastVerify && lastVerify.r.ok !== true) {
    const fails = strList(lastVerify.r.failures);
    for (const f of fails.slice(0, 5)) pushEvidence(evidence, "verify", f);
    pushEvidence(evidence, "failure", failureReason);
    for (const rv of retries.slice(-2)) pushEvidence(evidence, "retry", str(rv.r.reason));
    agentLogEvidence(log, evidence, 1);
    const flaky = fails.some((f) => FLAKY_RE.test(f)) || FLAKY_RE.test(failureReason);
    const repeated = failedVerifies.length > 1;
    let confidence = 0.85;
    if (fails.length > 0) confidence += 0.1;
    if (repeated) confidence += 0.05;
    const recs: Recommendation[] = [];
    if (flaky && !repeated) {
      recs.push({
        label: "Retry the ticket",
        detail: "The failing check reads as transient (a timeout or a network hiccup), so a fresh run is the cheapest thing to try first.",
        op: "retry",
        task: taskId,
      });
    }
    recs.push({
      label: "Run the failing check yourself",
      detail: `Reproduce it outside the factory: ${fails.length > 0 ? truncate(oneLine(fails[0] ?? ""), 120) : "the command recorded in the ticket"}.`,
    });
    if (repeated) {
      recs.push({
        label: "Fix the ticket, not the run",
        detail: `The same verification failed ${failedVerifies.length} times. Another retry will fail the same way — the ticket or the check itself is wrong.`,
      });
    }
    if (!flaky || repeated) {
      recs.push({
        label: "Retry the ticket",
        detail: "Worth a shot once you have changed the ticket or the check; on its own it replays the same failure.",
        op: "retry",
        task: taskId,
      });
    }
    return {
      taskId,
      category: "verify_failed",
      headline: `${taskId} produced work, but its verification did not pass.`,
      detail:
        `${fails.length > 0 ? `${fails.length} check${fails.length > 1 ? "s" : ""} failed` : "The verification step failed"}` +
        (repeated ? `, and this is failure number ${failedVerifies.length} for this task` : "") +
        ". The agent finished and the code is on its branch — it is the ticket's own success criteria that rejected it.",
      confidence: clamp01(confidence),
      timeline,
      evidence,
      recommendations: recs,
    };
  }

  // 8. The agent itself reported an error.
  const agentFailed = (lastAgent !== null && agentStatus !== "" && !isGoodStatus(agentStatus)) || log?.result?.isError === true;
  if (agentFailed || failures.length > 0) {
    pushEvidence(evidence, "failure", failureReason);
    pushEvidence(evidence, "agent_result", agentSummary);
    agentLogEvidence(log, evidence);
    let confidence = 0.6;
    if (agentFailed) confidence += 0.15;
    if (failures.length > 0) confidence += 0.1;
    if (log && log.toolErrors.length > 0) confidence += 0.05;
    return {
      taskId,
      category: "agent_error",
      headline: `${taskId} stopped on an error from the agent itself.`,
      detail:
        `The agent ended with status "${agentStatus || "error"}"` +
        (log && log.toolErrors.length > 0 ? ` after ${log.toolErrors.length} failing tool call${log.toolErrors.length > 1 ? "s" : ""}` : "") +
        ". It never reached a verifiable result, so there is nothing to check — read what it said before it gave up.",
      confidence: clamp01(confidence),
      timeline,
      evidence,
      recommendations: [
        {
          label: "Read the agent's last turns",
          detail: "The error text says whether it was a missing tool, a bad path or a genuine dead end. That decides whether a retry can work at all.",
        },
        {
          label: "Retry the ticket",
          detail: "Agent errors are often one-off. A retry starts from a clean worktree and costs one slot.",
          op: "retry",
          task: taskId,
        },
        {
          label: "Tighten the ticket",
          detail: "If the agent flailed for lack of context, name the files in scope and the exact commands before running it again.",
        },
      ],
    };
  }

  // 9. The whole run was stopped under it.
  if (runStopped && lastState !== "DONE") {
    pushEvidence(evidence, "run", "run_end: stopped=true");
    return {
      taskId,
      category: "stopped",
      headline: `${taskId} never finished — the run was stopped around it.`,
      detail:
        `The run ended on an operator stop while this task was ${lastState || "still in flight"}. Its work, if any, is on its branch and unverified.`,
      confidence: 0.7,
      timeline,
      evidence,
      recommendations: stoppedRecommendations(taskId),
    };
  }

  /* --- Nothing conclusive -------------------------------------------- */
  agentLogEvidence(log, evidence);
  pushEvidence(evidence, "failure", failureReason);
  return {
    taskId,
    category: "unknown",
    headline: `${taskId} did not finish, and the log does not say why.`,
    detail:
      `The last thing recorded for this task was ${lastState ? `the state ${lastState}` : "no state change at all"}, with no failure, ` +
      "no verification result and no agent error to explain it. Either the run was interrupted mid-flight or the events are truncated.",
    confidence: 0.2,
    timeline,
    evidence,
    recommendations: unknownRecommendations(taskId),
  };
}

function stoppedRecommendations(taskId: string): Recommendation[] {
  return [
    {
      label: "Resume the run",
      detail: "If the stop was a pause for something unrelated, resuming picks the queue back up without losing the finished work.",
      op: "resume",
      task: taskId,
    },
    {
      label: "Retry this ticket",
      detail: "The task has no verified result, so replaying it from a clean worktree is the honest way to get one.",
      op: "retry",
      task: taskId,
    },
    {
      label: "Check why it was stopped",
      detail: "A stop is a human decision. Make sure the reason for it is gone before you start the same work again.",
    },
  ];
}

function unknownRecommendations(taskId: string): Recommendation[] {
  return [
    {
      label: "Open the agent log",
      detail: "The events carry no explanation for this task. The raw agent output is the only remaining source of truth.",
    },
    {
      label: "Retry the ticket",
      detail: "With no evidence of a real defect, a clean re-run is the cheapest way to find out whether the failure repeats.",
      op: "retry",
      task: taskId,
    },
  ];
}

/* ============================ Summary line ============================ */

const CATEGORY_LABEL: Array<[DiagnosisCategory, string]> = [
  ["verify_failed", "Verification failed"],
  ["agent_error", "Agent error"],
  ["blocked", "Blocked"],
  ["merge_conflict", "Merge conflict"],
  ["timeout", "Out of time"],
  ["rate_limit", "Rate limited"],
  ["budget", "Budget exceeded"],
  ["stopped", "Stopped"],
  ["unknown", "Unclear"],
];

export function categoryLabel(category: DiagnosisCategory): string {
  for (const [key, label] of CATEGORY_LABEL) if (key === category) return label;
  return "Unclear";
}

/** One line, safe as a card subtitle or a notification body. */
export function summarize(d: Diagnosis): string {
  const dd = asRecord(d);
  const category = str(dd.category, "unknown") as DiagnosisCategory;
  const headline = oneLine(str(dd.headline));
  const confidence = num(dd.confidence);
  const pct = confidence === null ? "" : ` · ${Math.round(clamp01(confidence) * 100)}% sure`;
  const first = list(dd.recommendations)[0];
  const next = oneLine(str(asRecord(first).label));
  return truncate(
    `${categoryLabel(category)}: ${headline || "no diagnosis available"}${next ? ` → ${next}` : ""}${pct}`,
    240,
  );
}

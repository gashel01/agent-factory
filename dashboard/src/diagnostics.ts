/** Failure analysis: turn a run's events + an agent's raw stdout log into a
 *  human-readable diagnosis (root cause, timeline, evidence, next actions).
 *
 *  This module is deliberately PURE — no fs, no http, no node imports. It takes
 *  already-read data and returns plain objects, so it is unit-testable
 *  (`server.ts` calls main() at import time and can never be imported by a test).
 *  Every function is total: corrupt, empty or unknown input yields a well-formed
 *  `Diagnosis` with category "unknown" rather than a throw. */

/* ------------------------------- public types ------------------------------- */

export interface AgentLogEntry {
  kind: "assistant" | "tool_use" | "tool_result" | "result" | "other";
  ts?: string;
  tool?: string;
  text?: string;
  isError?: boolean;
  raw: unknown;
}

export type FailureCategory =
  | "verify-failed"
  | "no-diff"
  | "timeout"
  | "max-turns"
  | "rate-limit"
  | "budget"
  | "merge-conflict"
  | "tool-denied"
  | "blocked"
  | "agent-error"
  | "unknown";

export interface TimelineStep {
  ts: string;
  label: string;
  kind: "state" | "verify" | "retry" | "failure" | "tool" | "result";
  detail?: string;
  /** Seconds since the task's first event, so the UI can draw a real timeline. */
  elapsedS?: number;
}

export interface Evidence {
  source: "events" | "agent-log";
  label: string;
  /** A VERBATIM slice of the input — never a paraphrase. Capped at 600 chars. */
  excerpt: string;
}

export type RecommendationAction =
  | "retry"
  | "retry-after-edit"
  | "kill-and-replan"
  | "switch-model"
  | "raise-budget"
  | "answer-question";

export interface Recommendation {
  action: RecommendationAction;
  label: string;
  rationale: string;
  /** The exact /api/control op the UI can post. Omitted when the fix is a human
   *  one (edit the ticket, change the model in settings). */
  control?: { op: string; task?: string };
}

export interface Diagnosis {
  taskId: string;
  category: FailureCategory;
  headline: string;
  detail: string;
  /** 0..1 — how strongly the evidence pins the category. */
  confidence: number;
  timeline: TimelineStep[];
  evidence: Evidence[];
  recommendations: Recommendation[];
}

/* --------------------------------- helpers --------------------------------- */

const EXCERPT_MAX = 600;

/** Hard-cut (no ellipsis) so an excerpt stays a literal substring of the input. */
function excerpt(text: string): string {
  return text.trim().slice(0, EXCERPT_MAX);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown> | null | undefined, key: string): string | undefined {
  if (!source) return undefined;
  const v = source[key];
  return typeof v === "string" ? v : undefined;
}

function num(source: Record<string, unknown> | null | undefined, key: string): number | undefined {
  if (!source) return undefined;
  const v = source[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strings(source: Record<string, unknown> | null | undefined, key: string): string[] {
  if (!source) return [];
  const v = source[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function epoch(ts: string | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** The first raw line of `text` matching `re`, for evidence taken straight from
 *  the log rather than rebuilt from the parsed record. */
function findLine(text: string, re: RegExp): string | undefined {
  for (const line of text.split("\n")) {
    if (re.test(line)) return line;
  }
  return undefined;
}

/* ------------------------------ log parsing ------------------------------ */

interface ContentItem {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  content?: unknown;
  is_error?: unknown;
}

/** tool_result content is either a string or a list of {type,text} blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => str(asRecord(c), "text") ?? "")
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Tolerant JSONL parse of the agent CLI's streamed stdout. Blank lines, torn
 * lines and plain-text noise (the runner also writes `[stderr] …` lines into the
 * same file) are skipped, never thrown on. One transport line can carry several
 * meaningful entries (a turn's narration plus its tool calls), so the output is
 * flattened in stream order.
 */
export function parseAgentLog(text: string): AgentLogEntry[] {
  const entries: AgentLogEntry[] = [];
  if (typeof text !== "string" || text.length === 0) return entries;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // torn line, `[stderr] …` prefix, or plain garbage
    }
    const record = asRecord(parsed);
    if (!record) continue;

    // The CLI does not always stamp records; keep whatever it gives us.
    const ts = str(record, "timestamp") ?? str(record, "ts");
    const type = str(record, "type");
    const message = asRecord(record["message"]);
    const content = message?.["content"];
    const items: ContentItem[] = Array.isArray(content)
      ? content.filter((c): c is ContentItem => asRecord(c) !== null)
      : [];

    if (type === "assistant") {
      for (const item of items) {
        const itemRecord = asRecord(item);
        const itemType = str(itemRecord, "type");
        if (itemType === "text") {
          const body = str(itemRecord, "text") ?? "";
          if (body.trim()) entries.push({ kind: "assistant", ...(ts ? { ts } : {}), text: body, raw: item });
        } else if (itemType === "tool_use") {
          const tool = str(itemRecord, "name") ?? "";
          entries.push({
            kind: "tool_use",
            ...(ts ? { ts } : {}),
            ...(tool ? { tool } : {}),
            raw: item,
          });
        }
      }
      continue;
    }

    if (type === "user") {
      for (const item of items) {
        const itemRecord = asRecord(item);
        if (str(itemRecord, "type") !== "tool_result") continue;
        entries.push({
          kind: "tool_result",
          ...(ts ? { ts } : {}),
          text: contentText(itemRecord?.["content"]),
          isError: itemRecord?.["is_error"] === true,
          raw: item,
        });
      }
      continue;
    }

    if (type === "result") {
      // On error_max_turns the CLI carries no `result` string; the subtype IS the
      // fact worth keeping, and it is still verbatim input.
      const body = str(record, "result") ?? str(record, "subtype") ?? "";
      entries.push({
        kind: "result",
        ...(ts ? { ts } : {}),
        text: body,
        isError: record["is_error"] === true || str(record, "subtype")?.startsWith("error") === true,
        raw: record,
      });
      continue;
    }

    entries.push({ kind: "other", ...(ts ? { ts } : {}), raw: record });
  }
  return entries;
}

/* --------------------------------- context --------------------------------- */

/** Events that carry no `task` but still explain a task's fate (the dispatcher
 *  emits them run-wide). */
const RUN_WIDE = new Set(["paused_ratelimit", "budget_exceeded"]);

interface Context {
  taskId: string;
  /** This task's events plus the run-wide ones that happened during its life. */
  events: Array<Record<string, unknown>>;
  /** retry + failure reasons, in order. */
  reasons: Array<{ event: string; reason: string }>;
  verifyFailures: string[];
  log: string;
  entries: AgentLogEntry[];
}

function buildContext(
  taskId: string,
  raw: ReadonlyArray<Record<string, unknown>>,
  agentLog: string,
): Context {
  const all = Array.isArray(raw) ? raw.filter((e): e is Record<string, unknown> => asRecord(e) !== null) : [];
  const mine = all.filter((e) => str(e, "task") === taskId);
  const firstTs = epoch(str(mine[0] ?? {}, "ts"));

  const events = all.filter((e) => {
    if (str(e, "task") === taskId) return true;
    if (e["task"] !== undefined) return false;
    if (!RUN_WIDE.has(str(e, "event") ?? "")) return false;
    // Only run-wide events inside this task's window bear on it.
    const t = epoch(str(e, "ts"));
    return firstTs === null || t === null || t >= firstTs;
  });

  const reasons: Array<{ event: string; reason: string }> = [];
  const verifyFailures: string[] = [];
  for (const e of events) {
    const name = str(e, "event");
    if (name === "retry" || name === "failure") {
      const reason = str(e, "reason");
      if (reason) reasons.push({ event: name, reason });
    } else if (name === "verify" && e["ok"] !== true) {
      verifyFailures.push(...strings(e, "failures"));
    }
  }

  return {
    taskId,
    events,
    reasons,
    verifyFailures,
    log: agentLog,
    entries: parseAgentLog(agentLog),
  };
}

/* --------------------------------- timeline -------------------------------- */

function stepFor(event: Record<string, unknown>): Omit<TimelineStep, "ts" | "elapsedS"> | null {
  const name = str(event, "event");
  switch (name) {
    case "state": {
      const from = str(event, "from") ?? "?";
      const to = str(event, "to") ?? "?";
      return { kind: "state", label: `${from} → ${to}` };
    }
    case "verify": {
      const ok = event["ok"] === true;
      const failures = strings(event, "failures");
      return {
        kind: "verify",
        label: ok ? "verify passed" : "verify failed",
        ...(failures.length ? { detail: failures.join("; ").slice(0, EXCERPT_MAX) } : {}),
      };
    }
    case "retry": {
      const attempt = num(event, "attempt");
      return {
        kind: "retry",
        label: attempt === undefined ? "retry" : `retry (attempt ${attempt})`,
        ...(str(event, "reason") ? { detail: (str(event, "reason") ?? "").slice(0, EXCERPT_MAX) } : {}),
      };
    }
    case "failure":
      return {
        kind: "failure",
        label: "failed",
        ...(str(event, "reason") ? { detail: (str(event, "reason") ?? "").slice(0, EXCERPT_MAX) } : {}),
      };
    case "blocked":
      return {
        kind: "failure",
        label: "blocked on a question",
        ...(str(event, "question") ? { detail: (str(event, "question") ?? "").slice(0, EXCERPT_MAX) } : {}),
      };
    case "agent_result": {
      const status = str(event, "status") ?? "?";
      const turns = num(event, "turns");
      const wall = num(event, "wall_s");
      const bits = [
        turns === undefined ? "" : `${turns} turns`,
        wall === undefined ? "" : `${Math.round(wall)}s`,
        str(event, "summary") ?? "",
      ].filter(Boolean);
      return {
        kind: "result",
        label: `agent ${status}`,
        ...(bits.length ? { detail: bits.join(" · ").slice(0, EXCERPT_MAX) } : {}),
      };
    }
    case "paused_ratelimit": {
      const cooldown = num(event, "cooldown_s");
      return {
        kind: "failure",
        label: "run paused on a rate limit",
        ...(cooldown === undefined ? {} : { detail: `cooldown ${Math.round(cooldown)}s` }),
      };
    }
    case "budget_exceeded": {
      const spent = num(event, "spent_usd");
      const cap = num(event, "budget_usd");
      return {
        kind: "failure",
        label: "budget exceeded",
        ...(spent === undefined || cap === undefined ? {} : { detail: `$${spent} spent of $${cap}` }),
      };
    }
    case "noop":
      return { kind: "result", label: "no-op (already implemented)" };
    default:
      return null;
  }
}

/** Tool activity worth putting on the timeline: only the failures, and only when
 *  the CLI stamped the record (otherwise there is no honest place to put it). */
function logSteps(entries: AgentLogEntry[]): Array<{ ts: string; step: Omit<TimelineStep, "ts" | "elapsedS"> }> {
  const out: Array<{ ts: string; step: Omit<TimelineStep, "ts" | "elapsedS"> }> = [];
  for (const entry of entries) {
    if (!entry.ts) continue;
    if (entry.kind === "tool_result" && entry.isError) {
      out.push({
        ts: entry.ts,
        step: {
          kind: "tool",
          label: "tool call failed",
          ...(entry.text ? { detail: entry.text.trim().slice(0, EXCERPT_MAX) } : {}),
        },
      });
    } else if (entry.kind === "result" && entry.isError) {
      out.push({
        ts: entry.ts,
        step: {
          kind: "result",
          label: "agent CLI ended with an error",
          ...(entry.text ? { detail: entry.text.trim().slice(0, EXCERPT_MAX) } : {}),
        },
      });
    }
  }
  return out;
}

function buildTimeline(ctx: Context): TimelineStep[] {
  const rows: Array<{ ts: string; step: Omit<TimelineStep, "ts" | "elapsedS"> }> = [];
  for (const event of ctx.events) {
    const step = stepFor(event);
    const ts = str(event, "ts");
    if (step && ts) rows.push({ ts, step });
  }
  rows.push(...logSteps(ctx.entries));

  // Stable chronological sort: an unparsable ts inherits the last known instant
  // so it keeps its insertion position instead of being flung to one end.
  let carry = Number.NEGATIVE_INFINITY;
  const keyed = rows.map((row, index) => {
    const t = epoch(row.ts);
    if (t !== null) carry = t;
    return { row, index, key: carry };
  });
  keyed.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key));

  const first = keyed.length ? epoch(keyed[0]?.row.ts) : null;
  return keyed.map(({ row }) => {
    const t = epoch(row.ts);
    const elapsed = first !== null && t !== null ? Math.round(((t - first) / 1000) * 1000) / 1000 : undefined;
    return {
      ts: row.ts,
      ...row.step,
      ...(elapsed === undefined ? {} : { elapsedS: elapsed }),
    };
  });
}

/* ------------------------------ classification ------------------------------ */

const RE = {
  rateLimit: /rate.?limit|usage limit|overloaded|too many requests|\b429\b/i,
  timeout: /timed out after|agent timeout:|killed after \d+ min budget/i,
  // Log side stays strict: a bare "max_turns" appears in any repo that configures
  // one (this one does), so only the CLI's own verdict counts as evidence.
  maxTurnsLog: /error_max_turns/,
  maxTurnsReason: /error_max_turns|max(imum)? turns|reached the maximum number of turns/i,
  mergeConflict: /rebase conflict|merge failed|merge refused|push failed|gh pr create failed/i,
  noCommits: /no commits on the task branch/i,
  emptyDiff: /commits present but the diff is empty/i,
  verifyFailed: /^verify failed: |^post-rebase verify failed: |^review rejected: /i,
  cmdFailed: /`[^`]+` exited -?\d+:/,
  agentError: /^agent (error|timeout):/i,
  denied: /permission|was blocked|denied|not allowed|requires approval|requested permissions/i,
} as const;

/** Drop the dispatcher's "retries exhausted (N): " wrapper so the inner reason
 *  can be matched and de-duplicated across attempts. */
function coreReason(reason: string): string {
  return reason.replace(/^retries exhausted \(\d+\): /, "").trim();
}

/** Signature of a failure, comparable across the `verify` and `retry`/`failure`
 *  events that describe the SAME wall from two angles. */
function signature(text: string): string {
  return coreReason(text)
    .replace(/^(verify failed|post-rebase verify failed|review rejected|agent (error|timeout)): /i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How many ATTEMPTS came back with the same failure. Repetition is the signal
 * that a bare retry is pointless — the agent will walk into the same wall.
 *
 * Occurrences are bucketed per attempt, because one attempt emits its failure
 * twice (a `verify` record and the `retry`/`failure` reason built from it);
 * counting raw occurrences would call a first-time failure a repeat. The final
 * "retries exhausted (N): …" failure is a recap of the last attempt, not a new
 * one, so it is skipped.
 */
function repeatCount(ctx: Context): number {
  const seen = new Map<string, number>();
  const perAttempt = new Set<string>();
  let attempt = 0;
  let worst = 0;

  const bump = (raw: string): void => {
    const sig = signature(raw);
    if (!sig) return;
    const scoped = `${attempt}|${sig}`;
    if (perAttempt.has(scoped)) return; // same attempt, second wording of it
    perAttempt.add(scoped);
    const n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    if (n > worst) worst = n;
  };

  for (const event of ctx.events) {
    const name = str(event, "event");
    if (name === "verify" && event["ok"] !== true) {
      for (const f of strings(event, "failures")) bump(f);
    } else if (name === "retry") {
      const reason = str(event, "reason");
      if (reason) bump(reason);
      attempt = num(event, "attempt") ?? attempt + 1;
    } else if (name === "failure") {
      const reason = str(event, "reason") ?? "";
      if (reason && !/^retries exhausted \(\d+\): /.test(reason)) bump(reason);
    }
  }
  return worst;
}

interface Classification {
  category: FailureCategory;
  headline: string;
  detail: string;
  confidence: number;
  evidence: Evidence[];
}

function fromEvents(label: string, text: string): Evidence {
  return { source: "events", label, excerpt: excerpt(text) };
}

function fromLog(label: string, text: string): Evidence {
  return { source: "agent-log", label, excerpt: excerpt(text) };
}

function classify(ctx: Context): Classification {
  const reasons = ctx.reasons;
  const lastReason = reasons.length ? reasons[reasons.length - 1] : undefined;
  const reasonText = reasons.map((r) => r.reason).join("\n");
  const verify = ctx.verifyFailures;

  // 1. The agent stopped and asked a question — a human answer unblocks it.
  const blocked = [...ctx.events].reverse().find((e) => str(e, "event") === "blocked");
  if (blocked) {
    const question = str(blocked, "question") ?? "";
    const context = asRecord(blocked["context"]);
    const commits = num(context, "commits");
    return {
      category: "blocked",
      headline: "The agent blocked on a question",
      detail: question
        ? `It stopped and asked: “${question.slice(0, 240)}”.` +
          (commits === undefined ? "" : ` Its worktree held ${commits} commit(s) at that moment.`)
        : "It stopped and asked the operator a question.",
      confidence: 0.95,
      evidence: [fromEvents("blocked question", question || "blocked")],
    };
  }

  // 2. Provider limits, stated by the reason itself.
  if (lastReason && RE.rateLimit.test(reasonText)) {
    return {
      category: "rate-limit",
      headline: "The provider rate/usage limit was hit",
      detail: "The attempt was abandoned because the provider refused more work, not because the code was wrong.",
      confidence: 0.9,
      evidence: [fromEvents(`${lastReason.event} reason`, lastReason.reason)],
    };
  }

  // 3. Wall-clock budget: the agent was killed mid-flight, or a verify command
  //    ran past its timeout.
  const verifyTimeout = verify.find((f) => /timed out after/i.test(f));
  if (RE.timeout.test(reasonText) || verifyTimeout) {
    const source = verifyTimeout
      ? fromEvents("verify failure", verifyTimeout)
      : fromEvents(`${lastReason?.event ?? "failure"} reason`, lastReason?.reason ?? "");
    return {
      category: "timeout",
      headline: verifyTimeout ? "A success-criteria command timed out" : "The agent ran out of wall-clock budget",
      detail: verifyTimeout
        ? "The verify gate killed a command that never finished, so the ticket can never go green as written."
        : "The attempt was killed on its timeout budget before it could finish and commit.",
      confidence: 0.85,
      evidence: [source],
    };
  }

  // 4. Merge queue: the branch no longer applies on top of the base.
  if (lastReason && RE.mergeConflict.test(lastReason.reason)) {
    return {
      category: "merge-conflict",
      headline: "The branch conflicts with the base",
      detail: "The work is committed but cannot land: rebasing it onto the base branch hit a conflict.",
      confidence: 0.9,
      evidence: [fromEvents(`${lastReason.event} reason`, lastReason.reason)],
    };
  }

  // 5. Turn budget. The CLI reports this in the log (`error_max_turns`) long
  //    before the dispatcher sees it — downstream the task merely looks like it
  //    committed nothing, so this must be checked BEFORE the no-diff branch.
  const maxTurnsLine = findLine(ctx.log, RE.maxTurnsLog);
  if (maxTurnsLine || RE.maxTurnsReason.test(reasonText)) {
    return {
      category: "max-turns",
      headline: "The agent exhausted its turn budget",
      detail: "It was cut off mid-task, so whatever it had left to do never landed.",
      confidence: maxTurnsLine ? 0.9 : 0.6,
      evidence: [
        maxTurnsLine
          ? fromLog("agent CLI result record", maxTurnsLine)
          : fromEvents(`${lastReason?.event ?? "failure"} reason`, lastReason?.reason ?? ""),
      ],
    };
  }

  // 6. The gate's two "you produced nothing" verdicts.
  const noDiff = verify.find((f) => RE.noCommits.test(f) || RE.emptyDiff.test(f));
  if (noDiff || RE.noCommits.test(reasonText) || RE.emptyDiff.test(reasonText)) {
    const excerptSource = noDiff
      ? fromEvents("verify failure", noDiff)
      : fromEvents(`${lastReason?.event ?? "failure"} reason`, lastReason?.reason ?? "");
    const agentResult = [...ctx.events].reverse().find((e) => str(e, "event") === "agent_result");
    const claimed = str(agentResult, "status") === "done";
    const evidence = [excerptSource];
    if (claimed) {
      const summary = str(agentResult, "summary");
      if (summary) evidence.push(fromEvents("agent's own summary", summary));
    }
    return {
      category: "no-diff",
      headline: claimed
        ? "The agent claimed success without committing anything"
        : "Nothing was committed on the task branch",
      detail:
        "The verify gate found no reviewable change on the branch — work that is not committed does not exist.",
      confidence: 0.9,
      evidence,
    };
  }

  // 7. A success-criteria command came back non-zero.
  const cmdFailure = verify.find((f) => RE.cmdFailed.test(f));
  if (cmdFailure || verify.length || RE.verifyFailed.test(coreReason(lastReason?.reason ?? ""))) {
    const source = cmdFailure ?? verify[0];
    return {
      category: "verify-failed",
      headline: "The success-criteria commands did not pass",
      detail: source
        ? `The gate rejected the work: ${source.slice(0, 200)}`
        : "The gate rejected the work before it could be merged.",
      confidence: 0.9,
      evidence: [
        source
          ? fromEvents("verify failure", source)
          : fromEvents(`${lastReason?.event ?? "failure"} reason`, lastReason?.reason ?? ""),
      ],
    };
  }

  // 8. Tooling the agent was not allowed to use — only meaningful once the
  //    louder causes above are ruled out.
  const deniedEntry = ctx.entries.find(
    (e) => e.kind === "tool_result" && e.isError === true && RE.denied.test(e.text ?? ""),
  );
  if (deniedEntry?.text) {
    return {
      category: "tool-denied",
      headline: "A tool call the agent needed was denied",
      detail: "The permission layer refused an operation, so the agent could not complete the ticket as written.",
      confidence: 0.7,
      evidence: [fromLog("denied tool result", deniedEntry.text)],
    };
  }

  // 9. Run-wide stops with no task-level reason attached.
  const budget = [...ctx.events].reverse().find((e) => str(e, "event") === "budget_exceeded");
  if (budget) {
    const spent = num(budget, "spent_usd");
    const cap = num(budget, "budget_usd");
    return {
      category: "budget",
      headline: "The run hit its spend cap",
      detail: `The dispatcher stopped scheduling work${
        spent === undefined || cap === undefined ? "" : ` after spending $${spent} of a $${cap} budget`
      }; this task never got to finish.`,
      confidence: 0.9,
      evidence: [
        fromEvents(
          "budget_exceeded",
          `spent_usd=${spent ?? "?"} budget_usd=${cap ?? "?"}`,
        ),
      ],
    };
  }

  const paused = [...ctx.events].reverse().find((e) => str(e, "event") === "paused_ratelimit");
  if (paused) {
    const cooldown = num(paused, "cooldown_s");
    const pauseN = num(paused, "pause_n");
    return {
      category: "rate-limit",
      headline: "The run is paused on a provider rate limit",
      detail: `The task did nothing wrong — it was requeued while the run waits out${
        cooldown === undefined ? " the cooldown" : ` a ${Math.round(cooldown)}s cooldown`
      }.`,
      confidence: 0.85,
      evidence: [
        fromEvents("paused_ratelimit", `pause_n=${pauseN ?? "?"} cooldown_s=${cooldown ?? "?"}`),
      ],
    };
  }

  // 10. The agent process itself failed (crash, non-zero exit, no result record).
  if (lastReason && RE.agentError.test(coreReason(lastReason.reason))) {
    return {
      category: "agent-error",
      headline: "The agent process failed",
      detail: "The CLI exited without producing a usable result, so no work was proven.",
      confidence: 0.75,
      evidence: [fromEvents(`${lastReason.event} reason`, lastReason.reason)],
    };
  }
  if (lastReason) {
    return {
      category: "agent-error",
      headline: "The task failed",
      detail: "The dispatcher recorded a failure that matches no known signature; read the reason below.",
      confidence: 0.4,
      evidence: [fromEvents(`${lastReason.event} reason`, lastReason.reason)],
    };
  }

  return {
    category: "unknown",
    headline: "No failure could be identified",
    detail: "Nothing in the run's events or the agent's log explains a failure for this task.",
    confidence: 0,
    evidence: [],
  };
}

/* ----------------------------- recommendations ----------------------------- */

function recommend(ctx: Context, category: FailureCategory): Recommendation[] {
  const task = ctx.taskId;
  const repeats = repeatCount(ctx);
  const retry: Recommendation = {
    action: "retry",
    label: "Retry the task",
    rationale: "The failure looks transient — a fresh attempt on the same ticket may well land.",
    control: { op: "retry", task },
  };
  const editThenRetry: Recommendation = {
    action: "retry-after-edit",
    label: "Fix the ticket, then retry",
    rationale:
      repeats >= 2
        ? `The same failure came back ${repeats} times — retrying unchanged will reproduce it. Tighten the ticket (or the success criteria) first.`
        : "Give the next attempt something the last one lacked: sharper acceptance criteria or the missing context.",
  };
  const replan: Recommendation = {
    action: "kill-and-replan",
    label: "Kill it and re-plan the work",
    rationale: "The ticket as scoped is not converging; split it or re-plan it rather than paying for another attempt.",
    control: { op: "kill", task },
  };
  const switchModel: Recommendation = {
    action: "switch-model",
    label: "Run it on a stronger model",
    rationale: "A more capable model needs fewer turns for the same ticket, which is exactly what ran out here.",
  };
  const raiseBudget: Recommendation = {
    action: "raise-budget",
    label: "Raise the budget for this ticket",
    rationale: "The work was cut short by a limit, not by being wrong — give it more room and re-run.",
  };

  switch (category) {
    case "blocked":
      return [
        {
          action: "answer-question",
          label: "Answer the agent's question",
          rationale: "The agent is waiting on a decision only you can make; answering grants it a fresh attempt.",
          control: { op: "answer", task },
        },
        replan,
      ];

    case "rate-limit":
      // Never a task-level retry: re-running now just burns into the same wall.
      return [
        {
          action: "retry",
          label: "Wait out the cooldown, then resume the run",
          rationale: "The task did nothing wrong. Resume once the provider window reopens; the task is already requeued.",
          control: { op: "resume" },
        },
        switchModel,
      ];

    case "budget":
      return [
        raiseBudget,
        {
          action: "switch-model",
          label: "Run the remaining work on a cheaper model",
          rationale: "If the cap is the real constraint, lowering per-task cost gets more tickets through it.",
        },
      ];

    case "max-turns":
      return [switchModel, raiseBudget, replan];

    case "timeout":
      return [raiseBudget, retry, replan];

    case "no-diff":
      return repeats >= 2
        ? [replan, editThenRetry]
        : [
            {
              ...editThenRetry,
              rationale:
                "The agent reported success without committing. Restate the ticket so the deliverable is an explicit commit, then retry.",
            },
            retry,
          ];

    case "verify-failed":
      return repeats >= 2 ? [editThenRetry, replan] : [retry, editThenRetry];

    case "merge-conflict":
      return [
        {
          ...retry,
          label: "Retry the task (it rebases onto the current base)",
          rationale: "A retry re-runs the work on top of what has landed since, which is what the conflict asks for.",
        },
        replan,
      ];

    case "tool-denied":
      return [
        {
          ...editThenRetry,
          label: "Widen the permission or restate the ticket, then retry",
          rationale: "The agent needed an operation it is not allowed to perform; retrying unchanged hits the same denial.",
        },
        replan,
      ];

    case "agent-error":
      return repeats >= 2 ? [editThenRetry, replan] : [retry, replan];

    case "unknown":
      return [];
  }
}

/* --------------------------------- diagnose -------------------------------- */

export function diagnose(input: {
  taskId: string;
  events: ReadonlyArray<Record<string, unknown>>;
  agentLog?: string;
}): Diagnosis {
  const taskId = typeof input?.taskId === "string" ? input.taskId : "";
  const events = Array.isArray(input?.events) ? input.events : [];
  const agentLog = typeof input?.agentLog === "string" ? input.agentLog : "";
  const ctx = buildContext(taskId, events, agentLog);

  const timeline = buildTimeline(ctx);
  const verdict = classify(ctx);
  // A diagnosis with no verbatim backing is a guess; refuse to make a claim.
  const category: FailureCategory = verdict.evidence.length ? verdict.category : "unknown";
  const grounded =
    category === "unknown" && verdict.category !== "unknown"
      ? {
          headline: "No failure could be identified",
          detail: "Nothing in the run's events or the agent's log explains a failure for this task.",
          confidence: 0,
        }
      : { headline: verdict.headline, detail: verdict.detail, confidence: verdict.confidence };

  return {
    taskId,
    category,
    headline: grounded.headline,
    detail: grounded.detail,
    confidence: Math.min(1, Math.max(0, grounded.confidence)),
    timeline,
    evidence: verdict.evidence,
    recommendations: recommend(ctx, category),
  };
}

/* -------------------------------- summarize -------------------------------- */

/** A 1–3 sentence recap, plain enough to drop into a notification. */
export function summarize(d: Diagnosis): string {
  if (!d) return "no diagnosis available.";
  const task = d.taskId || "the task";
  if (d.category === "unknown") {
    return `${task}: no failure could be identified from the available events and log.`;
  }
  const confidence = `${Math.round(d.confidence * 100)}% confidence`;
  const first = d.recommendations[0];
  const next = first ? ` Next: ${first.label.toLowerCase()}.` : "";
  return `${task}: ${d.headline} (${d.category}, ${confidence}). ${d.detail}${next}`;
}

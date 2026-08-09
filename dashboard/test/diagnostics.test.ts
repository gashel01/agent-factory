import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentLog, diagnose, summarize } from "../src/diagnostics.js";
import type { Diagnosis } from "../src/diagnostics.js";

/* ------------------------------- fixtures ------------------------------- */

const T = (n: number): string => new Date(Date.UTC(2026, 7, 9, 3, 0, n)).toISOString();

type Ev = Record<string, unknown>;

const runStart = (): Ev => ({ ts: T(0), event: "run_start", run: "r", slots: 2, tasks: ["007"] });
const state = (n: number, from: string, to: string, task = "007"): Ev => ({
  ts: T(n), event: "state", task, from, to,
});
const verifyKo = (n: number, failures: string[], task = "007"): Ev => ({
  ts: T(n), event: "verify", task, ok: false, failures,
});
const retry = (n: number, attempt: number, reason: string, task = "007"): Ev => ({
  ts: T(n), event: "retry", task, attempt, reason,
});
const failure = (n: number, reason: string, task = "007"): Ev => ({
  ts: T(n), event: "failure", task, reason,
});
const agentResult = (n: number, status: string, summary: string, task = "007"): Ev => ({
  ts: T(n), event: "agent_result", task, status, turns: 42, wall_s: 610.5, summary, cost_usd: 1.25,
});

/** Every diagnosis must be backed by verbatim input — assert that literally. */
function assertGrounded(d: Diagnosis, haystack: string): void {
  assert.ok(d.evidence.length >= 1, "expected at least one evidence excerpt");
  for (const e of d.evidence) {
    assert.ok(e.excerpt.length > 0, "empty excerpt");
    assert.ok(e.excerpt.length <= 600, "excerpt exceeds the 600-char cap");
  }
  const first = d.evidence[0];
  assert.ok(first);
  assert.ok(haystack.includes(first.excerpt), `excerpt not found verbatim in the input: ${first.excerpt}`);
}

function assertOrdered(d: Diagnosis): void {
  const times = d.timeline.map((s) => Date.parse(s.ts));
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1];
    const cur = times[i];
    assert.ok(prev !== undefined && cur !== undefined);
    assert.ok(cur >= prev, `timeline out of order at index ${i}`);
  }
  const first = d.timeline[0];
  if (first) assert.equal(first.elapsedS, 0);
}

/* ------------------------------ parseAgentLog ----------------------------- */

test("parseAgentLog: flattens turns, tool calls and the final result", () => {
  const log = [
    '{"type":"system","subtype":"init","session_id":"s1"}',
    '{"type":"assistant","timestamp":"' + T(3) + '","message":{"content":[{"type":"text","text":"Reading the tests."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"pytest -q"}}]}}',
    '{"type":"user","timestamp":"' + T(4) + '","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"2 failed"}]}}',
    '{"type":"result","subtype":"success","total_cost_usd":0.42,"result":"done","usage":{"input_tokens":10}}',
  ].join("\n");
  const entries = parseAgentLog(log);
  assert.deepEqual(entries.map((e) => e.kind), ["other", "assistant", "tool_use", "tool_result", "result"]);
  assert.equal(entries[2]?.tool, "Bash");
  assert.equal(entries[3]?.isError, true);
  assert.equal(entries[3]?.text, "2 failed");
  assert.equal(entries[4]?.text, "done");
  assert.equal(entries[1]?.ts, T(3));
});

test("parseAgentLog: tolerates blank lines, torn JSON and stderr noise", () => {
  const log = [
    "",
    "   ",
    "[stderr] something went sideways",
    '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}',  // torn: no closing brace
    "not json at all",
    "[1,2,3]", // valid JSON, not a record
    '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
  ].join("\n");
  const entries = parseAgentLog(log);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "assistant");
  assert.equal(parseAgentLog("").length, 0);
});

/* -------------------------------- diagnose -------------------------------- */

test("diagnose: a failing success-criteria command is verify-failed", () => {
  const fail = "`pytest -q` exited 1: E   assert 1 == 2 | 1 failed, 12 passed";
  const events: Ev[] = [
    runStart(),
    state(1, "QUEUED", "RUNNING"),
    agentResult(9, "done", "implemented the parser"),
    state(10, "RUNNING", "VERIFYING"),
    verifyKo(11, [fail]),
    failure(12, `retries exhausted (2): verify failed: ${fail}`),
    state(13, "VERIFYING", "FAILED"),
  ];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "verify-failed");
  assertGrounded(d, JSON.stringify(events));
  assertOrdered(d);
  assert.ok(d.confidence > 0.5);
  assert.ok(d.timeline.some((s) => s.kind === "verify"));
  assert.ok(summarize(d).includes("007"));
});

test("diagnose: no commits on the task branch is no-diff and names the false claim", () => {
  const events: Ev[] = [
    runStart(),
    state(1, "QUEUED", "RUNNING"),
    agentResult(8, "done", "already implemented, nothing to change"),
    verifyKo(9, ["no commits on the task branch"]),
    failure(10, "verify failed: no commits on the task branch"),
  ];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "no-diff");
  assert.match(d.headline, /without committing/);
  assertGrounded(d, JSON.stringify(events));
  assert.equal(d.evidence[0]?.excerpt, "no commits on the task branch");
  assert.equal(d.recommendations[0]?.action, "retry-after-edit");
});

test("diagnose: a verify command that timed out is a timeout", () => {
  const fail = "`npm --prefix dashboard test` timed out after 900s";
  const events: Ev[] = [runStart(), verifyKo(5, [fail]), failure(6, `verify failed: ${fail}`)];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "timeout");
  assertGrounded(d, JSON.stringify(events));
  assert.equal(d.recommendations[0]?.action, "raise-budget");
});

test("diagnose: an agent killed on its wall-clock budget is a timeout", () => {
  const events: Ev[] = [
    runStart(),
    agentResult(5, "timeout", "killed after 30 min budget"),
    failure(6, "agent timeout: killed after 30 min budget"),
  ];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "timeout");
  assert.match(d.detail, /timeout budget/);
});

test("diagnose: error_max_turns in the log outranks the no-diff symptom", () => {
  const events: Ev[] = [
    runStart(),
    state(1, "QUEUED", "RUNNING"),
    verifyKo(20, ["no commits on the task branch"]),
    failure(21, "verify failed: no commits on the task branch"),
  ];
  const agentLog = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
    '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":50,"total_cost_usd":3.1}',
  ].join("\n");
  const d = diagnose({ taskId: "007", events, agentLog });
  assert.equal(d.category, "max-turns");
  assertGrounded(d, agentLog);
  assert.equal(d.evidence[0]?.source, "agent-log");
  assert.deepEqual(d.recommendations.map((r) => r.action), ["switch-model", "raise-budget", "kill-and-replan"]);
});

test("diagnose: a rate-limit pause recommends resuming, never a task retry", () => {
  const events: Ev[] = [
    runStart(),
    state(1, "QUEUED", "RUNNING"),
    { ts: T(30), event: "paused_ratelimit", pause_n: 2, cooldown_s: 1200 },
    state(31, "RUNNING", "QUEUED"),
  ];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "rate-limit");
  assert.ok(d.evidence.length >= 1);
  assert.equal(d.recommendations[0]?.control?.op, "resume");
  assert.ok(
    !d.recommendations.some((r) => r.control?.op === "retry"),
    "a rate-limited task must not be offered a bare retry",
  );
  assertOrdered(d);
});

test("diagnose: budget_exceeded is attributed to the run's spend cap", () => {
  const events: Ev[] = [
    runStart(),
    state(1, "QUEUED", "RUNNING"),
    { ts: T(40), event: "budget_exceeded", spent_usd: 52.5, budget_usd: 50 },
  ];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "budget");
  assert.ok(d.evidence.length >= 1);
  assert.equal(d.recommendations[0]?.action, "raise-budget");
  assert.match(summarize(d), /budget/);
});

test("diagnose: a blocked question asks the operator to answer", () => {
  const question = "Should the diagnostics module own the fs glue, or does ticket 004?";
  const events: Ev[] = [
    runStart(),
    state(1, "QUEUED", "RUNNING"),
    {
      ts: T(15), event: "blocked", task: "007", question,
      context: { clean: true, commits: 0, status: [], diffstat: [] },
    },
    state(16, "RUNNING", "BLOCKED"),
  ];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "blocked");
  assertGrounded(d, JSON.stringify(events));
  assert.equal(d.evidence[0]?.excerpt, question);
  assert.match(d.detail, /0 commit/);
  assert.equal(d.recommendations[0]?.action, "answer-question");
  assert.deepEqual(d.recommendations[0]?.control, { op: "answer", task: "007" });
});

test("diagnose: the same verify failure twice escalates past a bare retry", () => {
  const fail = "`npm --prefix dashboard run typecheck` exited 2: src/app.tsx(12,3): error TS2322";
  const events: Ev[] = [
    runStart(),
    state(1, "QUEUED", "RUNNING"),
    verifyKo(10, [fail]),
    retry(11, 1, `verify failed: ${fail}`),
    state(12, "VERIFYING", "QUEUED"),
    verifyKo(20, [fail]),
    retry(21, 2, `verify failed: ${fail}`),
    failure(30, `retries exhausted (2): verify failed: ${fail}`),
  ];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "verify-failed");
  const first = d.recommendations[0];
  assert.ok(first);
  assert.notEqual(first.action, "retry");
  assert.equal(first.action, "retry-after-edit");
  assert.match(first.rationale, /came back 2 times/);
  assert.ok(d.recommendations.some((r) => r.action === "kill-and-replan"));
  assertOrdered(d);
});

test("diagnose: a denied tool call is surfaced once louder causes are ruled out", () => {
  const denial = "ls in 'C:\\\\elsewhere' was blocked. For security, Claude Code may only list files in the allowed working directories";
  const events: Ev[] = [
    runStart(),
    failure(9, "agent error: agent exited 1 without a result"),
  ];
  const agentLog = [
    '{"type":"assistant","timestamp":"' + T(5) + '","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}',
    '{"type":"user","timestamp":"' + T(6) + '","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"' + denial + '"}]}}',
  ].join("\n");
  const d = diagnose({ taskId: "007", events, agentLog });
  assert.equal(d.category, "tool-denied");
  assert.equal(d.evidence[0]?.source, "agent-log");
  assert.ok(d.timeline.some((s) => s.kind === "tool"), "the failed tool call belongs on the timeline");
  assertOrdered(d);
});

test("diagnose: a rebase conflict is a merge-conflict", () => {
  const events: Ev[] = [
    runStart(),
    state(1, "MERGE_QUEUED", "MERGING"),
    failure(5, "rebase conflict: CONFLICT (content): Merge conflict in dashboard/src/app.tsx"),
  ];
  const d = diagnose({ taskId: "007", events });
  assert.equal(d.category, "merge-conflict");
  assert.equal(d.recommendations[0]?.control?.op, "retry");
});

test("diagnose: empty, unknown-task and corrupt inputs stay well-formed and unknown", () => {
  for (const d of [
    diagnose({ taskId: "007", events: [] }),
    diagnose({ taskId: "nope", events: [runStart(), failure(3, "verify failed: boom")] }),
    diagnose({ taskId: "007", events: [], agentLog: "\u0000not json\n{oops" }),
  ]) {
    assert.equal(d.category, "unknown");
    assert.deepEqual(d.recommendations, []);
    assert.deepEqual(d.evidence, []);
    assert.deepEqual(d.timeline, []);
    assert.equal(d.confidence, 0);
    assert.ok(d.headline.length > 0);
    assert.match(summarize(d), /no failure could be identified/);
  }
});

test("diagnose: survives junk event records without throwing", () => {
  const events = [null, 42, "nope", { event: "state" }, { ts: T(1), event: "failure", task: "007" }] as unknown as Ev[];
  const d = diagnose({ taskId: "007", events });
  assert.equal(typeof d.headline, "string");
  assert.ok(["unknown", "agent-error"].includes(d.category));
});

test("diagnose: timeline carries elapsed seconds relative to the task's first event", () => {
  const events: Ev[] = [
    runStart(),
    state(1, "QUEUED", "RUNNING"),
    agentResult(61, "done", "did the thing"),
    verifyKo(62, ["no commits on the task branch"]),
  ];
  const d = diagnose({ taskId: "007", events });
  assertOrdered(d);
  const last = d.timeline[d.timeline.length - 1];
  assert.equal(last?.elapsedS, 61);
  assert.ok(d.timeline.some((s) => s.kind === "state" && s.label === "QUEUED → RUNNING"));
  assert.ok(d.timeline.some((s) => s.kind === "result" && s.label === "agent done"));
});

/* -------------------------------- summarize ------------------------------- */

test("summarize: 1-3 sentences naming the task, the cause and the next move", () => {
  const events: Ev[] = [
    runStart(),
    verifyKo(5, ["`pytest -q` exited 1: 3 failed"]),
    failure(6, "verify failed: `pytest -q` exited 1: 3 failed"),
  ];
  const line = summarize(diagnose({ taskId: "007", events }));
  assert.ok(line.startsWith("007:"));
  assert.ok(line.includes("verify-failed"));
  const sentences = line.split(/(?<=\.)\s+/).filter(Boolean);
  assert.ok(sentences.length >= 1 && sentences.length <= 3, `got ${sentences.length} sentences: ${line}`);
});

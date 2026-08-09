import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentLog,
  diagnose,
  summarize,
  stripAnsi,
  truncate,
  categoryLabel,
} from "../src/diagnostics.js";
import type { Diagnosis, DiagnoseInput } from "../src/diagnostics.js";
import type { FactoryEvent } from "../src/types.js";

/* ---------------------------------------------------------------- helpers */

const ESC = String.fromCharCode(27);

function ev(o: Record<string, unknown>): FactoryEvent {
  return o as unknown as FactoryEvent;
}

function run(events: Array<Record<string, unknown>>, taskId = "007", agentLog?: string): Diagnosis {
  return diagnose({ taskId, events: events.map(ev), agentLog });
}

/** Every diagnosis must satisfy these, whatever the input. */
function assertWellFormed(d: Diagnosis): void {
  assert.equal(typeof d.headline, "string");
  assert.ok(d.headline.length > 0, "headline must never be empty");
  assert.equal(typeof d.detail, "string");
  assert.ok(d.confidence >= 0 && d.confidence <= 1, `confidence out of range: ${d.confidence}`);
  assert.ok(Array.isArray(d.timeline));
  assert.ok(Array.isArray(d.evidence));
  assert.ok(Array.isArray(d.recommendations));
  assert.ok(d.recommendations.length > 0, "an operator always needs a next step");
  for (const r of d.recommendations) {
    assert.equal(typeof r.label, "string");
    assert.equal(typeof r.detail, "string");
  }
  assert.equal(typeof summarize(d), "string");
  assert.ok(!summarize(d).includes("\n"), "summarize must stay on one line");
}

/* ------------------------------------------------------------ parseAgentLog */

const REAL_LOG = [
  '{"type":"system","subtype":"init","session_id":"abc","tools":["Read","Bash"]}',
  "",
  "  ↑ warming up the sandbox…",
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading the ticket."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"' +
    ESC +
    '[31mENOENT: no such file or directory, open \'a.ts\'' +
    ESC +
    '[0m"}]}}',
  "Traceback (most recent call last):",
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"}}]}}',
  '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Ran out of turns before finishing.","num_turns":42,"duration_ms":900123,"total_cost_usd":1.25}',
].join("\n");

test("parseAgentLog: reads records, turns, tool uses, tool errors and the result", () => {
  const v = parseAgentLog(REAL_LOG);
  assert.equal(v.records.length, 5);
  assert.equal(v.assistantTurns, 2);
  assert.deepEqual(
    v.toolUses.map((t) => t.name),
    ["Read", "Bash"],
  );
  assert.equal(v.toolUses[0]?.id, "t1");
  assert.ok(v.toolUses[0]?.input.includes("a.ts"));
  assert.equal(v.toolErrors.length, 1);
  assert.equal(v.toolErrors[0], "ENOENT: no such file or directory, open 'a.ts'");
  assert.deepEqual(v.texts, ["Reading the ticket."]);
  assert.equal(v.result?.subtype, "error_max_turns");
  assert.equal(v.result?.isError, true);
  assert.equal(v.result?.turns, 42);
  assert.equal(v.result?.costUsd, 1.25);
});

test("parseAgentLog: skips blank lines and noise instead of throwing", () => {
  const v = parseAgentLog(REAL_LOG);
  assert.equal(v.skippedLines, 2); // the banner and the traceback line
  assert.equal(v.parsedLines, 5);
  assert.equal(v.totalLines, 7);
  assert.ok(v.tail.length > 0);
  assert.ok(v.tail.every((l) => !l.includes(ESC)), "tail must be ANSI-free");
});

test("parseAgentLog: pure noise, truncated JSON and empty input are all survivable", () => {
  for (const bad of ["", "   ", "\n\n\t\n", "not json at all\nnope", '{"type":"assistant", "message":', "[", "null"]) {
    const v = parseAgentLog(bad);
    assert.equal(v.result, null);
    assert.equal(v.assistantTurns, 0);
    assert.equal(v.toolErrors.length, 0);
  }
  const v = parseAgentLog('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}');
  assert.equal(v.parsedLines, 0);
  assert.equal(v.skippedLines, 1);
});

test("parseAgentLog: tolerates a record whose shape is nothing like stream-json", () => {
  const v = parseAgentLog('{"hello":"world"}\n[1,2,3]\n"a string"\n42');
  assert.equal(v.records.length, 2); // object + array; the bare scalars are not JSONL records we keep
  assert.equal(v.assistantTurns, 0);
});

test("stripAnsi / truncate: colours go, content stays verbatim", () => {
  assert.equal(stripAnsi(ESC + "[1;31mred" + ESC + "[0m"), "red");
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(truncate("abc", 10), "abc");
  const long = "x".repeat(500);
  const cut = truncate(long, 100);
  assert.ok(cut.startsWith("x".repeat(100)));
  assert.ok(cut.includes("truncated"));
});

/* ------------------------------------------------------------- categories */

test("verify_failed: a flaky check recommends a retry first, with verbatim evidence", () => {
  const failure = "npm --prefix dashboard test — Error: connect ETIMEDOUT 10.0.0.1:443";
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    { ts: "t2", event: "agent_result", task: "007", status: "done", turns: 12, wall_s: 88, summary: "Implemented the module." },
    { ts: "t3", event: "state", task: "007", from: "RUNNING", to: "VERIFYING" },
    { ts: "t4", event: "verify", task: "007", ok: false, failures: [failure] },
    { ts: "t5", event: "failure", task: "007", reason: "verification did not pass" },
    { ts: "t6", event: "state", task: "007", from: "VERIFYING", to: "FAILED" },
  ]);
  assert.equal(d.category, "verify_failed");
  assert.equal(d.recommendations[0]?.op, "retry");
  assert.equal(d.recommendations[0]?.task, "007");
  const quoted = d.evidence.find((e) => e.source === "verify");
  assert.equal(quoted?.excerpt, failure); // verbatim, not reworded
  assert.ok(d.confidence > 0.8);
  assertWellFormed(d);
});

test("verify_failed: the same check failing twice stops recommending a blind retry first", () => {
  const d = run([
    { ts: "t1", event: "verify", task: "007", ok: false, failures: ["pytest -q — 3 failed, 41 passed"] },
    { ts: "t2", event: "retry", task: "007", attempt: 1, reason: "verify failed" },
    { ts: "t3", event: "verify", task: "007", ok: false, failures: ["pytest -q — 3 failed, 41 passed"] },
    { ts: "t4", event: "state", task: "007", from: "VERIFYING", to: "FAILED" },
  ]);
  assert.equal(d.category, "verify_failed");
  assert.equal(d.recommendations[0]?.op, undefined, "the first move is human, not another retry");
  assert.ok(d.recommendations.some((r) => r.op === "retry"), "a retry is still offered, just not first");
  assert.ok(d.evidence.some((e) => e.source === "retry"));
  assertWellFormed(d);
});

test("blocked: recommends answering, and quotes the question verbatim", () => {
  const question = "Should I bump the pinned esbuild version, or keep 0.24 and work around the bug?";
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    {
      ts: "t2",
      event: "blocked",
      task: "007",
      question,
      context: { clean: true, commits: 0, status: [], diffstat: [] },
    },
    { ts: "t3", event: "state", task: "007", from: "RUNNING", to: "BLOCKED" },
  ]);
  assert.equal(d.category, "blocked");
  assert.equal(d.recommendations[0]?.op, "answer");
  assert.equal(d.recommendations[0]?.task, "007");
  assert.ok(d.evidence.some((e) => e.source === "blocked" && e.excerpt === question));
  assert.ok(d.detail.includes("clean"), "the captured git facts belong in the explanation");
  assert.ok(d.confidence >= 0.9);
  assertWellFormed(d);
});

test("merge_conflict: keeps the branch, offers resolve / retry / undo", () => {
  const d = run([
    { ts: "t1", event: "agent_result", task: "007", status: "done", turns: 9, wall_s: 60, summary: "Done." },
    { ts: "t2", event: "verify", task: "007", ok: true, failures: [] },
    { ts: "t3", event: "state", task: "007", from: "MERGE_QUEUED", to: "MERGING" },
    { ts: "t4", event: "failure", task: "007", reason: "merge conflict in dashboard/src/app.tsx" },
    { ts: "t5", event: "state", task: "007", from: "MERGING", to: "FAILED" },
  ]);
  assert.equal(d.category, "merge_conflict");
  assert.equal(d.recommendations[0]?.op, undefined);
  assert.deepEqual(
    d.recommendations.map((r) => r.op),
    [undefined, "retry", "undo"],
  );
  assert.ok(d.evidence.some((e) => e.excerpt === "merge conflict in dashboard/src/app.tsx"));
  assertWellFormed(d);
});

test("timeout: a still-running agent is a runaway — kill comes first", () => {
  const d = run(
    [
      { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
      { ts: "t2", event: "failure", task: "007", reason: "agent hit max_turns without a result" },
    ],
    "007",
    '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"out of turns","num_turns":80}',
  );
  assert.equal(d.category, "timeout");
  assert.equal(d.recommendations[0]?.op, "kill");
  assert.equal(d.recommendations[0]?.task, "007");
  assert.ok(d.recommendations.some((r) => r.op === "retry"));
  assertWellFormed(d);
});

test("timeout: once the task has left RUNNING, kill is not offered", () => {
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "RUNNING", to: "FAILED" },
    { ts: "t2", event: "failure", task: "007", reason: "agent timed out after 900s" },
  ]);
  assert.equal(d.category, "timeout");
  assert.ok(!d.recommendations.some((r) => r.op === "kill"));
  assertWellFormed(d);
});

test("rate_limit: run-level pauses explain a task that never got going", () => {
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    { ts: "t2", event: "paused_ratelimit", pause_n: 1, cooldown_s: 300 },
    { ts: "t3", event: "plan_limit", status: "limited", resets_at: 1770000000, window: "five_hour" },
    { ts: "t4", event: "state", task: "007", from: "RUNNING", to: "FAILED" },
  ]);
  assert.equal(d.category, "rate_limit");
  assert.equal(d.recommendations[0]?.op, "resume");
  assert.ok(d.timeline.some((s) => s.label.includes("rate limit")));
  assertWellFormed(d);
});

test("budget: the run's cap, not the ticket", () => {
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    { ts: "t2", event: "budget_exceeded", spent_usd: 12.5, budget_usd: 10 },
    { ts: "t3", event: "failure", task: "007", reason: "run halted before completion" },
  ]);
  assert.equal(d.category, "budget");
  assert.equal(d.recommendations[0]?.op, "resume");
  assert.ok(d.detail.includes("$12.50"));
  assert.ok(d.evidence.some((e) => e.source === "run" && e.excerpt.includes("12.5")));
  assertWellFormed(d);
});

test("stopped: an operator kill is not a defect", () => {
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    { ts: "t2", event: "failure", task: "007", reason: "killed by operator" },
    { ts: "t3", event: "run_end", counts: { done: 2, failed: 1 }, stopped: true },
  ]);
  assert.equal(d.category, "stopped");
  assert.equal(d.recommendations[0]?.op, "resume");
  assert.ok(d.recommendations.some((r) => r.op === "retry"));
  assertWellFormed(d);
});

test("stopped: a run stopped under an in-flight task, with no failure of its own", () => {
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    { ts: "t2", event: "run_end", counts: {}, stopped: true },
  ]);
  assert.equal(d.category, "stopped");
  assertWellFormed(d);
});

test("agent_error: the agent's own error text is quoted, retry is offered second", () => {
  const log = [
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm ci"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"npm ERR! code EUNSUPPORTEDPROTOCOL"}]}}',
    '{"type":"result","subtype":"error","is_error":true,"result":"I could not install the dependencies.","num_turns":4}',
  ].join("\n");
  const d = run(
    [
      { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
      { ts: "t2", event: "agent_result", task: "007", status: "error", turns: 4, wall_s: 30, summary: "Dependency install refused." },
      { ts: "t3", event: "state", task: "007", from: "RUNNING", to: "FAILED" },
    ],
    "007",
    log,
  );
  assert.equal(d.category, "agent_error");
  assert.equal(d.recommendations[1]?.op, "retry");
  assert.ok(d.evidence.some((e) => e.source === "agent_log" && e.excerpt === "npm ERR! code EUNSUPPORTEDPROTOCOL"));
  assert.ok(d.evidence.some((e) => e.source === "agent_result" && e.excerpt === "Dependency install refused."));
  assertWellFormed(d);
});

/* --------------------------------------------------------------- totality */

test("unknown: no events at all", () => {
  const d = run([]);
  assert.equal(d.category, "unknown");
  assert.ok(d.headline.includes("007"));
  assert.equal(d.timeline.length, 0);
  assertWellFormed(d);
});

test("unknown: the task appears in no event, even though the run has plenty", () => {
  const d = run(
    [
      { ts: "t1", event: "state", task: "008", from: "QUEUED", to: "RUNNING" },
      { ts: "t2", event: "verify", task: "008", ok: false, failures: ["boom"] },
      { ts: "t3", event: "failure", task: "008", reason: "verification did not pass" },
    ],
    "007",
  );
  assert.equal(d.category, "unknown");
  assert.ok(!d.evidence.some((e) => e.excerpt === "boom"), "another task's evidence must not leak in");
  assertWellFormed(d);
});

test("unknown: a log that is pure noise adds nothing but never breaks", () => {
  const d = run([], "007", "[2K\rbuilding...\nTraceback (most recent call last):\n  File \"x.py\"\n{oops\n");
  assert.equal(d.category, "unknown");
  assertWellFormed(d);
});

test("unknown: events missing their fields entirely", () => {
  const d = run([
    { ts: "t1", event: "state", task: "007" },
    { event: "verify", task: "007" },
    { ts: "t3", event: "agent_result", task: "007" },
  ]);
  assert.ok(["unknown", "agent_error", "verify_failed"].includes(d.category));
  assertWellFormed(d);
});

test("unknown: a task that simply succeeded has no failure to explain", () => {
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    { ts: "t2", event: "verify", task: "007", ok: true, failures: [] },
    { ts: "t3", event: "state", task: "007", from: "MERGING", to: "DONE" },
  ]);
  assert.equal(d.category, "unknown");
  assert.ok(d.headline.includes("successfully"));
  assertWellFormed(d);
});

test("diagnose never throws, whatever it is handed", () => {
  const junk: unknown[] = [
    undefined,
    null,
    {},
    { taskId: "007" },
    { taskId: "", events: [] },
    { taskId: "007", events: null },
    { taskId: "007", events: "not an array" },
    { taskId: 42, events: [null, 0, "x", [], { event: 1 }] },
    { taskId: "007", events: [{ ts: null, event: null, task: "007" }] },
    { taskId: "007", events: [{ event: "verify", task: "007", ok: "nope", failures: "not a list" }] },
    { taskId: "007", events: [{ event: "blocked", task: "007" }], agentLog: 17 },
    { taskId: "007", events: [{ event: "budget_exceeded", spent_usd: "lots" }] },
  ];
  for (const input of junk) {
    const d = diagnose(input as unknown as DiagnoseInput);
    assertWellFormed(d);
    assert.equal(typeof d.category, "string");
  }
});

test("diagnose is deterministic: same input, identical output", () => {
  const events = [
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    { ts: "t2", event: "verify", task: "007", ok: false, failures: ["tsc — 2 errors"] },
  ];
  assert.deepEqual(run(events), run(events));
});

/* --------------------------------------------------------------- timeline */

test("timeline: follows the events in order, with a readable tone per step", () => {
  const d = run([
    { ts: "t1", event: "state", task: "007", from: "QUEUED", to: "RUNNING" },
    { ts: "t2", event: "agent_progress", task: "007", turns: 3, tokens: 900 },
    { ts: "t3", event: "agent_result", task: "007", status: "done", turns: 7, wall_s: 41.4, summary: "ok" },
    { ts: "t4", event: "verify", task: "007", ok: false, failures: ["a", "b"] },
    { ts: "t5", event: "retry", task: "007", attempt: 1, reason: "verify failed" },
    { ts: "t6", event: "state", task: "007", from: "VERIFYING", to: "FAILED" },
  ]);
  assert.deepEqual(
    d.timeline.map((s) => s.ts),
    ["t1", "t3", "t4", "t5", "t6"], // agent_progress is noise in a post-mortem
  );
  assert.equal(d.timeline[0]?.label, "QUEUED → RUNNING");
  assert.equal(d.timeline[1]?.label, "Agent finished: done (7 turns, 41s)");
  assert.equal(d.timeline[2]?.label, "Verification failed (2 checks)");
  assert.equal(d.timeline[2]?.tone, "bad");
  assert.equal(d.timeline[3]?.tone, "warn");
  assert.equal(d.timeline[4]?.tone, "bad");
});

/* -------------------------------------------------------------- summarize */

test("summarize: one line, naming the category and the next move", () => {
  const d = run([
    { ts: "t1", event: "blocked", task: "007", question: "Which base branch?" },
    { ts: "t2", event: "state", task: "007", from: "RUNNING", to: "BLOCKED" },
  ]);
  const s = summarize(d);
  assert.ok(s.startsWith("Blocked:"));
  assert.ok(s.includes("Answer the question"));
  assert.ok(s.includes("%"));
  assert.ok(s.length <= 240 + 20);
});

test("summarize: survives a hand-made or malformed diagnosis", () => {
  assert.equal(typeof summarize({} as unknown as Diagnosis), "string");
  assert.equal(typeof summarize(null as unknown as Diagnosis), "string");
  assert.equal(categoryLabel("verify_failed"), "Verification failed");
});

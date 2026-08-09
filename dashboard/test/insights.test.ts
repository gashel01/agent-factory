import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  actualCosts,
  attachPendingForecast,
  buildForecasts,
  diagnoseTask,
  isSafeId,
  listRuns,
  readBacklogTickets,
  readForecastFor,
  readRunEvents,
  reconcileRun,
  savePendingForecast,
} from "../src/insights.js";
import { PROFILE_IDS } from "../src/forecast.js";

/* ------------------------------- the fixture ------------------------------- */

/** One temp workspace, shaped exactly like a real one: `runs/<run>/events.jsonl`,
 *  `runs/<run>/agents/<task>.stdout.jsonl`, `backlog/*.md`. Built once — every test
 *  below reads it, and only the forecast tests write (each under its own run id). */
const root = mkdtempSync(join(tmpdir(), "insights-"));
const runsDir = join(root, "runs");
const backlogDir = join(root, "backlog");
const RUN = "2026-08-09_010203";

after(() => rmSync(root, { recursive: true, force: true }));

const events = [
  {
    ts: "2026-08-09T01:02:03Z",
    event: "run_start",
    run: RUN,
    slots: 2,
    tasks: [
      { id: "001", title: "Alpha", model: "sonnet" },
      { id: "002", title: "Beta", model: "sonnet" },
    ],
  },
  { ts: "2026-08-09T01:02:04Z", event: "state", task: "001", from: "QUEUED", to: "RUNNING" },
  { ts: "2026-08-09T01:02:05Z", event: "state", task: "002", from: "QUEUED", to: "RUNNING" },
  {
    ts: "2026-08-09T01:07:00Z",
    event: "agent_result",
    task: "001",
    status: "done",
    turns: 12,
    wall_s: 297,
    summary: "implemented the parser",
    cost_usd: 0.42,
    input_tokens: 30_000,
    output_tokens: 12_000,
    cache_read_tokens: 260_000,
  },
  { ts: "2026-08-09T01:07:10Z", event: "state", task: "001", from: "RUNNING", to: "VERIFYING" },
  {
    ts: "2026-08-09T01:08:00Z",
    event: "verify",
    task: "001",
    ok: false,
    failures: ["`pytest -q` exited 1: 2 failed, 41 passed in 3.10s"],
  },
  {
    ts: "2026-08-09T01:08:01Z",
    event: "failure",
    task: "001",
    reason: "verify failed: `pytest -q` exited 1",
  },
  { ts: "2026-08-09T01:08:02Z", event: "state", task: "001", from: "VERIFYING", to: "FAILED" },
  {
    ts: "2026-08-09T01:09:00Z",
    event: "agent_result",
    task: "002",
    status: "done",
    turns: 8,
    wall_s: 180,
    summary: "renamed the flag",
    cost_usd: 0.30,
    input_tokens: 18_000,
    output_tokens: 6_000,
    cache_read_tokens: 140_000,
  },
  { ts: "2026-08-09T01:09:30Z", event: "state", task: "002", from: "MERGING", to: "DONE" },
  { ts: "2026-08-09T01:09:31Z", event: "run_end", counts: { merged: 1, failed: 1 }, stopped: false },
];

mkdirSync(join(runsDir, RUN, "agents"), { recursive: true });
writeFileSync(
  join(runsDir, RUN, "events.jsonl"),
  // A live events.jsonl is appended to while we read it, so the fixture ends on a
  // deliberately torn line: parsing must skip it, not fall over.
  events.map((e) => JSON.stringify(e)).join("\n") + "\n" + '{"ts":"2026-08-09T01:09:3',
  "utf-8",
);

writeFileSync(
  join(runsDir, RUN, "agents", "001.stdout.jsonl"),
  [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the parser." }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }),
    "[stderr] npm warn deprecated something",
    JSON.stringify({ type: "result", subtype: "success", result: "done, but pytest is red" }),
  ].join("\n") + "\n",
  "utf-8",
);

// A run directory with no events.jsonl must not be listed as a run.
mkdirSync(join(runsDir, "not-a-run"), { recursive: true });

mkdirSync(backlogDir, { recursive: true });
writeFileSync(
  join(backlogDir, "001-alpha.md"),
  [
    "---",
    'id: "001"',
    "title: Alpha",
    "files_hint: [src/a.py, src/b.py]",
    "verify:",
    "  - pytest -q",
    "budget: { timeout_min: 45 }",
    "---",
    "",
    "Do the alpha thing, thoroughly and with care for the edge cases.",
  ].join("\n"),
  "utf-8",
);
writeFileSync(
  join(backlogDir, "002-beta.md"),
  ["---", 'id: "002"', "title: Beta", "---", "", "Rename a flag."].join("\n"),
  "utf-8",
);
// A ticket with no front matter at all: the id falls back to the filename stem.
writeFileSync(join(backlogDir, "003-gamma.md"), "Just a body, no front matter.\n", "utf-8");
// Not a ticket — must be ignored.
writeFileSync(join(backlogDir, "notes.txt"), "scratch\n", "utf-8");

/* --------------------------------- reading --------------------------------- */

test("readRunEvents parses every whole line and skips the torn tail", () => {
  const parsed = readRunEvents(runsDir, RUN);
  assert.equal(parsed.length, events.length);
  assert.equal(parsed[0]?.["event"], "run_start");
  assert.equal(parsed[parsed.length - 1]?.["event"], "run_end");
});

test("readRunEvents is empty for a run that does not exist", () => {
  assert.deepEqual(readRunEvents(runsDir, "nope"), []);
});

test("listRuns returns only directories holding an events.jsonl", () => {
  assert.deepEqual(listRuns(runsDir), [RUN]);
  assert.deepEqual(listRuns(join(root, "no-such-dir")), []);
});

test("readBacklogTickets parses front matter and ignores non-markdown", () => {
  const tickets = readBacklogTickets(backlogDir);
  assert.deepEqual(tickets.map((t) => t.id), ["001", "002", "003"]);
  assert.deepEqual(tickets[0]?.filesHint, ["src/a.py", "src/b.py"]);
  assert.deepEqual(tickets[0]?.verify, ["pytest -q"]);
  assert.equal(tickets[0]?.timeoutMin, 45);
  assert.deepEqual(readBacklogTickets(join(root, "no-such-dir")), []);
});

/* ------------------------------- diagnostics ------------------------------- */

test("diagnoseTask explains a failed task with a category and verbatim evidence", () => {
  const d = diagnoseTask(runsDir, RUN, "001");
  assert.ok(d, "expected a diagnosis for task 001");
  assert.equal(d.taskId, "001");
  assert.equal(d.category, "verify-failed");
  assert.ok(d.evidence.length > 0, "a diagnosis with no evidence is a guess");
  // Evidence must be a slice of the input, not a paraphrase.
  assert.ok(
    d.evidence.some((e) => e.excerpt.includes("pytest -q")),
    `no verbatim evidence in ${JSON.stringify(d.evidence)}`,
  );
  assert.ok(d.timeline.length > 0);
  assert.ok(d.headline.length > 0);
});

test("diagnoseTask reads the agent log alongside the events", () => {
  const d = diagnoseTask(runsDir, RUN, "001");
  assert.ok(d);
  // 002 has no stdout log; both still diagnose, which proves the log is optional
  // rather than a precondition.
  const other = diagnoseTask(runsDir, RUN, "002");
  assert.ok(other, "a task known only from its events is still diagnosable");
  assert.equal(other.taskId, "002");
});

test("diagnoseTask returns null for a task the run never heard of", () => {
  assert.equal(diagnoseTask(runsDir, RUN, "999"), null);
  assert.equal(diagnoseTask(runsDir, "2020-01-01_000000", "001"), null);
});

/* --------------------------------- forecast -------------------------------- */

test("buildForecasts quotes the backlog once per profile", () => {
  const bundle = buildForecasts(runsDir, backlogDir);
  assert.equal(bundle.forecasts.length, PROFILE_IDS.length);
  assert.deepEqual(bundle.forecasts.map((f) => f.profile), [...PROFILE_IDS]);
  assert.deepEqual(bundle.profiles.map((p) => p.id), [...PROFILE_IDS]);
  assert.equal(bundle.tickets.length, 3);

  for (const f of bundle.forecasts) {
    assert.equal(f.perTask.length, 3, `${f.profile} must quote every ticket`);
    assert.ok(f.totalUsd > 0, `${f.profile} totalUsd must be positive`);
    assert.ok(f.lowUsd <= f.totalUsd && f.totalUsd <= f.highUsd, `${f.profile} band must bracket the estimate`);
    assert.ok(f.assumptions.length > 0);
  }
  // Cheap must not cost more than thorough — the profiles have to mean something.
  const [cheap, , thorough] = bundle.forecasts;
  assert.ok(cheap && thorough && cheap.totalUsd < thorough.totalUsd);

  // The one run in the fixture has two completed tasks, so history calibrates it.
  assert.equal(bundle.history.runs, 1);
  assert.ok(bundle.history.samples > 0);
  assert.equal(bundle.history.basis, "blended");
});

test("buildForecasts can exclude a run from its own calibration", () => {
  const bundle = buildForecasts(runsDir, backlogDir, { exceptRun: RUN });
  assert.equal(bundle.history.runs, 0);
  assert.equal(bundle.history.samples, 0);
  assert.equal(bundle.history.basis, "heuristic");
});

/* --------------------------- predicted vs actual --------------------------- */

test("actualCosts sums every attempt of a task", () => {
  const costs = actualCosts([
    { event: "agent_result", task: "001", cost_usd: 0.4 },
    { event: "agent_result", task: "001", cost_usd: 0.2 }, // a retry: both were billed
    { event: "agent_result", task: "002", cost_usd: 0.1 },
    { event: "state", task: "001", to: "DONE" },
    { event: "agent_result", cost_usd: 9 }, // no task id: not attributable
  ]);
  costs.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(costs.map((c) => c.id), ["001", "002"]);
  assert.ok(Math.abs((costs[0]?.costUsd ?? 0) - 0.6) < 1e-9);
  assert.ok(Math.abs((costs[1]?.costUsd ?? 0) - 0.1) < 1e-9);
});

test("save -> attach -> reconcile round-trips and yields sane deltas", () => {
  const workdir = mkdtempSync(join(tmpdir(), "insights-ws-"));
  try {
    const bundle = buildForecasts(runsDir, backlogDir, { exceptRun: RUN });
    const chosen = bundle.forecasts.find((f) => f.profile === "standard");
    assert.ok(chosen);

    // Nothing forecast yet: an absent reconciliation, not a zeroed one.
    assert.equal(reconcileRun(workdir, runsDir, RUN), null);

    const pending = savePendingForecast(workdir, chosen, "standard");
    assert.equal(pending.profile, "standard");
    assert.equal(pending.run, undefined);
    assert.ok(Date.parse(pending.savedAt) > 0);
    // Still pending: it is not bound to a run until one exists.
    assert.equal(readForecastFor(workdir, RUN), null);

    const bound = attachPendingForecast(workdir, RUN);
    assert.ok(bound);
    assert.equal(bound.run, RUN);
    assert.equal(bound.forecast.totalUsd, chosen.totalUsd);
    assert.deepEqual(readForecastFor(workdir, RUN)?.forecast.perTask.map((t) => t.id), ["001", "002", "003"]);

    const rec = reconcileRun(workdir, runsDir, RUN);
    assert.ok(rec);
    // 001 and 002 ran and were forecast; 003 was forecast but never ran.
    assert.deepEqual(rec.perTask.map((r) => r.id).sort(), ["001", "002", "003"]);
    assert.ok(Math.abs(rec.actualTotal - 0.72) < 1e-9, `actualTotal was ${rec.actualTotal}`);
    assert.ok(rec.predictedTotal > 0);
    // The per-task deltas must add up to the headline delta (to float tolerance:
    // the two sums accumulate the same terms in a different order).
    const summedDelta = rec.perTask.reduce((s, r) => s + r.deltaUsd, 0);
    assert.ok(Math.abs(summedDelta - (rec.actualTotal - rec.predictedTotal)) < 1e-9);
    for (const r of rec.perTask) {
      assert.ok(Number.isFinite(r.deltaUsd), `${r.id} deltaUsd must be finite`);
      assert.ok(Number.isFinite(r.deltaPct), `${r.id} deltaPct must be finite`);
      assert.equal(r.deltaUsd, r.actualUsd - r.predictedUsd);
    }
    // A task that never ran still shows up, with a zero on the actual side.
    const gamma = rec.perTask.find((r) => r.id === "003");
    assert.equal(gamma?.actualUsd, 0);
    assert.ok(Number.isFinite(rec.calibration) && rec.calibration > 0);
    assert.equal(typeof rec.withinRange, "boolean");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("attaching is idempotent and never overwrites a bound forecast", () => {
  const workdir = mkdtempSync(join(tmpdir(), "insights-ws-"));
  try {
    const bundle = buildForecasts(runsDir, backlogDir, { exceptRun: RUN });
    const cheap = bundle.forecasts.find((f) => f.profile === "cheap");
    const thorough = bundle.forecasts.find((f) => f.profile === "thorough");
    assert.ok(cheap && thorough);

    savePendingForecast(workdir, cheap, "cheap");
    const first = attachPendingForecast(workdir, RUN);
    assert.equal(first?.profile, "cheap");

    // Second call with nothing pending: a no-op that leaves the binding intact.
    assert.equal(attachPendingForecast(workdir, RUN), null);
    assert.equal(readForecastFor(workdir, RUN)?.profile, "cheap");

    // A NEW pending forecast must not retro-fit a run that already has one, or the
    // prediction we are judged against could be rewritten after the fact.
    savePendingForecast(workdir, thorough, "thorough");
    const again = attachPendingForecast(workdir, RUN);
    assert.equal(again?.profile, "cheap");
    assert.equal(readForecastFor(workdir, RUN)?.profile, "cheap");
    assert.equal(readForecastFor(workdir, RUN)?.forecast.totalUsd, cheap.totalUsd);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("savePendingForecast refuses a malformed forecast instead of losing it", () => {
  const workdir = mkdtempSync(join(tmpdir(), "insights-ws-"));
  try {
    assert.throws(() => savePendingForecast(workdir, { profile: "standard" } as never), /perTask/);
    assert.throws(() => savePendingForecast(workdir, null as never), /perTask/);
    assert.equal(attachPendingForecast(workdir, RUN), null);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

/* -------------------------------- id guards -------------------------------- */

test("isSafeId rejects traversal and separators", () => {
  for (const good of ["001", "2026-08-09_010203", "task.a-1", "A_b.c"]) {
    assert.equal(isSafeId(good), true, `${good} should be accepted`);
  }
  for (const bad of ["..", "../x", "a/../b", "a/b", "a\\b", "/etc/passwd", "C:\\win", "", " ", "a b", null, 7]) {
    assert.equal(isSafeId(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test("every fs entry point rejects a traversing id rather than reading outside", () => {
  // A file that a traversal WOULD reach, planted one level above the runs dir.
  writeFileSync(join(root, "events.jsonl"), JSON.stringify({ event: "leaked" }) + "\n", "utf-8");

  for (const bad of ["..", "../..", "a/b", "a\\b"]) {
    assert.deepEqual(readRunEvents(runsDir, bad), [], `readRunEvents leaked for ${bad}`);
    assert.equal(diagnoseTask(runsDir, bad, "001"), null, `diagnoseTask leaked for run ${bad}`);
    assert.equal(diagnoseTask(runsDir, RUN, bad), null, `diagnoseTask leaked for task ${bad}`);
    assert.equal(reconcileRun(root, runsDir, bad), null, `reconcileRun leaked for ${bad}`);
    assert.equal(readForecastFor(root, bad), null, `readForecastFor leaked for ${bad}`);
    assert.equal(attachPendingForecast(root, bad), null, `attachPendingForecast leaked for ${bad}`);
  }

  // The planted file is still exactly where we left it: nothing wrote through it.
  assert.equal(readFileSync(join(root, "events.jsonl"), "utf-8").trim(), '{"event":"leaked"}');
});

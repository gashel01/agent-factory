import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTicket,
  priceFor,
  priceKeyFor,
  MODEL_PRICING,
  complexityOf,
  PROFILES,
  profileFor,
  historyStats,
  emptyHistory,
  forecastRun,
  reconcile,
  type TicketMeta,
  type HistoryStats,
} from "../src/forecast.js";

/* --------------------------------- helpers --------------------------------- */

function ticket(over: Partial<TicketMeta> = {}): TicketMeta {
  return {
    file: "backlog/900-t.md",
    id: "900",
    title: "T",
    filesHint: [],
    dependsOn: [],
    priority: null,
    timeoutMin: null,
    verify: [],
    model: null,
    effort: null,
    bodyChars: 800,
    ...over,
  };
}

const WELL_FORMED = `---
id: "001"   # quote ids: bare 001 is parsed as the integer 1 by YAML
title: Add input validation to the /users endpoint
repo: ../../myproject
files_hint: [src/api/users.py, tests/test_users.py]
depends_on: []
priority: 1
max_retries: 2
budget: { timeout_min: 45, max_turns: 50 }
model: opus
effort: high
verify:
  - pytest tests/test_users.py -q
  - ruff check .
---

## Context

POST /users accepts an empty email.
`;

/** Finished-run events for one task, in the order the dispatcher writes them. */
function runEvents(
  run: string,
  tasks: Array<{ id: string; model?: string; cost: number; input: number; output: number; cacheRead: number; retried?: boolean }>,
): { run: string; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [
    {
      ts: "2026-01-01T00:00:00Z",
      event: "run_start",
      run,
      slots: 2,
      mode: "api",
      tasks: tasks.map((t) => ({ id: t.id, title: t.id, model: t.model ?? null, effort: null })),
    },
  ];
  for (const t of tasks) {
    if (t.retried) events.push({ ts: "", event: "retry", task: t.id, attempt: 1, reason: "verify" });
    events.push({
      ts: "", event: "agent_result", task: t.id, status: "ok", turns: 20, wall_s: 300,
      summary: "", cost_usd: t.cost, input_tokens: t.input, output_tokens: t.output,
      cache_read_tokens: t.cacheRead,
    });
    events.push({ ts: "", event: "state", task: t.id, from: "MERGING", to: "DONE" });
  }
  return { run, events };
}

/** `sampleCount` completed Sonnet tasks that each cost `cost` USD, with a token mix
 *  that actually prices out to that cost (~$1 per unit at the Sonnet rate). */
function history(sampleCount: number, cost: number): HistoryStats {
  const tasks = Array.from({ length: sampleCount }, (_, i) => ({
    id: `t${i}`, model: "claude-sonnet-4-5-20250929", cost,
    input: Math.round(80_000 * cost),
    output: Math.round(33_000 * cost),
    cacheRead: Math.round(830_000 * cost),
  }));
  return historyStats([runEvents("r1", tasks)]);
}

/* ------------------------------ front matter ------------------------------ */

test("parseTicket: well-formed front matter", () => {
  const t = parseTicket("backlog/001-example.md", WELL_FORMED);
  assert.equal(t.file, "backlog/001-example.md");
  assert.equal(t.id, "001");
  assert.equal(t.title, "Add input validation to the /users endpoint");
  assert.deepEqual(t.filesHint, ["src/api/users.py", "tests/test_users.py"]);
  assert.deepEqual(t.dependsOn, []);
  assert.equal(t.priority, 1);
  assert.equal(t.timeoutMin, 45); // read out of the nested budget mapping
  assert.deepEqual(t.verify, ["pytest tests/test_users.py -q", "ruff check ."]);
  assert.equal(t.model, "opus");
  assert.equal(t.effort, "high");
  assert.ok(t.bodyChars > 0);
  assert.ok(!/repo/.test(t.title));
});

test("parseTicket: flat timeout_min and block-style nesting are both accepted", () => {
  const flat = parseTicket("backlog/2.md", "---\nid: 2\ntimeout_min: 12\n---\nbody\n");
  assert.equal(flat.timeoutMin, 12);
  const nested = parseTicket("backlog/3.md", "---\nid: 3\nbudget:\n  timeout_min: 90\n  max_turns: 50\npriority: 4\n---\nbody\n");
  assert.equal(nested.timeoutMin, 90);
  assert.equal(nested.priority, 4); // dedenting back to the top level still works
});

test("parseTicket: no front matter falls back to defaults, never throws", () => {
  const t = parseTicket("backlog/007-orphan.md", "# Just a heading\n\nSome prose.\n");
  assert.equal(t.id, "007"); // recovered from the filename
  assert.equal(t.title, "");
  assert.deepEqual(t.filesHint, []);
  assert.deepEqual(t.verify, []);
  assert.equal(t.priority, null);
  assert.equal(t.timeoutMin, null);
  assert.equal(t.model, null);
  assert.ok(t.bodyChars > 0);
  assert.equal(parseTicket("backlog/x.md", "").bodyChars, 0);
});

test("parseTicket: malformed front matter degrades instead of throwing", () => {
  // Unterminated block: everything is body.
  const unterminated = parseTicket("backlog/010-bad.md", "---\nid: 010\ntitle: oops\n\nno closing marker\n");
  assert.equal(unterminated.id, "010");
  assert.equal(unterminated.title, "");

  // Terminated, but the contents are junk YAML-ish soup.
  const junk = parseTicket("backlog/011-junk.md", "---\n: : :\n- stray item\nid 011\npriority: high\ntimeout_min: 30m\nfiles_hint: {oops\n---\n# Fix the thing\n");
  assert.equal(junk.id, "011");
  assert.equal(junk.title, "Fix the thing"); // fell back to the first heading
  assert.equal(junk.priority, null);         // "high" is not a whole number
  assert.equal(junk.timeoutMin, null);       // neither is "30m"
  assert.deepEqual(junk.dependsOn, []);
});

/* --------------------------------- pricing --------------------------------- */

test("priceFor: aliases, full ids and the documented fallback", () => {
  assert.equal(priceKeyFor("opus"), "opus");
  assert.equal(priceKeyFor("claude-opus-4-1-20250805"), "opus-4-1");
  assert.equal(priceKeyFor("claude-sonnet-4-5-20250929"), "sonnet");
  assert.equal(priceKeyFor("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(priceKeyFor("some-model-nobody-has-heard-of"), "sonnet");
  assert.equal(priceKeyFor(null), "sonnet");
  assert.deepEqual(priceFor("claude-sonnet-4-5"), MODEL_PRICING["sonnet"]);
  assert.ok(priceFor("haiku").outPerMTok < priceFor("sonnet").outPerMTok);
  assert.ok(priceFor("sonnet").outPerMTok < priceFor("opus").outPerMTok);
  for (const p of Object.values(MODEL_PRICING)) {
    assert.ok(p.cacheReadPerMTok < p.inPerMTok, "cache reads must be cheaper than fresh input");
  }
});

/* ------------------------------- complexity ------------------------------- */

test("complexityOf: stays inside 0..1", () => {
  assert.ok(complexityOf(ticket({ bodyChars: 0 })) >= 0);
  const huge = complexityOf(ticket({
    bodyChars: 500_000, filesHint: Array(200).fill("f.ts"), verify: Array(50).fill("x"),
    timeoutMin: 10_000, dependsOn: Array(50).fill("d"),
  }));
  assert.ok(huge > 0.9 && huge <= 1, `expected near 1, got ${huge}`);
});

test("complexityOf: monotonic in every input", () => {
  const base = ticket({ bodyChars: 500, filesHint: ["a"], verify: ["v"], timeoutMin: 20, dependsOn: [] });
  const c0 = complexityOf(base);
  const steps: Array<[string, TicketMeta]> = [
    ["bodyChars", ticket({ ...base, bodyChars: 5_000 })],
    ["filesHint", ticket({ ...base, filesHint: ["a", "b", "c"] })],
    ["verify", ticket({ ...base, verify: ["v", "w"] })],
    ["timeoutMin", ticket({ ...base, timeoutMin: 120 })],
    ["dependsOn", ticket({ ...base, dependsOn: ["001"] })],
  ];
  for (const [label, t] of steps) {
    assert.ok(complexityOf(t) > c0, `${label} must increase complexity (${complexityOf(t)} vs ${c0})`);
  }
  // And it keeps increasing — no plateau once an input gets large.
  assert.ok(
    complexityOf(ticket({ ...base, filesHint: Array(20).fill("f") }))
    > complexityOf(ticket({ ...base, filesHint: Array(10).fill("f") })),
  );
});

/* -------------------------------- profiles -------------------------------- */

test("profileFor: unknown ids fall back to standard", () => {
  assert.equal(profileFor("thorough").id, "thorough");
  assert.equal(profileFor("CHEAP").id, "cheap");
  assert.equal(profileFor("nonsense").id, "standard");
  assert.equal(profileFor(null).id, "standard");
});

test("profiles order the same tickets cheap <= standard <= thorough", () => {
  const tickets = [
    ticket({ id: "1", bodyChars: 400, filesHint: ["a"], verify: ["pytest -q"] }),
    ticket({ id: "2", bodyChars: 4_000, filesHint: ["a", "b", "c", "d"], verify: ["a", "b"], timeoutMin: 90, dependsOn: ["1"] }),
  ];
  const cheap = forecastRun(tickets, { profile: "cheap" });
  const standard = forecastRun(tickets, { profile: "standard" });
  const thorough = forecastRun(tickets, { profile: "thorough" });
  assert.ok(cheap.totalUsd <= standard.totalUsd, `${cheap.totalUsd} <= ${standard.totalUsd}`);
  assert.ok(standard.totalUsd <= thorough.totalUsd, `${standard.totalUsd} <= ${thorough.totalUsd}`);
  assert.ok(cheap.totalUsd > 0);
  // The profiles really do change the plan, not just a multiplier.
  assert.equal(cheap.perTask[0]?.model, PROFILES.cheap.model);
  assert.equal(thorough.perTask[0]?.effort, PROFILES.thorough.effort);
  assert.ok((thorough.perTask[0]?.expectedTurns ?? 0) > (cheap.perTask[0]?.expectedTurns ?? 0));
});

/* --------------------------------- history --------------------------------- */

test("historyStats: no runs yields a well-formed zero-sample object", () => {
  for (const stats of [historyStats([]), emptyHistory()]) {
    assert.equal(stats.samples, 0);
    assert.equal(stats.medianCostUsd, 0);
    assert.equal(stats.retryRate, 0);
    assert.deepEqual(stats.medianTokens, { input: 0, output: 0, cacheRead: 0 });
    assert.deepEqual(stats.byModel, {});
    for (const v of [stats.medianCostUsd, stats.medianTurns, stats.medianWallS, stats.retryRate]) {
      assert.ok(Number.isFinite(v));
    }
  }
});

test("historyStats: medians per completed task, per model family, plus retry rate", () => {
  const stats = historyStats([
    runEvents("r1", [
      { id: "a", model: "claude-sonnet-4-5", cost: 1, input: 10, output: 20, cacheRead: 30 },
      { id: "b", model: "claude-sonnet-4-5", cost: 3, input: 10, output: 20, cacheRead: 30, retried: true },
      { id: "c", model: "claude-opus-4-1-20250805", cost: 9, input: 10, output: 20, cacheRead: 30 },
    ]),
  ]);
  assert.equal(stats.runs, 1);
  assert.equal(stats.samples, 3);
  assert.equal(stats.medianCostUsd, 3);
  assert.equal(stats.retryRate, 1 / 3);
  assert.equal(stats.byModel["sonnet"]?.samples, 2);
  assert.equal(stats.byModel["sonnet"]?.medianCostUsd, 2); // even count -> mean of the middle pair
  assert.equal(stats.byModel["opus-4-1"]?.medianCostUsd, 9);
});

test("historyStats: a task that never reached DONE is not a sample", () => {
  const { events } = runEvents("r1", [
    { id: "a", model: "sonnet", cost: 1, input: 1, output: 1, cacheRead: 1 },
    { id: "b", model: "sonnet", cost: 50, input: 1, output: 1, cacheRead: 1 },
  ]);
  const trimmed = events.filter((e) => !(e["event"] === "state" && e["task"] === "b"));
  const stats = historyStats([{ run: "r1", events: trimmed }]);
  assert.equal(stats.samples, 1);
  assert.equal(stats.medianCostUsd, 1);
});

/* -------------------------------- forecast -------------------------------- */

test("forecastRun: no history is heuristic-only and says so", () => {
  const f = forecastRun([ticket({ id: "1" })], { profile: "standard" });
  assert.equal(f.basis, "heuristic");
  assert.equal(f.profile, "standard");
  assert.equal(f.perTask.length, 1);
  assert.ok(f.totalUsd > 0);
  assert.ok(f.lowUsd < f.totalUsd && f.totalUsd < f.highUsd);
  assert.ok(f.assumptions.some((a) => /no completed-task history/i.test(a)));
  const task = f.perTask[0]!;
  for (const v of [task.costUsd, task.lowUsd, task.highUsd, task.complexity, task.expectedTurns,
    task.tokens.input, task.tokens.output, task.tokens.cacheRead]) {
    assert.ok(Number.isFinite(v), "no NaN may reach a caller");
  }
});

test("forecastRun: history calibrates the heuristic upwards and labels the basis", () => {
  const tickets = [ticket({ id: "1", bodyChars: 2_000, filesHint: ["a", "b"], verify: ["pytest -q"] })];
  const heuristic = forecastRun(tickets, { profile: "standard" });

  // Five expensive past tasks: enough to move the number, not enough to own it.
  const blended = forecastRun(tickets, { profile: "standard", history: history(5, 8) });
  assert.equal(blended.basis, "blended");
  assert.ok(blended.totalUsd > heuristic.totalUsd, `${blended.totalUsd} > ${heuristic.totalUsd}`);
  assert.ok(blended.assumptions.some((a) => /calibrated against 5 completed/i.test(a)));

  // Past the trust threshold the history owns the estimate outright.
  const owned = forecastRun(tickets, { profile: "standard", history: history(30, 8) });
  assert.equal(owned.basis, "history");
  assert.ok(owned.totalUsd > blended.totalUsd);
  // Confidence earns a tighter band.
  const width = (f: typeof owned) => (f.highUsd - f.lowUsd) / f.totalUsd;
  assert.ok(width(owned) < width(heuristic));
});

test("forecastRun: cheap history pulls the estimate down too (calibration is two-way)", () => {
  const tickets = [ticket({ id: "1" })];
  const heuristic = forecastRun(tickets, { profile: "standard" });
  const cheapPast = forecastRun(tickets, { profile: "standard", history: history(30, 0.02) });
  assert.ok(cheapPast.totalUsd < heuristic.totalUsd);
  assert.ok(cheapPast.totalUsd > 0);
});

test("forecastRun: a per-ticket model/effort beats the profile and the run default", () => {
  const tickets = [
    ticket({ id: "1" }),
    ticket({ id: "2", model: "opus", effort: "max" }),
  ];
  const f = forecastRun(tickets, { profile: "cheap", defaultModel: "sonnet", defaultEffort: "low" });
  assert.equal(f.perTask[0]?.model, "sonnet"); // run default beats the profile
  assert.equal(f.perTask[0]?.effort, "low");
  assert.equal(f.perTask[1]?.model, "opus");   // the ticket beats both
  assert.equal(f.perTask[1]?.effort, "max");
  assert.ok((f.perTask[1]?.costUsd ?? 0) > (f.perTask[0]?.costUsd ?? 0));
  assert.ok(f.assumptions.some((a) => /override the profile/i.test(a)));
});

test("forecastRun: no tickets, unknown profile — still total and sane", () => {
  const f = forecastRun([], { profile: "wild-guess" });
  assert.equal(f.profile, "standard");
  assert.equal(f.totalUsd, 0);
  assert.equal(f.lowUsd, 0);
  assert.equal(f.highUsd, 0);
  assert.ok(f.assumptions.some((a) => /unknown profile/i.test(a)));
});

/* -------------------------------- reconcile -------------------------------- */

test("reconcile: exact match feeds forward a calibration of 1", () => {
  const f = forecastRun([ticket({ id: "1" }), ticket({ id: "2" })], { profile: "standard" });
  const actuals = f.perTask.map((t) => ({ id: t.id, costUsd: t.costUsd }));
  const r = reconcile(f, actuals);
  assert.equal(r.perTask.length, 2);
  assert.ok(Math.abs(r.calibration - 1) < 1e-9);
  assert.ok(Math.abs(r.deltaPct) < 1e-9);
  assert.equal(r.withinRange, true);
});

test("reconcile: partially-missing actuals produce no NaN", () => {
  const f = forecastRun([ticket({ id: "1" }), ticket({ id: "2" }), ticket({ id: "3" })], { profile: "standard" });
  const predicted1 = f.perTask[0]!.costUsd;
  // "1" ran and cost double; "2" and "3" never ran; "9" ran but was never forecast.
  const r = reconcile(f, [{ id: "1", costUsd: predicted1 * 2 }, { id: "9", costUsd: 0.5 }]);

  assert.deepEqual(r.perTask.map((t) => t.id), ["1", "2", "3", "9"]);
  for (const row of r.perTask) {
    for (const v of [row.predictedUsd, row.actualUsd, row.deltaUsd, row.deltaPct]) {
      assert.ok(Number.isFinite(v), `NaN/Infinity in ${row.id}`);
    }
  }
  const forecastOnly = r.perTask.find((t) => t.id === "2")!;
  assert.equal(forecastOnly.actualUsd, 0);
  assert.equal(forecastOnly.deltaPct, -100);

  const actualOnly = r.perTask.find((t) => t.id === "9")!;
  assert.equal(actualOnly.predictedUsd, 0);
  assert.equal(actualOnly.deltaPct, 100); // spend with no prediction, not Infinity

  // Calibration only counts the one task present on both sides.
  assert.ok(Math.abs(r.calibration - 2) < 1e-9);
  assert.ok(Number.isFinite(r.predictedTotal) && Number.isFinite(r.actualTotal) && Number.isFinite(r.deltaPct));
});

test("reconcile: empty actuals and an empty forecast stay finite", () => {
  const f = forecastRun([ticket({ id: "1" })], { profile: "standard" });
  const none = reconcile(f, []);
  assert.equal(none.actualTotal, 0);
  assert.equal(none.deltaPct, -100);
  assert.equal(none.calibration, 1); // nothing observed -> do not re-scale the next forecast
  assert.equal(none.withinRange, false);

  const empty = reconcile(forecastRun([], { profile: "standard" }), []);
  assert.equal(empty.perTask.length, 0);
  assert.equal(empty.deltaPct, 0);
  assert.equal(empty.calibration, 1);
  assert.equal(empty.withinRange, true); // 0 spent against a 0 forecast is, honestly, on target
});

test("reconcile: a wild outlier cannot poison the next forecast", () => {
  const f = forecastRun([ticket({ id: "1" })], { profile: "standard" });
  const insane = reconcile(f, [{ id: "1", costUsd: f.perTask[0]!.costUsd * 1000 }]);
  assert.equal(insane.calibration, 10); // clamped
  const free = reconcile(f, [{ id: "1", costUsd: 0 }]);
  assert.equal(free.calibration, 1); // a zero-cost actual is not evidence, not a 0x factor
});

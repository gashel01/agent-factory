/* End-to-end tests for the fs layer: a throwaway workspace tree on disk, read
 * through insights.ts into the pure cores. The cores have their own unit tests;
 * what is asserted here is the wiring — that real files produce the right
 * verdict, that missing ones degrade instead of throwing, and that a traversal
 * id is refused rather than read. */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  actualsFor, attachForecastToRun, buildForecasts, diagnoseTask, isSafeId, listRuns,
  pickRun, readAgentLog, readBacklogTickets, readPendingForecast, readRunEvents,
  readRunForecast, reconcileRun, requireRun, safeJoin, savePendingForecast, tailFile,
} from "../src/insights.js";

const RUN = "2026-01-01_090000";
const OLD_RUN = "2025-12-01_090000";

let root = "";
let workdir = "";
let runsDir = "";

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "insights-test-"));
  workdir = join(root, "ws");
  runsDir = join(workdir, "runs");
  mkdirSync(join(runsDir, RUN, "agents"), { recursive: true });
  mkdirSync(join(runsDir, OLD_RUN), { recursive: true });
  mkdirSync(join(workdir, "backlog"), { recursive: true });

  // The run under test: 001 fails its verification, 002 merges cleanly.
  const events = jsonl([
    {
      ts: "2026-01-01T09:00:00Z", event: "run_start", mode: "api", budget_usd: 20,
      tasks: [{ id: "001", title: "Add the widget" }, { id: "002", title: "Tidy the docs" }],
    },
    { ts: "2026-01-01T09:00:01Z", event: "state", task: "001", from: "QUEUED", to: "RUNNING" },
    { ts: "2026-01-01T09:00:02Z", event: "state", task: "002", from: "QUEUED", to: "RUNNING" },
    {
      ts: "2026-01-01T09:05:00Z", event: "agent_result", task: "001", status: "ok", turns: 12,
      wall_s: 300, summary: "implemented the widget", cost_usd: 1.5,
      input_tokens: 90_000, output_tokens: 10_000, spent_usd: 1.5,
    },
    {
      ts: "2026-01-01T09:05:30Z", event: "verify", task: "001", ok: false,
      failures: ["pytest -q — 2 failed, 41 passed"],
    },
    { ts: "2026-01-01T09:05:31Z", event: "failure", task: "001", reason: "verification failed" },
    { ts: "2026-01-01T09:05:32Z", event: "state", task: "001", from: "VERIFYING", to: "FAILED" },
    {
      ts: "2026-01-01T09:06:00Z", event: "agent_result", task: "002", status: "ok", turns: 4,
      wall_s: 120, summary: "docs tidied", cost_usd: 0.5,
      input_tokens: 20_000, output_tokens: 4_000, spent_usd: 2,
    },
    { ts: "2026-01-01T09:06:10Z", event: "verify", task: "002", ok: true, failures: [] },
    { ts: "2026-01-01T09:06:11Z", event: "state", task: "002", from: "VERIFYING", to: "DONE" },
    { ts: "2026-01-01T09:07:00Z", event: "run_end", counts: { DONE: 1, FAILED: 1 }, stopped: false },
  ]);
  // A blank line and a half-written tail line: exactly what tailing a live file
  // hands you, and neither may sink the read.
  writeFileSync(
    join(runsDir, RUN, "events.jsonl"),
    events + "\n" + '{"ts":"2026-01-01T09:07:01Z","event":"stat',
    "utf-8",
  );

  writeFileSync(
    join(runsDir, RUN, "agents", "001.stdout.jsonl"),
    jsonl([
      { type: "assistant", message: { content: [{ type: "text", text: "Running the tests." }] } },
      {
        type: "result", subtype: "success", is_error: false, num_turns: 12,
        duration_ms: 300_000, total_cost_usd: 1.5, result: "pytest reports 2 failures",
      },
    ]),
    "utf-8",
  );

  // An older run, so history has something to average over.
  writeFileSync(
    join(runsDir, OLD_RUN, "events.jsonl"),
    jsonl([
      { ts: "2025-12-01T09:00:00Z", event: "run_start", mode: "api", tasks: [{ id: "000", title: "Bootstrap" }] },
      { ts: "2025-12-01T09:00:01Z", event: "state", task: "000", from: "QUEUED", to: "RUNNING" },
      {
        ts: "2025-12-01T09:10:00Z", event: "agent_result", task: "000", status: "ok", turns: 9,
        wall_s: 600, summary: "bootstrapped", cost_usd: 2.25,
        input_tokens: 100_000, output_tokens: 15_000, spent_usd: 2.25,
      },
      { ts: "2025-12-01T09:10:05Z", event: "state", task: "000", from: "VERIFYING", to: "DONE" },
    ]),
    "utf-8",
  );

  writeFileSync(
    join(workdir, "backlog", "001-widget.md"),
    "---\nid: \"001\"\ntitle: Add the widget\npriority: 2\nverify:\n  - pytest -q\n---\n"
      + "## Goal\nAdd the widget to the panel and wire it to the store.\n",
    "utf-8",
  );
  writeFileSync(
    join(workdir, "backlog", "002-docs.md"),
    "---\nid: \"002\"\ntitle: Tidy the docs\nassignee: human\n---\n## Goal\nRewrite the README intro.\n",
    "utf-8",
  );
  // A directory next to the tickets: it must not be mistaken for one.
  mkdirSync(join(workdir, "backlog", "done"), { recursive: true });
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("reading a run", () => {
  it("skips corrupt lines instead of throwing", () => {
    const events = readRunEvents(runsDir, RUN);
    assert.equal(events.length, 11);
    assert.equal((events[0] as { event?: string }).event, "run_start");
    assert.equal((events[events.length - 1] as { event?: string }).event, "run_end");
  });

  it("returns [] for a missing run, a missing dir and a null id", () => {
    assert.deepEqual(readRunEvents(runsDir, "2000-01-01_000000"), []);
    assert.deepEqual(readRunEvents(join(root, "nope"), RUN), []);
    assert.deepEqual(readRunEvents(runsDir, null), []);
  });

  it("lists only runs that carry events, sorted", () => {
    assert.deepEqual(listRuns(runsDir), [OLD_RUN, RUN]);
    assert.deepEqual(listRuns(join(root, "nope")), []);
  });

  it("tails an agent log without loading it whole", () => {
    const log = readAgentLog(runsDir, RUN, "001");
    assert.ok(log.includes("pytest reports 2 failures"));
    // A cut mid-file drops the partial first line rather than emitting half a record.
    const file = join(runsDir, RUN, "agents", "001.stdout.jsonl");
    const tail = tailFile(file, 40);
    assert.ok(tail.length < 40);
    assert.ok(!tail.includes("Running the tests."));
    assert.equal(tailFile(join(runsDir, RUN, "agents", "nope.jsonl")), "");
  });
});

describe("diagnosing a task", () => {
  it("categorises a failing verification", () => {
    const d = diagnoseTask(runsDir, RUN, "001");
    assert.equal(d.category, "verify_failed");
    assert.equal(d.taskId, "001");
    assert.ok(d.confidence > 0.5);
    assert.ok(d.evidence.some((e) => e.excerpt.includes("2 failed, 41 passed")));
    assert.ok(d.timeline.length > 0);
  });

  it("diagnoses from events alone when the agent log is missing", () => {
    assert.equal(readAgentLog(runsDir, RUN, "002"), "");
    const d = diagnoseTask(runsDir, RUN, "002");
    assert.equal(d.taskId, "002");
    assert.ok(d.headline.length > 0);
  });

  it("answers with an unknown diagnosis when there is no run at all", () => {
    const d = diagnoseTask(runsDir, null, "001");
    assert.equal(d.category, "unknown");
    assert.equal(d.taskId, "001");
    assert.ok(d.recommendations.length > 0);
  });
});

describe("path-id validation", () => {
  const TRAVERSALS = ["..", "../..", "../../etc", "a/b", "a\\b", "/etc/passwd", "C:\\Windows", ".", ""];

  it("rejects traversal ids outright", () => {
    for (const bad of TRAVERSALS) {
      assert.equal(isSafeId(bad), false, `${bad} must not be a safe id`);
      assert.equal(safeJoin(runsDir, bad), null, `${bad} must not resolve`);
    }
    assert.equal(safeJoin(runsDir, null), null);
    assert.equal(safeJoin(runsDir, 42), null);
    assert.ok(safeJoin(runsDir, RUN));
  });

  it("refuses a traversal run id rather than reading through it", () => {
    // A real events.jsonl one level above the runs dir: clamping instead of
    // rejecting would happily serve it.
    writeFileSync(join(workdir, "events.jsonl"), jsonl([{ ts: "x", event: "run_start" }]), "utf-8");
    for (const bad of ["..", "../..", "/etc", "runs/2026"]) {
      assert.throws(() => requireRun(runsDir, bad), /bad run id/);
      assert.throws(() => diagnoseTask(runsDir, bad, "001"), /bad run id/);
      assert.deepEqual(readRunEvents(runsDir, bad), []);
    }
    assert.equal(readRunForecast(runsDir, "../.."), null);
  });

  it("refuses a traversal task id", () => {
    for (const bad of ["..", "../secrets", "a/b", "/etc/passwd"]) {
      assert.throws(() => diagnoseTask(runsDir, RUN, bad), /bad task id/);
      assert.equal(readAgentLog(runsDir, RUN, bad), "");
    }
  });

  it("rejects an unknown-but-well-formed run id, and passes a known one", () => {
    assert.throws(() => requireRun(runsDir, "2000-01-01_000000"), /unknown run/);
    assert.equal(requireRun(runsDir, RUN), RUN);
    assert.equal(requireRun(runsDir, null), null);
    assert.equal(requireRun(runsDir, ""), null);
  });

  it("picks the current run when none is asked for, and validates one that is", () => {
    assert.equal(pickRun(runsDir, null, RUN), RUN);
    assert.equal(pickRun(runsDir, "", RUN), RUN);
    assert.equal(pickRun(runsDir, RUN, OLD_RUN), RUN);
    assert.equal(pickRun(runsDir, null, null), null);
    assert.equal(pickRun(runsDir, null, "../.."), null);
    assert.throws(() => pickRun(runsDir, "../..", RUN), /bad run id/);
  });
});

describe("the backlog", () => {
  it("parses every ticket, sorted", () => {
    const tickets = readBacklogTickets(workdir);
    assert.equal(tickets.length, 2);
    assert.equal(tickets[0]?.id, "001");
    assert.equal(tickets[0]?.title, "Add the widget");
    assert.deepEqual(tickets[0]?.verify, ["pytest -q"]);
    assert.equal(tickets[1]?.assignee, "human");
  });

  it("returns [] when there is no backlog", () => {
    assert.deepEqual(readBacklogTickets(join(root, "nope")), []);
  });
});

describe("forecasting", () => {
  it("produces one estimate per profile, built on the run history", () => {
    const bundle = buildForecasts(workdir, runsDir);
    assert.equal(bundle.tickets, 2);
    for (const name of ["cheap", "standard", "thorough"] as const) {
      const f = bundle.forecasts[name];
      assert.equal(f.profile, name);
      assert.ok(f.usd > 0, `${name} must cost something`);
      assert.ok(f.tokens > 0);
      // The human-owned ticket is reported as skipped, not counted.
      assert.equal(f.counted, 1);
      assert.deepEqual(f.skipped.map((s) => s.id), ["002"]);
    }
    assert.ok(bundle.forecasts.cheap.usd <= bundle.forecasts.standard.usd);
    assert.ok(bundle.forecasts.standard.usd <= bundle.forecasts.thorough.usd);
    // Two past runs carry spend, so the estimates are not pure heuristic.
    assert.ok(bundle.history.samples >= 2);
    assert.ok(bundle.history.trust > 0);
    assert.notEqual(bundle.forecasts.standard.basis, "heuristic");
  });

  it("still forecasts with no workspace at all", () => {
    const bundle = buildForecasts(join(root, "nope"), join(root, "nope", "runs"));
    assert.equal(bundle.tickets, 0);
    assert.equal(bundle.forecasts.standard.usd, 0);
    assert.equal(bundle.history.samples, 0);
  });

  it("honours a slot count", () => {
    assert.equal(buildForecasts(workdir, runsDir, 6).slots, 6);
  });
});

describe("pending forecasts and reconciliation", () => {
  it("saves an accepted estimate and rejects an unnamed profile", () => {
    const { forecasts } = buildForecasts(workdir, runsDir);
    assert.throws(() => savePendingForecast(workdir, "lavish", forecasts.standard), /profile must be one of/);
    assert.throws(() => savePendingForecast(workdir, "standard", null), /forecast is required/);
    assert.equal(readPendingForecast(workdir), null);

    const stored = savePendingForecast(workdir, "standard", forecasts.standard, "2026-01-01T08:59:00Z");
    assert.equal(stored.profile, "standard");
    assert.equal(readPendingForecast(workdir)?.ts, "2026-01-01T08:59:00Z");
  });

  it("degrades a corrupt stored estimate to null instead of throwing", () => {
    writeFileSync(join(workdir, "forecast-pending.json"), "{ not json", "utf-8");
    assert.equal(readPendingForecast(workdir), null);
    writeFileSync(join(workdir, "forecast-pending.json"), '{"profile":"nope"}', "utf-8");
    assert.equal(readPendingForecast(workdir), null);
    assert.equal(readPendingForecast(join(root, "nope")), null);
  });

  it("attaches the pending estimate to the run and scores it", () => {
    const { forecasts } = buildForecasts(workdir, runsDir);
    savePendingForecast(workdir, "standard", forecasts.standard, "2026-01-01T08:59:00Z");

    // Nothing is stored for the run yet, so there is nothing to reconcile.
    assert.equal(readRunForecast(runsDir, OLD_RUN), null);

    const attached = attachForecastToRun(workdir, runsDir, RUN);
    assert.equal(attached?.profile, "standard");
    assert.equal(readRunForecast(runsDir, RUN)?.ts, "2026-01-01T08:59:00Z");
    // The pending file was consumed: the next launch must not inherit it.
    assert.equal(readPendingForecast(workdir), null);

    const actuals = actualsFor(runsDir, RUN);
    assert.equal(actuals.usd, 2); // the run's authoritative spent_usd, not the sum
    assert.equal(actuals.tokens, 124_000);
    assert.equal(actuals.tickets?.length, 2);

    const rec = reconcileRun(workdir, runsDir, RUN);
    assert.ok(rec);
    assert.equal(rec.actualUsd, 2);
    assert.equal(rec.forecastUsd, forecasts.standard.usd);
    // 001 was forecast and ran; 002 was skipped as human-owned but still burned
    // agent time, so it shows up as `extra` rather than being dropped.
    assert.equal(rec.matched, 1);
    assert.equal(rec.extra, 1);
    assert.ok(rec.accuracy >= 0 && rec.accuracy <= 1);
  });

  it("returns null for a run no estimate was stored for", () => {
    assert.equal(reconcileRun(workdir, runsDir, OLD_RUN), null);
    assert.equal(reconcileRun(workdir, runsDir, null), null);
    assert.equal(reconcileRun(workdir, runsDir, "2000-01-01_000000"), null);
    assert.equal(reconcileRun(join(root, "nope"), join(root, "nope", "runs"), RUN), null);
  });
});

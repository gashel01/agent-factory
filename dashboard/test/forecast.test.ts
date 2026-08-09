import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTicket,
  priceFor,
  MODEL_PRICING,
  DEFAULT_MODEL,
  complexityOf,
  PROFILES,
  PROFILE_NAMES,
  historyStats,
  forecastRun,
  reconcile,
} from "../src/forecast.js";

/** Walk any value and fail on the first NaN/Infinity/undefined it finds. */
function assertTotal(value: unknown, path = "$"): void {
  if (value === undefined) assert.fail(`${path} is undefined`);
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} is not finite: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertTotal(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertTotal(v, `${path}.${k}`);
  }
}

// --- parseTicket ------------------------------------------------------------

test("parseTicket: full front matter", () => {
  const t = parseTicket("backlog/008-forecast.md", [
    "---",
    "id: 008",
    'title: "Pure cost-forecast core"',
    "repo: .",
    "assignee: agent",
    "hold: false",
    "priority: 3",
    "depends_on:",
    "  - 001",
    "  - 002",
    "verify:",
    "  - npm test",
    "  - pytest -q",
    "model: claude-opus-4-1",
    "effort: high",
    "budget:",
    "  timeout_min: 45",
    "---",
    "",
    "## Body",
    "- one",
  ].join("\n"));
  assert.equal(t.id, "008");
  assert.equal(t.title, "Pure cost-forecast core");
  assert.equal(t.assignee, "agent");
  assert.equal(t.hold, false);
  assert.equal(t.priority, 3);
  assert.deepEqual(t.depends_on, ["001", "002"]);
  assert.deepEqual(t.verify, ["npm test", "pytest -q"]);
  assert.equal(t.model, "claude-opus-4-1");
  assert.equal(t.effort, "high");
  // Indentation is ignored, so a nested `budget:` block still yields timeout_min.
  assert.equal(t.timeout_min, 45);
  assert.ok(t.body.includes("## Body"));
  assert.ok(!t.body.includes("id: 008"));
});

test("parseTicket: no front matter falls back to the filename", () => {
  const t = parseTicket("backlog/012-do-the-thing.md", "just a body, no fences\n");
  assert.equal(t.id, "012-do-the-thing");
  assert.equal(t.title, "012-do-the-thing");
  assert.equal(t.body, "just a body, no fences\n");
  assert.equal(t.hold, false);
  assert.deepEqual(t.depends_on, []);
  assert.equal(t.timeout_min, null);
  assertTotal(t);
});

test("parseTicket: empty, malformed and unterminated content never throws", () => {
  assert.equal(parseTicket("a/b/007.md", "").id, "007");
  assert.equal(parseTicket("", "").id, "ticket");
  // Unterminated fence → treated as "no front matter", body kept whole.
  const un = parseTicket("x.md", "---\nid: nope\nstill going");
  assert.equal(un.id, "x");
  // Garbage lines are skipped, the good ones survive.
  const junk = parseTicket("y.md", "---\n:::::\n  ??? not yaml\nid: 42\n- orphan item\n---\nbody");
  assert.equal(junk.id, "42");
  assert.equal(junk.body, "body");
  // A non-numeric priority scores 0 rather than NaN.
  assert.equal(parseTicket("z.md", "---\npriority: high\n---\n").priority, 0);
  assertTotal([un, junk]);
});

test("parseTicket: hold, human assignee and inline lists", () => {
  const t = parseTicket("h.md", "---\nhold: yes\nassignee: human\ndepends_on: [001, '002']\nverify: npm test\n---\nb");
  assert.equal(t.hold, true);
  assert.equal(t.assignee, "human");
  assert.deepEqual(t.depends_on, ["001", "002"]);
  assert.deepEqual(t.verify, ["npm test"]);
});

// --- priceFor ---------------------------------------------------------------

test("priceFor: aliases, suffixes and a documented fallback", () => {
  assert.equal(priceFor("opus").inputPerMTok, MODEL_PRICING.opus?.inputPerMTok);
  assert.equal(priceFor("claude-opus-4-1-20250805").id, "opus");
  assert.equal(priceFor("us.anthropic.claude-3-5-haiku-v1:0").id, "haiku");
  assert.equal(priceFor("  SONNET  ").id, "sonnet");
  // Unknown / missing / junk all resolve to the documented default.
  for (const m of [undefined, null, "", "   ", "gpt-9", "???"]) {
    const p = priceFor(m);
    assert.equal(p.id, DEFAULT_MODEL);
    assertTotal(p);
  }
});

// --- complexityOf -----------------------------------------------------------

test("complexityOf: bounded in [0, 1] for degenerate input", () => {
  for (const t of [null, undefined, {}, { body: "" }, { timeout_min: -100 }, { timeout_min: 1e12 }, { body: "x".repeat(200_000) }]) {
    const c = complexityOf(t);
    assert.ok(Number.isFinite(c), `not finite: ${c}`);
    assert.ok(c >= 0 && c <= 1, `out of range: ${c}`);
  }
});

test("complexityOf: monotonic as the ticket grows", () => {
  const steps = [
    { body: "", verify: [], depends_on: [], timeout_min: null },
    { body: "Do the thing.", verify: [], depends_on: [], timeout_min: null },
    { body: "Do the thing.\n\nDetails ".repeat(30), verify: [], depends_on: [], timeout_min: null },
    { body: "Do the thing.\n\nDetails ".repeat(30) + "\n- a\n- b\n- c\n", verify: [], depends_on: [], timeout_min: null },
    { body: "Do the thing.\n\nDetails ".repeat(30) + "\n- a\n- b\n- c\n", verify: ["npm test"], depends_on: [], timeout_min: null },
    { body: "Do the thing.\n\nDetails ".repeat(30) + "\n- a\n- b\n- c\n", verify: ["npm test", "pytest -q", "tsc"], depends_on: [], timeout_min: null },
    { body: "Do the thing.\n\nDetails ".repeat(30) + "\n- a\n- b\n- c\n", verify: ["npm test", "pytest -q", "tsc"], depends_on: ["001", "002"], timeout_min: null },
    { body: "Do the thing.\n\nDetails ".repeat(30) + "\n- a\n- b\n- c\n", verify: ["npm test", "pytest -q", "tsc"], depends_on: ["001", "002"], timeout_min: 30 },
    { body: "Do the thing.\n\nDetails ".repeat(30) + "\n- a\n- b\n- c\n", verify: ["npm test", "pytest -q", "tsc"], depends_on: ["001", "002"], timeout_min: 120 },
  ];
  const scores = steps.map((s) => complexityOf(s));
  for (let i = 1; i < scores.length; i++) {
    assert.ok((scores[i] ?? 0) >= (scores[i - 1] ?? 0), `step ${i} lowered the score: ${scores[i - 1]} -> ${scores[i]}`);
  }
  // It actually moves — a flat-zero scorer would satisfy monotonicity alone.
  assert.ok((scores[scores.length - 1] ?? 0) > (scores[0] ?? 0));
  // And it saturates rather than clipping.
  assert.ok((scores[scores.length - 1] ?? 0) < 1);
});

// --- PROFILES ---------------------------------------------------------------

test("PROFILES: cheap <= standard <= thorough for the same backlog", () => {
  const backlog = [
    parseTicket("1.md", "---\nid: 1\ntitle: One\nverify:\n  - npm test\n---\nSmall ticket.\n- a\n"),
    parseTicket("2.md", "---\nid: 2\ntitle: Two\ntimeout_min: 60\n---\n" + "Bigger ticket. ".repeat(120)),
  ];
  const [cheap, standard, thorough] = PROFILE_NAMES.map((p) => forecastRun(backlog, { profile: p }));
  assert.ok(cheap && standard && thorough);
  assert.ok(cheap.usd <= standard.usd, `${cheap.usd} > ${standard.usd}`);
  assert.ok(standard.usd <= thorough.usd, `${standard.usd} > ${thorough.usd}`);
  assert.ok(cheap.tokens <= standard.tokens);
  assert.ok(standard.tokens <= thorough.tokens);
  assert.equal(cheap.model, PROFILES.cheap.model);
  assert.equal(thorough.effort, PROFILES.thorough.effort);
  // Ordering must survive a history blend too.
  const history = historyStats([{ run: "a", total: 4, spend: 12, tokens: 4_000_000 }]);
  const blended = PROFILE_NAMES.map((p) => forecastRun(backlog, { profile: p, history }));
  assert.ok((blended[0]?.usd ?? 0) <= (blended[1]?.usd ?? 0));
  assert.ok((blended[1]?.usd ?? 0) <= (blended[2]?.usd ?? 0));
});

// --- historyStats -----------------------------------------------------------

test("historyStats: empty and signal-free inputs give a zero sample", () => {
  for (const runs of [[], null, undefined, [{ total: 0, spend: 5 }], [{ total: 3, spend: 0, tokens: 0 }]]) {
    const h = historyStats(runs);
    assert.equal(h.samples, 0);
    assert.equal(h.trust, 0);
    assert.equal(h.meanUsdPerTicket, 0);
    assert.equal(h.medianTokensPerTicket, 0);
    assertTotal(h);
  }
});

test("historyStats: averages and growing trust", () => {
  const h1 = historyStats([{ run: "a", total: 4, spend: 8, tokens: 4_000_000 }]);
  assert.equal(h1.runs, 1);
  assert.equal(h1.tickets, 4);
  assert.equal(h1.meanUsdPerTicket, 2);
  assert.equal(h1.medianUsdPerTicket, 2);
  assert.equal(h1.meanTokensPerTicket, 1_000_000);
  const h6 = historyStats(Array.from({ length: 6 }, () => ({ total: 4, spend: 8, tokens: 4_000_000 })));
  assert.ok(h6.trust > h1.trust, `${h6.trust} <= ${h1.trust}`);
  assert.ok(h6.trust < 1);
  // A single runaway run moves the mean but not the median.
  const h = historyStats([{ total: 1, spend: 1 }, { total: 1, spend: 2 }, { total: 1, spend: 300 }]);
  assert.equal(h.medianUsdPerTicket, 2);
  assert.ok(h.meanUsdPerTicket > h.medianUsdPerTicket);
});

// --- forecastRun ------------------------------------------------------------

test("forecastRun: empty backlog is a well-defined zero", () => {
  for (const tickets of [[], null, undefined]) {
    const f = forecastRun(tickets, { profile: "standard" });
    assert.equal(f.counted, 0);
    assert.equal(f.usd, 0);
    assert.equal(f.tokens, 0);
    assert.equal(f.low, 0);
    assert.equal(f.high, 0);
    assert.equal(f.minutes, 0);
    assert.deepEqual(f.tickets, []);
    assert.equal(f.basis, "heuristic");
    assertTotal(f);
  }
});

test("forecastRun: held and human tickets are skipped, not counted", () => {
  const backlog = [
    parseTicket("1.md", "---\nid: 1\ntitle: Mine\n---\nwork"),
    parseTicket("2.md", "---\nid: 2\ntitle: Held\nhold: true\n---\nwork"),
    parseTicket("3.md", "---\nid: 3\ntitle: Theirs\nassignee: human\n---\nwork"),
  ];
  const f = forecastRun(backlog, { profile: "standard" });
  assert.equal(f.counted, 1);
  assert.deepEqual(f.tickets.map((t) => t.id), ["1"]);
  assert.deepEqual(f.skipped.map((s) => [s.id, s.reason]), [["2", "hold"], ["3", "human"]]);
  // Per-ticket rows add up to the run total exactly.
  assert.equal(f.usd, f.tickets.reduce((a, t) => a + t.usd, 0));
  assert.equal(f.tokens, f.tickets.reduce((a, t) => a + t.tokens, 0));
});

test("forecastRun: basis follows the amount of history", () => {
  const backlog = [parseTicket("1.md", "---\nid: 1\n---\nwork")];
  assert.equal(forecastRun(backlog, { profile: "standard" }).basis, "heuristic");
  assert.equal(forecastRun(backlog, { profile: "standard", history: historyStats([]) }).basis, "heuristic");
  const few = historyStats([{ total: 2, spend: 5, tokens: 1_000_000 }, { total: 2, spend: 6, tokens: 1_200_000 }]);
  assert.equal(forecastRun(backlog, { profile: "standard", history: few }).basis, "blend");
  const many = historyStats(Array.from({ length: 30 }, () => ({ total: 2, spend: 5, tokens: 1_000_000 })));
  assert.equal(forecastRun(backlog, { profile: "standard", history: many }).basis, "history");
  // More history ⇒ more confidence ⇒ a tighter range.
  const a = forecastRun(backlog, { profile: "standard" });
  const b = forecastRun(backlog, { profile: "standard", history: many });
  assert.ok(b.confidence > a.confidence);
  assert.ok(b.high - b.low >= 0 && a.high - a.low >= 0);
});

test("forecastRun: range brackets the estimate, wall-clock respects slots", () => {
  const backlog = Array.from({ length: 6 }, (_, i) => parseTicket(`${i}.md`, `---\nid: ${i}\n---\n` + "body ".repeat(200)));
  const one = forecastRun(backlog, { profile: "standard", slots: 1 });
  const six = forecastRun(backlog, { profile: "standard", slots: 6 });
  assert.ok(one.low <= one.usd && one.usd <= one.high);
  assert.ok(six.minutes < one.minutes, `${six.minutes} >= ${one.minutes}`);
  // Absurd slot counts are clamped, never divided by zero.
  for (const slots of [0, -5, 0.2, NaN, Infinity]) {
    const f = forecastRun(backlog, { profile: "standard", slots });
    assert.ok(f.slots >= 1);
    assertTotal(f);
  }
});

// --- reconcile --------------------------------------------------------------

test("reconcile: a perfect estimate scores 1", () => {
  const f = forecastRun([parseTicket("1.md", "---\nid: 1\n---\nwork")], { profile: "standard" });
  const row = f.tickets[0];
  assert.ok(row);
  const r = reconcile(f, { tickets: [{ id: "1", usd: row.usd, tokens: row.tokens }], usd: f.usd, tokens: f.tokens });
  assert.equal(r.matched, 1);
  assert.equal(r.missing, 0);
  assert.equal(r.extra, 0);
  assert.equal(r.deltaUsd, 0);
  assert.equal(r.relUsd, 0);
  assert.equal(r.accuracy, 1);
  assert.equal(r.withinRange, true);
  assertTotal(r);
});

test("reconcile: mismatched ticket sets are reported, not assumed away", () => {
  const f = forecastRun(
    [parseTicket("1.md", "---\nid: 1\n---\nwork"), parseTicket("2.md", "---\nid: 2\n---\nwork")],
    { profile: "standard" },
  );
  const r = reconcile(f, { tickets: [{ id: "1", usd: 3, tokens: 100 }, { id: "9", usd: 4, tokens: 200 }] });
  assert.equal(r.matched, 1);
  assert.equal(r.missing, 1); // ticket 2 was forecast but never ran
  assert.equal(r.extra, 1);   // ticket 9 ran but was never forecast
  assert.deepEqual(r.tickets.map((t) => [t.id, t.status]), [["1", "matched"], ["2", "missing"], ["9", "extra"]]);
  assert.equal(r.actualUsd, 7); // summed from the tickets when no run total is given
  assert.ok(r.accuracy < 1);
  assertTotal(r);
});

test("reconcile: degenerate sides never divide by zero", () => {
  const empty = forecastRun([], { profile: "standard" });
  const cases = [
    reconcile(empty, { tickets: [] }),
    reconcile(empty, { tickets: [{ id: "x", usd: 5, tokens: 10 }] }),
    reconcile(null, null),
    reconcile(undefined, { usd: 0, tokens: 0 }),
    reconcile(empty, { tickets: [{ usd: -3, tokens: -9 }], usd: -1, tokens: -1 }),
    // Duplicate ids on the actuals side accumulate.
    reconcile(empty, { tickets: [{ id: "d", usd: 1 }, { id: "D", usd: 2 }] }),
  ];
  for (const r of cases) {
    assertTotal(r);
    assert.ok(r.accuracy >= 0 && r.accuracy <= 1, `accuracy out of range: ${r.accuracy}`);
  }
  assert.equal(cases[5]?.tickets[0]?.actualUsd, 3);
  assert.equal(cases[2]?.withinRange, false);
});

// --- totality sweep ---------------------------------------------------------

test("no NaN anywhere for degenerate inputs", () => {
  const nasty = [
    parseTicket("a.md", ""),
    parseTicket("b.md", "---\n---\n"),
    parseTicket("c.md", "---\ntimeout_min: -50\npriority: nope\nmodel: \n---\n"),
    { id: "d", title: "", body: "x".repeat(50_000), verify: [], depends_on: [], timeout_min: 1e9 },
    { id: "", complexity: NaN } as unknown as ReturnType<typeof parseTicket>,
    {} as ReturnType<typeof parseTicket>,
  ];
  const histories = [
    historyStats([]),
    historyStats([{ total: 0, spend: 0, tokens: 0 }]),
    historyStats([{ total: -3, spend: -9, tokens: NaN as unknown as number }]),
    historyStats([{ total: 2, spend: 4, tokens: 500_000 }]),
    { runs: 1, tickets: 1, samples: 1, meanUsdPerTicket: NaN, medianUsdPerTicket: NaN, meanTokensPerTicket: NaN, medianTokensPerTicket: NaN, trust: NaN },
  ];
  for (const profile of [...PROFILE_NAMES, "bogus" as never, null, undefined]) {
    for (const history of histories) {
      for (const slots of [1, 0, -4, NaN]) {
        const f = forecastRun(nasty, { profile, slots, history });
        assertTotal(f, `forecast(${String(profile)})`);
        assert.ok(f.usd >= 0 && f.low >= 0 && f.high >= f.low);
        assert.ok(f.confidence >= 0 && f.confidence <= 1);
        assertTotal(reconcile(f, { tickets: [{ id: "d", usd: NaN, tokens: NaN }], usd: NaN, tokens: NaN }));
      }
    }
  }
});

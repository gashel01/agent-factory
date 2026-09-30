// Token counts must include the prompt cache (an agent replays its context from
// it every turn — without it Insights showed ~2% of the real volume), and a new
// project must carry the starting model the operator picked.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings, resultTokens } from "../src/model.js";
import { summarizeRun } from "../src/server-core.js";
import { starterFactoryYaml } from "../src/server-preview.js";

test("resultTokens sums all four billing classes and ignores junk", () => {
  assert.equal(resultTokens({ input_tokens: 10, output_tokens: 2_000, cache_read_tokens: 280_000, cache_write_tokens: 40_000 }), 322_010);
  assert.equal(resultTokens({ input_tokens: 5, output_tokens: "x", cache_read_tokens: Number.NaN }), 5);
});

test("summarizeRun counts cache tokens in a run's total", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-tok-"));
  try {
    mkdirSync(join(dir, "r1"));
    const ev = { event: "agent_result", task: "001", cost_usd: 0.23, input_tokens: 9, output_tokens: 2_700, cache_read_tokens: 141_000, cache_write_tokens: 19_000 };
    writeFileSync(join(dir, "r1", "events.jsonl"), JSON.stringify(ev) + "\n");
    assert.equal(summarizeRun(dir, "r1").tokens, 162_709);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the starter config records the chosen starting model", () => {
  assert.equal(parseSettings(starterFactoryYaml("sonnet")).model, "sonnet");
  assert.equal(parseSettings(starterFactoryYaml()).model, "");
});

// The project card must agree with the board: tickets the operator removed from
// the board don't count as "needs you" (or as merged) on the portfolio either.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portfolioCounts } from "../src/server-core.js";

function runsWith(events: object[]): string {
  const runsDir = mkdtempSync(join(tmpdir(), "warden-portfolio-"));
  mkdirSync(join(runsDir, "r1"));
  writeFileSync(join(runsDir, "r1", "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return runsDir;
}

test("removed tickets are left out of the portfolio counts", () => {
  const runsDir = runsWith([
    { event: "run_start", tasks: [{ id: "001" }, { id: "002" }, { id: "003" }] },
    { event: "state", task: "001", to: "DONE" },
    { event: "state", task: "002", to: "FAILED" },
    { event: "state", task: "003", to: "FAILED" },
  ]);
  try {
    const all = portfolioCounts(runsDir, "r1", false);
    assert.deepEqual(all.counts, { queued: 0, working: 0, needs: 2, merged: 1 });

    const shown = portfolioCounts(runsDir, "r1", false, new Set(["002", "003"]));
    assert.deepEqual(shown.counts, { queued: 0, working: 0, needs: 0, merged: 1 });
    assert.equal(shown.total, 1);

    const noMerged = portfolioCounts(runsDir, "r1", false, new Set(["001"]));
    assert.equal(noMerged.counts.merged, 0);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

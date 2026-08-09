import { test } from "node:test";
import assert from "node:assert/strict";

// A deliberately trivial test: it exists to prove the runner discovers more than the one
// file the old npm script hard-coded. If this does not show up in the output, discovery
// is broken.
test("harness: discovery picks up this file", () => {
  assert.equal(1 + 1, 2);
});

// Smoke tests for the discovery runner: this file exists so `npm test` provably
// bundles and runs MORE than one test file. Keep it dependency-free.
import { test } from "node:test";
import assert from "node:assert/strict";

test("harness: this file was discovered and executed", () => {
  assert.equal(1 + 1, 2);
});

test("harness: node:assert/strict is wired up", () => {
  assert.deepEqual({ a: [1, 2] }, { a: [1, 2] });
  assert.throws(() => assert.equal(1, "1"));
});

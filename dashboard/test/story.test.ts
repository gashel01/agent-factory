// A ticket's story is for a person: the contract JSON every agent must end with
// (for the dispatcher) was shown verbatim at the bottom of it.
import test from "node:test";
import assert from "node:assert/strict";
import { narrate, withoutContract } from "../src/model.js";

const CONTRACT = '{"status": "done", "summary": "Added the tests.", "tests": "pass", "noop": false}';

test("withoutContract drops the trailing contract, fenced or not", () => {
  assert.equal(withoutContract(`All 83 tests pass.\n\n${CONTRACT}`), "All 83 tests pass.");
  assert.equal(withoutContract(`Done.\n\`\`\`json\n${CONTRACT}\n\`\`\``), "Done.");
  assert.equal(withoutContract(CONTRACT), "");
});

test("withoutContract leaves ordinary text and inner objects alone", () => {
  assert.equal(withoutContract("Errors look like { \"error\": { \"code\" } } here."), "Errors look like { \"error\": { \"code\" } } here.");
  assert.equal(withoutContract('Config: {"retries": 2}'), 'Config: {"retries": 2}', "no status key, not the contract");
  assert.equal(withoutContract("{ not json"), "{ not json");
});

test("narrate keeps the prose and hides a message that was only the contract", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Split the test.\n\n${CONTRACT}` }] } }),
    JSON.stringify({ type: "result", result: CONTRACT }),
  ].join("\n");
  const story = narrate(raw);
  assert.deepEqual(story, [{ kind: "say", text: "Split the test." }]);
});

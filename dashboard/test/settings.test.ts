import { test } from "node:test";
import assert from "node:assert/strict";
import { generateConfig, parseSettings, type Settings } from "../src/model.js";

const BASE: Settings = {
  slots: 2, internet: false, project: "python", setupCommands: "uv sync",
  integrationCommands: "", reviewer: true, reviewerModel: "haiku", planModel: "",
  model: "", effort: "", maxRetries: 1, budgetUsd: "", manualApproval: false,
  prNative: false, webhookUrl: "", executionMode: "subscription", isolation: "direct",
  knowledge: false, verifyCommands: "", requireVerify: true, candidates: 1,
  reviewOnFailure: "hold",
};

test("the reliability settings survive a save/load round-trip", () => {
  const edited: Settings = {
    ...BASE, verifyCommands: "pytest -q, ruff check .", requireVerify: false,
    candidates: 3, reviewOnFailure: "reject",
  };
  const back = parseSettings(generateConfig(edited));
  assert.equal(back.verifyCommands, "pytest -q, ruff check .");
  assert.equal(back.requireVerify, false);
  assert.equal(back.candidates, 3);
  assert.equal(back.reviewOnFailure, "reject");
});

test("defaults are the safe ones when a config predates these keys", () => {
  const legacy = "concurrency:\n  max_slots: 2\nreview:\n  enabled: true\n";
  const s = parseSettings(legacy);
  assert.equal(s.requireVerify, true);
  assert.equal(s.candidates, 1);
  assert.equal(s.reviewOnFailure, "hold");
});

test("best-of-N is only written when it is on", () => {
  assert.doesNotMatch(generateConfig(BASE), /candidates:/);
  assert.match(generateConfig({ ...BASE, candidates: 2 }), /^ {2}candidates: 2$/m);
});

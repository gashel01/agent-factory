import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCapsule, extractConsents, parseVerdict, lineDiff, capsuleDiff } from "../src/capsule-core.js";

test("extractCapsule: fenced json", () => {
  const c = extractCapsule('here you go:\n```json\n{"version":1,"name":"X","actions":[]}\n```\nthanks');
  assert.equal(c?.version, 1);
  assert.equal(c?.name, "X");
});

test("extractCapsule: bare object with surrounding prose", () => {
  const c = extractCapsule('sure — {"version":1,"actions":[{"id":"a","label":"A","steps":[]}]} done');
  assert.equal(c?.actions.length, 1);
});

test("extractCapsule: rejects missing version/actions and junk", () => {
  assert.equal(extractCapsule('{"name":"no version"}'), null);
  assert.equal(extractCapsule('{"version":1}'), null); // no actions array
  assert.equal(extractCapsule("not json at all"), null);
});

test("extractConsents: array in a fence", () => {
  const arr = extractConsents('```json\n[{"id":"go","title":"Go","facts":{}}]\n```');
  assert.equal(arr?.length, 1);
  assert.equal(arr?.[0]?.id, "go");
});

test("extractConsents: rejects malformed entries and non-arrays", () => {
  assert.equal(extractConsents('[{"title":"no id or facts"}]'), null);
  assert.equal(extractConsents('{"id":"x","facts":{}}'), null); // object, not array
});

test("parseVerdict: pass with confidence + reasons", () => {
  const v = parseVerdict('```json\n{"verdict":"pass","confidence":0.9,"reasons":["ok"]}\n```');
  assert.equal(v?.verdict, "pass");
  assert.equal(v?.confidence, 0.9);
  assert.deepEqual(v?.reasons, ["ok"]);
});

test("parseVerdict: defaults confidence to 0.5, tolerates missing reasons", () => {
  const v = parseVerdict('{"verdict":"fail"}');
  assert.equal(v?.verdict, "fail");
  assert.equal(v?.confidence, 0.5);
  assert.deepEqual(v?.reasons, []);
});

test("parseVerdict: rejects a non-verdict", () => {
  assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseVerdict("no json"), null);
});

test("lineDiff: identical → all context", () => {
  const d = lineDiff(["a", "b"], ["a", "b"]);
  assert.deepEqual(d.map((l) => l.t), ["ctx", "ctx"]);
});

test("lineDiff: one insertion", () => {
  const d = lineDiff(["a", "c"], ["a", "b", "c"]);
  assert.equal(d.filter((l) => l.t === "add").length, 1);
  assert.equal(d.find((l) => l.t === "add")?.s, "b");
  assert.equal(d.filter((l) => l.t === "del").length, 0);
});

test("lineDiff: one deletion", () => {
  const d = lineDiff(["a", "b", "c"], ["a", "c"]);
  assert.equal(d.filter((l) => l.t === "del").length, 1);
  assert.equal(d.find((l) => l.t === "del")?.s, "b");
});

test("capsuleDiff: null base → everything added", () => {
  const d = capsuleDiff(null, { version: 1, name: "N", actions: [] });
  assert.ok(d.length > 0);
  assert.ok(d.every((l) => l.t === "add"));
});

test("capsuleDiff: a rename shows add + del, keeps context", () => {
  const base = { version: 1 as const, name: "Old", actions: [] };
  const next = { version: 1 as const, name: "New", actions: [] };
  const d = capsuleDiff(base, next);
  assert.ok(d.some((l) => l.t === "add" && l.s.includes("New")));
  assert.ok(d.some((l) => l.t === "del" && l.s.includes("Old")));
  assert.ok(d.some((l) => l.t === "ctx"));
});

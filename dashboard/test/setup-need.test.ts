// The "add a dependency install to setup" warning must follow what the project
// really uses — not the starter factory.yaml, which lists every toolchain.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSetupNeed } from "../src/insights.js";

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "warden-stack-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("a stdlib-only Python project needs no install", () => {
  const repo = repoWith({ ".gitignore": ".factory/\n" });
  try {
    assert.equal(detectSetupNeed(repo, ["python -m unittest -v"]).needed, false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("node checks or a package.json with deps ask for npm", () => {
  assert.deepEqual(detectSetupNeed(null, ["npm test"]), { needed: true, command: "npm install", reason: "node" });
  const repo = repoWith({ "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }), "package-lock.json": "{}" });
  try {
    assert.equal(detectSetupNeed(repo, []).command, "npm ci");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("npm test on a zero-dependency package needs no install", () => {
  // Seen live: the plan verified with `npm test` on a package.json with
  // no dependencies, and the run sheet wrongly asked to add npm install.
  const repo = repoWith({ "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }) });
  try {
    assert.equal(detectSetupNeed(repo, ["npm test", "node --test test/a.test.js"]).needed, false);
    assert.equal(detectSetupNeed(repo, ["npx vitest run"]).needed, true, "a third-party tool still needs it");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("third-party Python tooling asks for uv sync", () => {
  assert.equal(detectSetupNeed(null, ["pytest -q"]).command, "uv sync");
});

#!/usr/bin/env node
// Discovers and runs every dashboard/test/*.test.ts.
//
// Why a script instead of an npm one-liner: the previous "test" script hard-coded a
// single entry point, so any new test file was silently never run. Shell globs are not
// an option either — npm scripts go through cmd.exe on Windows, which does not expand
// them. So we read the directory ourselves and drive esbuild through its JS API.
//
// Node built-ins + esbuild (already a devDependency) only — the dashboard adds no deps.

import { readdirSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

// Anchor on this file, not process.cwd(): the script must behave the same whether it is
// invoked via `npm --prefix dashboard test` or from inside dashboard/.
const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(dashboardDir, "test");
const outDir = path.join(dashboardDir, "dist", "test");

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort();

if (testFiles.length === 0) {
  // Exiting 0 here would let an empty (or mis-pointed) test dir masquerade as a pass.
  console.error(`No *.test.ts files found in ${path.relative(dashboardDir, testDir)}`);
  process.exit(1);
}

console.log(`Discovered ${testFiles.length} test file(s): ${testFiles.join(", ")}`);

// Wipe the output dir so bundles of deleted test files can never be re-run.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const bundles = [];
for (const name of testFiles) {
  const outfile = path.join(outDir, `${name.replace(/\.ts$/, "")}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(testDir, name)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  bundles.push(outfile);
}

// Pass the bundles explicitly rather than letting `node --test` walk dist/: directory
// discovery would also pick up stale or non-test artifacts sitting in the build output.
const result = spawnSync(process.execPath, ["--test", ...bundles], {
  cwd: dashboardDir,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
// A signal-killed runner reports status === null; treat that as a failure, not a pass.
process.exit(result.status ?? 1);

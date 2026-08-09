// Test runner for dashboard/test/*.test.ts.
//
// Why a script instead of an inline npm command: the test list must not live in
// package.json. Tickets add new test files without touching package.json, so the
// runner discovers them itself. Each file is bundled separately (esbuild JS API,
// no CLI) then handed to node:test in one child process.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the dashboard root from this file, not from cwd: the script is run as
// `npm --prefix dashboard test` from the repo root, and also directly.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "test");
const outDir = join(root, "dist", "test");

const names = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

if (names.length === 0) {
  console.log(`No test files found in ${testDir} — nothing to run.`);
  process.exit(0);
}

// Stale bundles from a since-deleted test would otherwise keep being executed.
rmSync(outDir, { recursive: true, force: true });

const outfiles = [];
for (const name of names) {
  const outfile = join(outDir, `${name.replace(/\.ts$/, "")}.mjs`);
  try {
    await build({
      entryPoints: [join(testDir, name)],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      sourcemap: "inline",
      logLevel: "silent",
    });
  } catch (err) {
    console.error(`Failed to bundle test/${name}:`);
    console.error(err?.message ?? err);
    process.exit(1);
  }
  outfiles.push(outfile);
}

console.log(`Running ${outfiles.length} test file(s): ${names.join(", ")}`);

const child = spawn(process.execPath, ["--test", ...outfiles], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (err) => {
  console.error(`Failed to spawn node --test: ${err.message}`);
  process.exit(1);
});

/* Extracted from server.ts — mechanical split (pure move + import/export wiring). */

import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync, createReadStream, existsSync, mkdirSync,
  readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";


/* ------------------------------ Docker sandbox preflight ------------------------------ */

// Docker is host-global (not per-workspace), so its readiness + the in-progress
// image build live at module scope. The cockpit polls /api/docker while the
// Sandbox toggle is on; POST /api/docker/build kicks the (slow) image build.
export const sbxBuild: { running: boolean; log: string; ok: boolean | null } = {
  running: false, log: "", ok: null,
};


/** Ask the factory for machine-readable sandbox readiness (one-shot subprocess). */
export function dockerPreflight(factory: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const [cmd, ...prefix] = factory;
    const child = spawn(cmd!, [...prefix, "sandbox-preflight"], {
      shell: false, windowsHide: true, env: process.env,
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf-8")));
    child.on("error", () =>
      resolve({ engine: false, image: false, proxy: false, ready: false,
                detail: "could not run factory sandbox-preflight" }));
    child.on("exit", () => {
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        resolve({ engine: false, image: false, proxy: false, ready: false,
                  detail: "unreadable preflight output" });
      }
    });
  });
}


/** Ask the factory for the repo's oversized-file hotspots (one-shot subprocess,
 *  deterministic — no agent, no tokens). Failures degrade to an empty list so a
 *  missing/odd repo never breaks the screen that shows the advisory. */
export function hotspotsScan(factory: string[], repo: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const [cmd, ...prefix] = factory;
    const child = spawn(cmd!, [...prefix, "hotspots", "--repo", repo, "--json"], {
      shell: false, windowsHide: true, env: process.env,
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf-8")));
    child.on("error", () => resolve({ hotspots: [] }));
    child.on("exit", () => {
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        resolve({ hotspots: [] });
      }
    });
  });
}


/** Build the sandbox images in the background, streaming into sbxBuild.log. */
export function startDockerBuild(factory: string[]): void {
  if (sbxBuild.running) return;
  sbxBuild.running = true; sbxBuild.log = ""; sbxBuild.ok = null;
  const [cmd, ...prefix] = factory;
  const child = spawn(cmd!, [...prefix, "sandbox-build"], {
    shell: false, windowsHide: true, env: process.env,
  });
  const append = (c: Buffer) => { sbxBuild.log = (sbxBuild.log + c.toString("utf-8")).slice(-8000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (err) => { sbxBuild.running = false; sbxBuild.ok = false; sbxBuild.log += `\n${String(err)}`; });
  child.on("exit", (code) => { sbxBuild.running = false; sbxBuild.ok = code === 0; });
}


/* ------------------------------ subscription plan usage ------------------------------ */

// The full plan-usage breakdown (5h session %, weekly %, per-model) that Claude Code's
// interactive /usage shows. Headless `claude -p` doesn't stream it, but the same data
// is served by an OAuth endpoint the CLI itself calls. We read the logged-in
// subscription token from ~/.claude/.credentials.json (server-side — it never reaches
// the browser) and proxy it, cached briefly since that endpoint is itself rate-limited.
// NOTE: undocumented endpoint; Anthropic may change it without notice.
export let usageCache: { at: number; data: unknown } | null = null;

// Persist the last good snapshot to disk so a server restart — or a long 429 window
// on this fragile endpoint — never blanks the bars. Loaded lazily on first use.
export const USAGE_CACHE_FILE = join(homedir(), ".claude", ".agent-factory-usage.json");

export function loadUsageCache(): void {
  if (usageCache) return;
  try { usageCache = JSON.parse(readFileSync(USAGE_CACHE_FILE, "utf-8")); } catch { /* none yet */ }
}

export function saveUsageCache(): void {
  try { writeFileSync(USAGE_CACHE_FILE, JSON.stringify(usageCache)); } catch { /* best effort */ }
}

export async function subscriptionUsage(): Promise<unknown> {
  loadUsageCache();
  // Serve fresh cache without touching the (itself rate-limited) endpoint.
  if (usageCache && Date.now() - usageCache.at < 120_000) return usageCache.data;
  // On ANY failure (esp. the 429 this endpoint hands out freely), keep showing the
  // last good data rather than blanking the bars — only report an error if we've
  // never succeeded.
  const fallback = (err: unknown): unknown => usageCache?.data ?? { error: String(err).slice(0, 60) };
  let token: string | undefined;
  try {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8");
    token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } })?.claudeAiOauth?.accessToken;
  } catch { /* no credentials file */ }
  if (!token) return usageCache?.data ?? { error: "not-logged-in" };
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallback(`http-${res.status}`);
    const data = await res.json();
    usageCache = { at: Date.now(), data };
    saveUsageCache();
    return data;
  } catch (err) {
    return fallback(err);
  }
}


/** Best-effort probe of the underlying coding-agent CLI version, so the cockpit
 *  can surface "which Claude Code am I driving". Probed once and cached for the
 *  server's life; resolves null if the CLI isn't on PATH (chip stays hidden).
 *  Uses `shell: true` so a Windows `claude.cmd` shim resolves like the binary. */
export let agentVersionProbe: Promise<string | null> | null = null;

export function agentVersion(): Promise<string | null> {
  if (agentVersionProbe) return agentVersionProbe;
  agentVersionProbe = new Promise<string | null>((r) => {
    let out = "";
    let c: ChildProcess;
    try {
      c = spawn("claude", ["--version"], { shell: true, windowsHide: true });
    } catch {
      r(null);
      return;
    }
    const timer = setTimeout(() => { try { c.kill(); } catch { /* gone */ } r(null); }, 5000);
    c.stdout?.on("data", (d) => { out += String(d); });
    c.on("error", () => { clearTimeout(timer); r(null); });
    c.on("exit", () => {
      clearTimeout(timer);
      const m = out.match(/\d+\.\d+\.\d+/);
      r(m ? m[0] : (out.trim() || null));
    });
  });
  return agentVersionProbe;
}

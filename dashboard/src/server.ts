/**
 * agent-factory dashboard server — zero runtime dependencies (node:http + node:fs).
 *
 * Manages one or more WORKSPACES (a directory holding factory.yaml, backlog/ and
 * runs/). Per workspace it: reads the dispatcher's append-only events.jsonl and
 * streams it over SSE; writes operator commands to control.jsonl (the dispatcher
 * polls it) — one writer per file, in each direction; and launches `factory plan`
 * / `factory run` as child processes so the whole workflow runs from the browser.
 *
 * The workspace registry lives in workspaces.json next to the server's initial
 * --workdir. Cross-platform by construction: file growth is detected by polling
 * size+offset (fs.watch is unreliable for appends on Windows network/temp paths).
 *
 * The HTTP router is split into route-group handlers (server-routes-*.ts). This
 * file owns process wiring: parseArgs, the workspace registry, the tailer poll
 * loop, the auth gate, the static routes, workspace resolution, and the 404.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { json, latestRun, parseArgs, readOrCreateToken, Registry } from "./server-core.js";
import {
  composeStall, composeStandup, composeWrapup, STALL_MS, STANDUP_MS,
} from "./server-companion.js";
import type { RouteCtx, WsRouteCtx } from "./server-routes.js";
import { handleSystemRoutes } from "./server-routes-system.js";
import { handleRepoRoutes } from "./server-routes-repo.js";
import { handleMemoryRoutes } from "./server-routes-memory.js";
import { handleRunRoutes } from "./server-routes-run.js";
import { handlePreviewRoutes } from "./server-routes-preview.js";

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = resolve(here, "..", "public");

  const registry = new Registry(join(opts.workdir, "workspaces.json"));
  registry.load(opts.workdir);

  // Auth: the server binds the LAN (--host 0.0.0.0) for the phone flow, and many
  // endpoints run agents / mutate the repo / spend tokens. Gate every mutation
  // (POST/DELETE) behind a per-install secret; GET stays open (the board is
  // viewable and the phone can download the APK without a token). The operator
  // opens the dashboard once with ?token=… (printed below) — it's then stored.
  const token = readOrCreateToken(join(opts.workdir, ".dashboard-token"));

  // Global (cross-project) learned facts live next to the registry; project-scoped
  // facts live in each workspace's own memory.json.
  const globalMemFile = join(opts.workdir, "memory.global.json");

  setInterval(() => {
    for (const ws of registry.workspaces.values()) {
      const newest = latestRun(ws.tailer.runsDir);
      if (newest && newest !== ws.tailer.run) ws.tailer.switchTo(newest);
      ws.tailer.poll();
      const t = ws.tailer;
      const pending = t.pendingWrapup;
      if (pending) {
        t.pendingWrapup = null;
        composeWrapup(ws, opts.factory, pending.run, pending.counts);
      }
      // Stall: a live run has gone quiet while work is in flight. Fire once per
      // quiet period (anchored on lastEventAt, which a new event would bump).
      if (t.run && !t.runEnded && t.activeTasks.size > 0 && t.lastEventAt > 0
          && Date.now() - t.lastEventAt > STALL_MS && t.lastStallBriefFor !== t.lastEventAt) {
        t.lastStallBriefFor = t.lastEventAt;
        composeStall(ws, opts.factory, t.run, t.lastEventAt, t.activeTasks.size);
      }
      // Periodic stand-up: only when someone is watching and real progress has
      // landed since the last one — so we never spend on a vacuous or unseen one.
      if (t.run && !t.runEnded && t.activeTasks.size > 0 && t.clients.size > 0
          && t.progressSinceStandup > 0 && t.lastStandupAt > 0
          && Date.now() - t.lastStandupAt >= STANDUP_MS) {
        t.lastStandupAt = Date.now();
        t.progressSinceStandup = 0;
        composeStandup(ws, opts.factory, t.run, ++t.standupCount);
      }
    }
  }, 500);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Gate mutations: any POST/DELETE to /api needs the token (header or query).
    // GETs stay open (viewing + phone APK download need no secret).
    if ((req.method === "POST" || req.method === "DELETE") && url.pathname.startsWith("/api/")
        && url.searchParams.get("token") !== token && req.headers["x-factory-token"] !== token) {
      json(res, 401, { ok: false, error: "unauthorized — open the dashboard with the ?token= shown in the server console" });
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store", // dev tool: a plain refresh must always be current
      });
      res.end(readFileSync(join(publicDir, "index.html")));
      return;
    }
    if (url.pathname === "/client.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(readFileSync(join(here, "client.js")));
      return;
    }
    if (url.pathname === "/style.css") {
      res.writeHead(200, {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "no-store",
      });
      // Served from ordered partials in public/css (numeric-prefixed, so a plain
      // sort reproduces the original cascade order). Concatenated at request time
      // — no build step, byte-identical to the former single style.css.
      const cssDir = join(publicDir, "css");
      const parts = readdirSync(cssDir).filter((f) => f.endsWith(".css")).sort();
      res.end(Buffer.concat(parts.map((f) => readFileSync(join(cssDir, f)))));
      return;
    }

    const base: RouteCtx = { req, res, url, registry, opts, token, publicDir, here, globalMemFile };

    // Workspace-independent groups first.
    if (await handleSystemRoutes(base)) return;
    if (await handleRepoRoutes(base)) return;

    /* ---------------- everything below is per-workspace (?ws=) ---------------- */

    const ws = registry.resolve(url);
    if (!ws) {
      json(res, 404, { ok: false, error: "unknown workspace" });
      return;
    }
    const wsCtx: WsRouteCtx = { ...base, ws };

    if (await handleMemoryRoutes(wsCtx)) return;
    if (await handleRunRoutes(wsCtx)) return;
    if (await handlePreviewRoutes(wsCtx)) return;

    res.writeHead(404).end("not found");
  });

  server.listen(opts.port, opts.host, () => {
    console.log(
      `dashboard: http://${opts.host}:${opts.port}  ` +
        `(${registry.workspaces.size} workspace(s), registry: ${registry.file})`,
    );
    console.log(`open:      http://localhost:${opts.port}/?token=${token}`);
  });
}

main();

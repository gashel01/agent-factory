/**
 * The dashboard server, as a value: createDashboardServer() wires the workspace
 * registry, the tailer poll loop, the request gates (Host, auth, body size), the
 * static routes and the route groups into an http.Server that is NOT yet
 * listening. server.ts (the CLI) listens on it and owns process-level concerns
 * (signals, crash handlers); the route tests start it on an ephemeral port.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allowedHosts, hostOf, isLoopbackHost, json, latestRun, MAX_BODY_BYTES, readOrCreateToken, Registry,
  sendError, tokenMatches,
} from "./server-core.js";
import type { Options } from "./server-core.js";
import {
  composeStall, composeStandup, composeWrapup, STALL_MS, STANDUP_MS,
} from "./server-companion.js";
import type { RouteCtx, WsRouteCtx } from "./server-routes.js";
import { handleSystemRoutes } from "./server-routes-system.js";
import { handleRepoRoutes } from "./server-routes-repo.js";
import { handleMemoryRoutes } from "./server-routes-memory.js";
import { handleRunRoutes } from "./server-routes-run.js";
import { handleLoopRoutes } from "./server-routes-loop.js";
import { handleBacklogRoutes } from "./server-routes-backlog.js";
import { handleArchitectureRoutes } from "./server-routes-architecture.js";
import { handlePreviewRoutes } from "./server-routes-preview.js";
import { killWorkspaceChildren } from "./server-preview.js";

/** How often the tailers look for new events.jsonl lines (and new runs). */
const TAIL_POLL_MS = 500;

/** Methods that never mutate: open on loopback, token-gated on the LAN. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** GETs that stay open even when bound to the LAN: a phone scanning the
 *  "install on a device" QR downloads the built APK with no token in hand. */
const PUBLIC_API_GETS = new Set(["/api/capsule/artifact"]);

export interface DashboardServer {
  server: Server;
  registry: Registry;
  token: string;
  /** Stop the poll loop and kill every child process the workspaces track. */
  shutdown(): void;
}

export function createDashboardServer(
  opts: Options,
  paths: { here?: string; publicDir?: string } = {},
): DashboardServer {
  const here = paths.here ?? dirname(fileURLToPath(import.meta.url));
  const publicDir = paths.publicDir ?? resolve(here, "..", "public");

  const registry = new Registry(join(opts.workdir, "workspaces.json"));
  registry.load(opts.workdir);

  // Auth: the server can bind the LAN (--host 0.0.0.0) for the phone flow, and
  // many endpoints run agents / mutate the repo / spend tokens. Every mutation
  // (any method but GET/HEAD/OPTIONS) needs a per-install secret. On loopback
  // GETs stay open; bound to the LAN they need it too — except the APK download
  // (see PUBLIC_API_GETS). The operator opens the dashboard once with ?token=…
  // (printed at startup) — it's then stored; the phone QR carries it.
  const token = readOrCreateToken(join(opts.workdir, ".dashboard-token"));
  const lanBound = !isLoopbackHost(opts.host);
  const hosts = allowedHosts(opts.host);

  // Global (cross-project) learned facts live next to the registry; project-scoped
  // facts live in each workspace's own memory.json.
  const globalMemFile = join(opts.workdir, "memory.global.json");

  const poller = setInterval(() => {
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
  }, TAIL_POLL_MS);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Anti DNS-rebinding: a foreign page whose DNS now points at us still sends
    // its own hostname. Checked before anything else, static routes included.
    if (!hosts.has(hostOf(req.headers.host))) {
      json(res, 403, { ok: false, error: "forbidden host" });
      return;
    }
    // The base is a placeholder: only the path and query are ever read.
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname.startsWith("/api/")) {
      const needsToken = !SAFE_METHODS.has(req.method ?? "GET")
        || (lanBound && !PUBLIC_API_GETS.has(url.pathname));
      // The header is what fetch() sends; ?token= remains for EventSource, <img>
      // and window.open, which cannot set headers.
      const header = req.headers["x-factory-token"];
      if (needsToken && !tokenMatches(typeof header === "string" ? header : url.searchParams.get("token"), token)) {
        json(res, 401, { ok: false, error: "unauthorized — open the dashboard with the ?token= shown in the server console" });
        return;
      }
      // Refuse an oversized body up front when it is announced; readBody still
      // enforces the same ceiling on a chunked (unannounced) one.
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
        res.setHeader("connection", "close");
        json(res, 413, { ok: false, error: `request body too large (max ${MAX_BODY_BYTES} bytes)` });
        return;
      }
    }

    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store", // dev tool: a plain refresh must always be current
      });
      res.end(readFileSync(join(publicDir, "next.html")));
      return;
    }
    // The interface lived at /next while the classic one was retired; keep old
    // bookmarks (and their #/route) working.
    if (url.pathname === "/next" || url.pathname === "/next/") {
      res.writeHead(301, { location: "/" + url.search });
      res.end();
      return;
    }
    if (url.pathname === "/next.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(join(here, "next.js")));
      return;
    }
    if (url.pathname === "/next.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      const nextCss = join(publicDir, "next");
      const parts = readdirSync(nextCss).filter((f) => f.endsWith(".css")).sort();
      res.end(Buffer.concat(parts.map((f) => readFileSync(join(nextCss, f)))));
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
    if (await handleLoopRoutes(wsCtx)) return;
    if (await handleBacklogRoutes(wsCtx)) return;
    if (await handleArchitectureRoutes(wsCtx)) return;
    if (await handlePreviewRoutes(wsCtx)) return;

    res.writeHead(404).end("not found");
  }

  const server = createServer((req, res) => {
    // One failing handler must never take the process (and every run it
    // supervises) down: answer 500 — or the route's own HttpError status — and
    // keep serving.
    handle(req, res).catch((err: unknown) => {
      console.error(`dashboard: ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendError(res, err, 500);
      else res.end();
    });
  });

  return {
    server,
    registry,
    token,
    shutdown(): void {
      clearInterval(poller);
      for (const ws of registry.workspaces.values()) killWorkspaceChildren(ws);
    },
  };
}

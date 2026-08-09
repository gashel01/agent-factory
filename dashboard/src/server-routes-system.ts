/* Extracted from server.ts — mechanical split. Workspace-independent "system"
 * routes: workspace registry management, host info, usage, Docker, hotspots,
 * portfolio. Runs before per-workspace resolution. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { json, lanIPv4, portfolioCounts, readBody, SAFE_WS, summarizeRun, workspaceRepo } from "./server-core.js";
import {
  dockerPreflight, hotspotsScan, sbxBuild, startDockerBuild, subscriptionUsage,
} from "./server-usage.js";
import { excludeLocally, starterFactoryYaml } from "./server-preview.js";
import type { RouteCtx } from "./server-routes.js";

export async function handleSystemRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, registry, opts } = ctx;

  if (url.pathname === "/api/workspaces" && req.method === "GET") {
    json(res, 200, {
      workspaces: [...registry.workspaces.values()].map((ws) => ({
        name: ws.name,
        workdir: ws.workdir,
        repo: workspaceRepo(ws),
        currentRun: ws.tailer.run,
      })),
    });
    return true;
  }
  if (url.pathname === "/api/netinfo" && req.method === "GET") {
    const ip = lanIPv4();
    json(res, 200, {
      ip,
      port: opts.port,
      url: ip ? `http://${ip}:${opts.port}` : null,
    });
    return true;
  }
  if (url.pathname === "/api/usage" && req.method === "GET") {
    json(res, 200, await subscriptionUsage());
    return true;
  }
  if (url.pathname === "/api/docker" && req.method === "GET") {
    const pf = await dockerPreflight(opts.factory);
    json(res, 200, { ...pf, building: sbxBuild.running, buildOk: sbxBuild.ok,
                     buildLog: sbxBuild.log.slice(-4000) });
    return true;
  }
  if (url.pathname === "/api/docker/build" && req.method === "POST") {
    if (sbxBuild.running) { json(res, 409, { ok: false, error: "a build is already running" }); return true; }
    startDockerBuild(opts.factory);
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/hotspots" && req.method === "GET") {
    const repo = url.searchParams.get("repo");
    if (!repo) { json(res, 400, { hotspots: [], error: "repo is required" }); return true; }
    json(res, 200, await hotspotsScan(opts.factory, repo));
    return true;
  }
  if (url.pathname === "/api/portfolio" && req.method === "GET") {
    json(res, 200, {
      projects: [...registry.workspaces.values()].map((ws) => {
        const live = ws.jobs.run.state === "running" || ws.jobs.loop.state === "running";
        // summarizeRun for spend/tokens/budget/mode; portfolioCounts for the
        // board-accurate, cumulative, ghost-free counts (merged across all runs,
        // in-flight dropped when nothing is live).
        const pc = portfolioCounts(ws.tailer.runsDir, ws.tailer.run, live);
        return {
          name: ws.name,
          workdir: ws.workdir,
          currentRun: ws.tailer.run,
          running: live,
          ...summarizeRun(ws.tailer.runsDir, ws.tailer.run),
          counts: pc.counts,
          total: pc.total,
        };
      }),
    });
    return true;
  }
  if (url.pathname === "/api/workspaces" && req.method === "POST") {
    try {
      const { name, workdir } = JSON.parse(await readBody(req)) as {
        name?: string;
        workdir?: string;
      };
      if (!name || !SAFE_WS.test(name)) throw new Error("bad workspace name");
      if (registry.workspaces.has(name)) throw new Error("name already exists");
      if (!workdir || !existsSync(workdir)) throw new Error("workdir does not exist");
      mkdirSync(join(workdir, "backlog"), { recursive: true });
      registry.register(name, workdir);
      registry.save();
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  // Create a NEW project: one repo, one dedicated workspace, fully isolated.
  // The workspace state (factory.yaml, backlog, runs, project-maps) lives in
  // <repo>/.factory so it travels with the code and can NEVER bleed into
  // another project the way a reused/shared workspace does.
  if (url.pathname === "/api/projects" && req.method === "POST") {
    try {
      const { repo, name } = JSON.parse(await readBody(req)) as { repo?: string; name?: string };
      if (!repo?.trim()) throw new Error("repository path is required");
      const repoDir = resolve(repo.trim());
      if (!existsSync(repoDir)) throw new Error("repository folder does not exist");
      const base =
        (name?.trim() || basename(repoDir)).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") ||
        "project";
      let wsName = base;
      for (let i = 2; registry.workspaces.has(wsName); i++) wsName = `${base}-${i}`;
      const workdir = join(repoDir, ".factory");
      mkdirSync(join(workdir, "backlog"), { recursive: true });
      const cfgPath = join(workdir, "factory.yaml");
      if (!existsSync(cfgPath)) writeFileSync(cfgPath, starterFactoryYaml(), "utf-8");
      excludeLocally(repoDir, ".factory/");
      registry.register(wsName, workdir, repoDir);
      registry.save();
      json(res, 200, { ok: true, name: wsName, workdir });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname.startsWith("/api/workspaces/") && req.method === "PUT") {
    try {
      const oldName = decodeURIComponent(url.pathname.slice("/api/workspaces/".length));
      const { name } = JSON.parse(await readBody(req)) as { name?: string };
      if (!registry.workspaces.has(oldName)) throw new Error("unknown workspace");
      if (!name || !SAFE_WS.test(name)) throw new Error("bad workspace name");
      if (name !== oldName) {
        if (registry.workspaces.has(name)) throw new Error("name already exists");
        registry.rename(oldName, name);
        registry.save();
      }
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname.startsWith("/api/workspaces/") && req.method === "DELETE") {
    const name = decodeURIComponent(url.pathname.slice("/api/workspaces/".length));
    if (registry.workspaces.size <= 1) {
      json(res, 400, { ok: false, error: "cannot remove the last workspace" });
      return true;
    }
    registry.workspaces.delete(name); // registry entry only; files stay on disk
    registry.save();
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

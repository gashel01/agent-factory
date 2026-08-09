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
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import type {
  FactoryEvent,
  Capsule, CapsuleAction, CapsuleConsent, CapsuleStep, CapsuleActionState, CapsuleView,
} from "./types.js";
import { type CompanionCtx, type ObsAction, type Observation, foldRun, newCtx, observe } from "./companion.js";
import { capsuleDiff, extractCapsule, extractConsents, parseVerdict } from "./capsule-core.js";

import {
  parseArgs, latestRun, summarizeRun, historyFor, RunTailer, workspaceRepo, SAFE_WS, Registry,
  spawnJob, askOneShot, runCmd, capsuleGrantsFile, loadGrants, saveGrants, loadHidden, saveHidden,
  readBody, readOrCreateToken, json, lanIPv4, SAFE_NAME, toPosix, stripAnsi, parsePlanQuestions,
} from "./server-core.js";
import type {
  Options, RunSummary, HistoryTicket, PlanQuestion, Job, Preview, CapsuleRun, ServiceRun,
  JudgeResult, CapsuleRuntime, Workspace,
} from "./server-core.js";
import {
  readApplied, readFacts, writeFacts, knowledgePaths, readDocs, writeDocs, scaffoldKnowledge,
  runRagmcp, MCP_CONFIG_LINE, setKnowledgeEnabled,
} from "./server-knowledge.js";
import type { Fact, KnowledgeDoc } from "./server-knowledge.js";
import {
  companionTimeline, briefInFlight, STALL_MS, STANDUP_MS, briefingsFile, pushCompanion, readBriefings,
  CONTROL_OPS, parseAnswer, spawnBriefing, composeWrapup, composeStall, composeStandup,
  chatHistoryFile, readChatHistory, appendChatMsg, chatObs, chatObservations,
} from "./server-companion.js";
import type { ChatMsg } from "./server-companion.js";
import {
  sbxBuild, dockerPreflight, hotspotsScan, startDockerBuild, usageCache, USAGE_CACHE_FILE,
  loadUsageCache, saveUsageCache, subscriptionUsage, agentVersionProbe, agentVersion,
} from "./server-usage.js";
import {
  detectPreview, killTree, stopPreview, LOCAL_URL, npmSpawn, startWebPreview, spawnDevServer, MIME,
  serveStatic, startStaticServer, startPreview, BOOTSTRAP_GITIGNORE, starterFactoryYaml, excludeLocally,
  capsuleFile, loadCapsule, capsuleEnv, spawnStep, LOOKS_LIKE_SERVICE, SERVER_READY, GUARD_GRACE_MS,
  runStep, runActionSteps, runCapsuleAction, runCapsuleConsent, stopService, startService, captureShell,
  capsuleDoctor, capsuleDevices, capsuleView, onboardingPrompt, generateCapsule, provisionPrompt,
  generateProvision, fixPrompt, generateFix, chatPrompt, generateCapsuleChat, chromeBin, screenshotUrl,
  judgeAction,
} from "./server-preview.js";

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
      res.end(readFileSync(join(publicDir, "style.css")));
      return;
    }

    /* ---------------- workspace management ---------------- */

    if (url.pathname === "/api/workspaces" && req.method === "GET") {
      json(res, 200, {
        workspaces: [...registry.workspaces.values()].map((ws) => ({
          name: ws.name,
          workdir: ws.workdir,
          repo: workspaceRepo(ws),
          currentRun: ws.tailer.run,
        })),
      });
      return;
    }
    if (url.pathname === "/api/netinfo" && req.method === "GET") {
      const ip = lanIPv4();
      json(res, 200, {
        ip,
        port: opts.port,
        url: ip ? `http://${ip}:${opts.port}` : null,
      });
      return;
    }
    if (url.pathname === "/api/usage" && req.method === "GET") {
      json(res, 200, await subscriptionUsage());
      return;
    }
    if (url.pathname === "/api/docker" && req.method === "GET") {
      const pf = await dockerPreflight(opts.factory);
      json(res, 200, { ...pf, building: sbxBuild.running, buildOk: sbxBuild.ok,
                       buildLog: sbxBuild.log.slice(-4000) });
      return;
    }
    if (url.pathname === "/api/docker/build" && req.method === "POST") {
      if (sbxBuild.running) { json(res, 409, { ok: false, error: "a build is already running" }); return; }
      startDockerBuild(opts.factory);
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/hotspots" && req.method === "GET") {
      const repo = url.searchParams.get("repo");
      if (!repo) { json(res, 400, { hotspots: [], error: "repo is required" }); return; }
      json(res, 200, await hotspotsScan(opts.factory, repo));
      return;
    }
    if (url.pathname === "/api/portfolio" && req.method === "GET") {
      json(res, 200, {
        projects: [...registry.workspaces.values()].map((ws) => ({
          name: ws.name,
          workdir: ws.workdir,
          currentRun: ws.tailer.run,
          running: ws.jobs.run.state === "running",
          ...summarizeRun(ws.tailer.runsDir, ws.tailer.run),
        })),
      });
      return;
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
      return;
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
      return;
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
      return;
    }
    if (url.pathname.startsWith("/api/workspaces/") && req.method === "DELETE") {
      const name = decodeURIComponent(url.pathname.slice("/api/workspaces/".length));
      if (registry.workspaces.size <= 1) {
        json(res, 400, { ok: false, error: "cannot remove the last workspace" });
        return;
      }
      registry.workspaces.delete(name); // registry entry only; files stay on disk
      registry.save();
      json(res, 200, { ok: true });
      return;
    }

    /* ---------------- repo tools (path-based, workspace-independent) ---------------- */

    if (url.pathname === "/api/repo/init" && req.method === "POST") {
      try {
        const { path } = JSON.parse(await readBody(req)) as { path?: string };
        if (!path?.trim()) throw new Error("path is required");
        const dir = resolve(path.trim());
        if (existsSync(join(dir, ".git"))) throw new Error("already a git repository");
        mkdirSync(dir, { recursive: true });
        const init = await runCmd("git", ["init", "-b", "main"], dir);
        if (init.code !== 0) throw new Error(init.output.trim());
        if (!existsSync(join(dir, ".gitignore"))) {
          writeFileSync(join(dir, ".gitignore"), BOOTSTRAP_GITIGNORE, "utf-8");
        }
        await runCmd("git", ["add", "-A"], dir);
        const commit = await runCmd(
          "git",
          ["commit", "-m", "chore: initial commit (agent-factory bootstrap)"],
          dir,
        );
        if (commit.code !== 0) throw new Error(commit.output.trim());
        json(res, 200, { ok: true, output: `initialized ${dir} on branch main` });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/repo/publish" && req.method === "POST") {
      try {
        const { path, visibility } = JSON.parse(await readBody(req)) as {
          path?: string;
          visibility?: string;
        };
        if (!path?.trim() || !existsSync(join(resolve(path.trim()), ".git"))) {
          throw new Error("path must be an existing git repository");
        }
        if (visibility !== "private" && visibility !== "public") {
          throw new Error("visibility must be private or public");
        }
        const dir = resolve(path.trim());
        const result = await runCmd(
          "gh",
          ["repo", "create", basename(dir), `--${visibility}`, "--source=.", "--push"],
          dir,
        );
        if (result.code !== 0) throw new Error(result.output.trim() || "gh failed — is it installed and logged in?");
        json(res, 200, { ok: true, output: result.output.trim() });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/repo/visibility" && req.method === "POST") {
      try {
        const { path, visibility } = JSON.parse(await readBody(req)) as {
          path?: string;
          visibility?: string;
        };
        if (!path?.trim() || !existsSync(join(resolve(path.trim()), ".git"))) {
          throw new Error("path must be an existing git repository");
        }
        if (visibility !== "private" && visibility !== "public") {
          throw new Error("visibility must be private or public");
        }
        const dir = resolve(path.trim());
        // Newer gh requires an explicit consent flag for visibility changes;
        // older gh rejects it as unknown — try with, fall back without.
        let result = await runCmd(
          "gh",
          ["repo", "edit", "--visibility", visibility, "--accept-visibility-change-consequences"],
          dir,
        );
        if (result.code !== 0 && /unknown flag/i.test(result.output)) {
          result = await runCmd("gh", ["repo", "edit", "--visibility", visibility], dir);
        }
        if (result.code !== 0) throw new Error(result.output.trim() || "gh failed — is it installed and logged in?");
        json(res, 200, { ok: true, output: result.output.trim() || `repository is now ${visibility}` });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    /* ---------------- repo explorer (read-only git views + guarded switch) ---------------- */

    if (url.pathname.startsWith("/api/repo/") && req.method === "GET") {
      const repo = resolve(url.searchParams.get("repo") ?? "");
      if (!repo || !existsSync(join(repo, ".git"))) {
        json(res, 400, { ok: false, error: "repo must be an existing git repository" });
        return;
      }
      const ref = url.searchParams.get("ref") ?? "HEAD";
      if (!/^[\w./@^~-]+$/.test(ref)) {
        json(res, 400, { ok: false, error: "bad ref" });
        return;
      }

      if (url.pathname === "/api/repo/tree") {
        const result = await runCmd("git", ["ls-tree", "-r", "--name-only", ref], repo);
        if (result.code !== 0) {
          json(res, 400, { ok: false, error: result.output.trim() });
          return;
        }
        json(res, 200, { files: result.output.split("\n").filter(Boolean) });
        return;
      }
      if (url.pathname === "/api/repo/file") {
        const file = url.searchParams.get("path") ?? "";
        if (!file || file.includes("..")) {
          json(res, 400, { ok: false, error: "bad path" });
          return;
        }
        const result = await runCmd("git", ["show", `${ref}:${file}`], repo);
        if (result.code !== 0) {
          json(res, 404, { ok: false, error: result.output.trim() });
          return;
        }
        json(res, 200, { content: result.output.slice(0, 200_000), path: file });
        return;
      }
      if (url.pathname === "/api/repo/branches") {
        const branches = await runCmd("git", ["branch", "--format=%(refname:short)"], repo);
        const current = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo);
        json(res, 200, {
          branches: branches.output.split("\n").filter(Boolean),
          current: current.output.trim(),
        });
        return;
      }
      if (url.pathname === "/api/repo/log") {
        const result = await runCmd(
          "git",
          ["log", "--format=%h%x09%ad%x09%an%x09%s", "--date=relative", "-n", "60", ref],
          repo,
        );
        const commits = result.output
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [hash, date, author, ...subject] = line.split("\t");
            return { hash, date, author, subject: subject.join("\t") };
          });
        json(res, 200, { commits });
        return;
      }
      if (url.pathname === "/api/repo/diff") {
        // ?commit=<hash> shows one commit; ?from=&to= compares two refs
        const commit = url.searchParams.get("commit");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        let args: string[];
        if (commit && /^[\w^~]+$/.test(commit)) {
          args = ["show", commit, "--stat", "--patch"];
        } else if (from && to && /^[\w./@^~-]+$/.test(from) && /^[\w./@^~-]+$/.test(to)) {
          args = ["diff", `${from}..${to}`, "--stat", "--patch"];
        } else {
          json(res, 400, { ok: false, error: "pass ?commit= or ?from=&to=" });
          return;
        }
        const result = await runCmd("git", args, repo);
        json(res, 200, { diff: result.output.slice(0, 400_000) });
        return;
      }
    }

    if (url.pathname === "/api/repo/switch" && req.method === "POST") {
      try {
        const { path, branch } = JSON.parse(await readBody(req)) as {
          path?: string;
          branch?: string;
        };
        const repo = resolve(path ?? "");
        if (!repo || !existsSync(join(repo, ".git"))) {
          throw new Error("repo must be an existing git repository");
        }
        if (!branch || !/^[\w./-]+$/.test(branch)) throw new Error("bad branch name");
        // A run's merge queue targets the checked-out branch: never switch mid-run.
        const running = [...registry.workspaces.values()].some(
          (w) => w.jobs.run.state === "running",
        );
        if (running) throw new Error("refusing to switch branches while a run is in progress");
        const result = await runCmd("git", ["switch", branch], repo);
        if (result.code !== 0) throw new Error(result.output.trim());
        json(res, 200, { ok: true, output: `now on ${branch}` });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    /* ---------------- everything below is per-workspace (?ws=) ---------------- */

    const ws = registry.resolve(url);
    if (!ws) {
      json(res, 404, { ok: false, error: "unknown workspace" });
      return;
    }
    // The repo belongs to the PROJECT (like /api/plan does as a side-effect):
    // persist it so it survives reloads, browser switches and the phone. Settings
    // is the one place a project's repo path is set without drafting work.
    if (url.pathname === "/api/repo/path" && req.method === "POST") {
      try {
        const { path } = JSON.parse(await readBody(req)) as { path?: string };
        ws.repo = path?.trim() ? resolve(path.trim()) : null;
        registry.save();
        json(res, 200, { ok: true, repo: ws.repo });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/companion" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 400, 1000);
      // Event-derived observations + persisted LLM briefings, merged by time.
      // The sort is stable, so a briefing settles right after the same-ts events.
      // Events + LLM briefings + the operator's conversation: one merged thread.
      const merged = [...companionTimeline(ws.tailer.runsDir, limit), ...readBriefings(ws), ...chatObservations(ws)]
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
        .slice(-limit);
      json(res, 200, { observations: merged });
      return;
    }

    const backlogDir = join(ws.workdir, "backlog");
    const projectMemFile = join(ws.workdir, "memory.json");

    /* ---------------- learned facts (memory) ---------------- */

    if (url.pathname === "/api/memory" && req.method === "GET") {
      const applied = readApplied(join(ws.workdir, "memory.applied.json"));
      const withCount = (f: Fact): Fact => ({ ...f, applied: applied[f.id] ?? 0 });
      const project = readFacts(projectMemFile).map((f) => withCount({ ...f, scope: "project" as const }));
      const global = readFacts(globalMemFile).map((f) => withCount({ ...f, scope: "global" as const }));
      json(res, 200, { facts: [...global, ...project] });
      return;
    }
    if (url.pathname === "/api/memory" && req.method === "POST") {
      try {
        const { text, scope, ticketId } = JSON.parse(await readBody(req)) as {
          text?: string; scope?: string; ticketId?: string | null;
        };
        if (!text?.trim()) throw new Error("text is required");
        const isGlobal = scope === "global";
        const file = isGlobal ? globalMemFile : projectMemFile;
        const facts = readFacts(file);
        facts.unshift({
          id: "F-" + Date.now().toString(36),
          text: text.trim(),
          scope: isGlobal ? "global" : "project",
          ticketId: ticketId || null,
          createdTs: new Date().toISOString(),
        });
        writeFacts(file, facts);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname.startsWith("/api/memory/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/memory/".length));
      const files = [globalMemFile, projectMemFile];
      if (req.method === "DELETE") {
        for (const file of files) {
          const facts = readFacts(file);
          const next = facts.filter((f) => f.id !== id);
          if (next.length !== facts.length) writeFacts(file, next);
        }
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "PUT") {
        try {
          const body = JSON.parse(await readBody(req)) as {
            text?: string; scope?: string; ticketId?: string | null;
          };
          // Pull the fact out of whichever file holds it (a scope change moves it).
          let existing: Fact | undefined;
          for (const file of files) {
            const facts = readFacts(file);
            const found = facts.find((f) => f.id === id);
            if (found) { existing = found; writeFacts(file, facts.filter((f) => f.id !== id)); }
          }
          if (!existing) throw new Error("fact not found");
          const isGlobal = (body.scope ?? existing.scope) === "global";
          const target = isGlobal ? globalMemFile : projectMemFile;
          const facts = readFacts(target);
          facts.unshift({
            ...existing,
            text: body.text ?? existing.text,
            ticketId: body.ticketId !== undefined ? body.ticketId : existing.ticketId,
            scope: isGlobal ? "global" : "project",
          });
          writeFacts(target, facts);
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
        }
        return;
      }
    }

    /* ---------------- knowledge base (ragmcp docs) ---------------- */

    const kp = knowledgePaths(ws.workdir);
    const configFile = join(ws.workdir, "factory.yaml");

    if (url.pathname === "/api/knowledge" && req.method === "GET") {
      const enabled = existsSync(configFile) && /^\s*mcp_config:/m.test(readFileSync(configFile, "utf-8"));
      json(res, 200, { enabled, ready: existsSync(kp.mcp), docs: readDocs(kp.index) });
      return;
    }
    if (url.pathname === "/api/knowledge" && req.method === "POST") {
      try {
        const { name, content } = JSON.parse(await readBody(req)) as { name?: string; content?: string };
        if (!name?.trim() || !content) throw new Error("name and content are required");
        // Keep only a safe basename; default a .md extension for pasted notes.
        let safe = basename(name.trim()).replace(/[^\w.\- ]+/g, "_");
        if (!extname(safe)) safe += ".md";
        scaffoldKnowledge(ws.workdir, opts.ragmcp); // idempotent; ensures store + config exist
        const file = join(kp.docsDir, safe);
        writeFileSync(file, content, "utf-8");
        const ingest = await runRagmcp(opts.ragmcp, ["ingest", toPosix(file), "--config", toPosix(kp.yaml)], ws.workdir);
        const doc: KnowledgeDoc = {
          id: "K-" + Date.now().toString(36),
          name: safe,
          size: Buffer.byteLength(content, "utf-8"),
          addedTs: new Date().toISOString(),
          chunks: ingest.ok ? Number(ingest.out.match(/chunks_new=(\d+)/)?.[1] ?? 0) : null,
          ...(ingest.ok ? {} : { error: ingest.out.slice(-300) }),
        };
        const docs = readDocs(kp.index).filter((d) => d.name !== safe);
        docs.unshift(doc);
        writeDocs(kp.index, docs);
        // 200 even on ingest failure: the HTTP call succeeded; the failure is a
        // domain result the client reads from doc.error (fetchJSON throws on !2xx).
        json(res, 200, { ok: ingest.ok, doc });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/knowledge/enable" && req.method === "POST") {
      try {
        const { enabled } = JSON.parse(await readBody(req)) as { enabled?: boolean };
        if (enabled) scaffoldKnowledge(ws.workdir, opts.ragmcp);
        setKnowledgeEnabled(configFile, !!enabled);
        json(res, 200, { ok: true, enabled: !!enabled });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname.startsWith("/api/knowledge/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/api/knowledge/".length));
      const docs = readDocs(kp.index);
      const doc = docs.find((d) => d.id === id);
      if (doc) {
        const file = join(kp.docsDir, doc.name);
        if (existsSync(file)) unlinkSync(file);
        // --sync drops from the store any source no longer on disk.
        await runRagmcp(opts.ragmcp, ["ingest", toPosix(kp.docsDir), "--config", toPosix(kp.yaml), "--sync"], ws.workdir);
        writeDocs(kp.index, docs.filter((d) => d.id !== id));
      }
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      ws.tailer.attach(res);
      req.on("close", () => ws.tailer.clients.delete(res));
      return;
    }

    if (url.pathname === "/api/control" && req.method === "POST") {
      try {
        const { op, task, text, to } = JSON.parse(await readBody(req)) as {
          op?: string; task?: string; text?: string; to?: string;
        };
        const ops = ["pause", "resume", "stop", "kill", "retry", "answer", "approve", "changes", "undo"];
        if (!op || !ops.includes(op)) throw new Error(`op must be one of ${ops.join(", ")}`);
        if (task !== undefined && !/^[\w.-]+$/.test(task)) throw new Error("bad task id");
        if (!ws.tailer.run) throw new Error("no active run");
        // "answer" (to a blocked agent) and "changes" (to a task awaiting approval)
        // carry free text; other ops never do. Cap the length to keep it one line.
        const payload: Record<string, unknown> = { ts: new Date().toISOString(), op, task };
        if (op === "answer") {
          const answer = (text ?? "").trim();
          if (!answer) throw new Error("answer text is required");
          payload.text = answer.slice(0, 4000);
        }
        if (op === "changes") {
          payload.text = (text ?? "").trim().slice(0, 4000);
        }
        if (op === "undo") {
          // A checkpoint SHA to rewind the parked branch to; the dispatcher only
          // honours one it actually handed out, so this is just a shape guard.
          const sha = (to ?? "").trim();
          if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("undo requires a checkpoint sha");
          payload.to = sha;
        }
        appendFileSync(
          join(ws.tailer.runsDir, ws.tailer.run, "control.jsonl"),
          JSON.stringify(payload) + "\n",
          "utf-8",
        );
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/log") {
      const task = url.searchParams.get("task") ?? "";
      if (!/^[\w.-]+$/.test(task) || !ws.tailer.run) {
        res.writeHead(400).end("bad task id or no run");
        return;
      }
      const file = join(ws.tailer.runsDir, ws.tailer.run, "agents", `${task}.stdout.jsonl`);
      if (!existsSync(file)) {
        res.writeHead(404).end("no log for this task (yet)");
        return;
      }
      const size = statSync(file).size;
      const tail = readFileSync(file, "utf-8").slice(Math.max(0, size - 64_000));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(tail);
      return;
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      const file = join(ws.workdir, "factory.yaml");
      json(res, 200, {
        content: existsSync(file) ? readFileSync(file, "utf-8") : "",
        path: file,
      });
      return;
    }
    if (url.pathname === "/api/config" && req.method === "PUT") {
      try {
        const { content } = JSON.parse(await readBody(req)) as { content?: string };
        if (typeof content !== "string" || !content.trim()) {
          throw new Error("config cannot be empty");
        }
        writeFileSync(join(ws.workdir, "factory.yaml"), content, "utf-8");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/status") {
      const backlog = existsSync(backlogDir)
        ? readdirSync(backlogDir).filter((f) => f.endsWith(".md")).length
        : 0;
      json(res, 200, {
        plan: ws.jobs.plan,
        run: ws.jobs.run,
        chat: ws.jobs.chat,
        doctor: ws.jobs.doctor,
        backlogCount: backlog,
        currentRun: ws.tailer.run,
        workspace: ws.name,
        agentVersion: await agentVersion(),
      });
      return;
    }

    if (url.pathname === "/api/doctor" && req.method === "POST") {
      try {
        if (ws.jobs.doctor.state === "running") throw new Error("a capability check is already running");
        spawnJob(ws, "doctor", opts.factory, ["doctor"]);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    /* ---------------- live preview of the built product ---------------- */

    if (url.pathname === "/api/preview/detect" && req.method === "GET") {
      const repo = resolve(url.searchParams.get("repo") ?? "");
      if (!repo || !existsSync(repo)) {
        json(res, 400, { ok: false, error: "repo path does not exist" });
        return;
      }
      json(res, 200, detectPreview(repo));
      return;
    }
    if (url.pathname === "/api/preview" && req.method === "GET") {
      json(res, 200, {
        kind: ws.preview.kind,
        state: ws.preview.state,
        url: ws.preview.url,
        output: ws.preview.output.slice(-2000),
      });
      return;
    }
    if (url.pathname === "/api/preview" && req.method === "POST") {
      try {
        const { repo } = JSON.parse(await readBody(req)) as { repo?: string };
        const dir = resolve(repo ?? "");
        if (!dir || !existsSync(dir)) throw new Error("repo path does not exist");
        const kind = startPreview(ws, dir);
        json(res, 200, { ok: true, kind });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/preview/stop" && req.method === "POST") {
      stopPreview(ws);
      json(res, 200, { ok: true });
      return;
    }
    // Freeze-frame of the running app — headless screenshot of the live preview
    // URL, streamed as PNG. Visual evidence you can hand to the supervisor or keep
    // as proof the build renders (the same infra the capsule judge uses).
    if (url.pathname === "/api/preview/shot" && req.method === "GET") {
      const target = ws.preview.url;
      if (!target) { json(res, 400, { ok: false, error: "no live preview to capture" }); return; }
      const bin = chromeBin();
      if (!bin) { json(res, 400, { ok: false, error: "no Chrome or Edge found to render the screenshot" }); return; }
      const out = join(ws.workdir, ".preview-shot.png");
      if (!(await screenshotUrl(bin, target, out))) {
        json(res, 500, { ok: false, error: "the screenshot could not be captured" });
        return;
      }
      const buf = readFileSync(out);
      res.writeHead(200, { "content-type": "image/png", "content-length": buf.length, "cache-control": "no-store" });
      res.end(buf);
      return;
    }

    /* -------- capsule: the generic, app-agnostic project cockpit -------- */
    if (url.pathname === "/api/capsule" && req.method === "GET") {
      json(res, 200, await capsuleView(ws));
      return;
    }
    if (url.pathname === "/api/capsule/panel" && req.method === "GET") {
      const capsule = loadCapsule(ws);
      const panel = (capsule?.panels ?? []).find((p) => p.id === url.searchParams.get("id"));
      if (!capsule || !panel) { json(res, 404, { ok: false, error: "unknown panel" }); return; }
      if (!panel.source) { json(res, 200, { output: "" }); return; } // html panel: nothing to run
      const { out } = await captureShell(panel.source, workspaceRepo(ws) ?? ws.workdir, capsuleEnv(ws, capsule));
      json(res, 200, { output: out.slice(-4000) });
      return;
    }
    if (url.pathname === "/api/capsule/action" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const action = capsule?.actions.find((a) => a.id === id);
        if (!capsule || !action) throw new Error("unknown action");
        if (ws.capsule.runs.get(action.id)?.state === "running") throw new Error("already running");
        void runCapsuleAction(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/capsule/status" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const r = ws.capsule.runs.get(id);
      json(res, 200, { state: r?.state ?? "idle", output: (r?.output ?? "").slice(-8000) });
      return;
    }
    if (url.pathname === "/api/capsule/generate" && req.method === "POST") {
      if (!workspaceRepo(ws)) { json(res, 400, { ok: false, error: "no repository for this project" }); return; }
      if (ws.capsule.runs.get("__generate__")?.state === "running") { json(res, 409, { ok: false, error: "already generating" }); return; }
      generateCapsule(ws);
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/capsule/provision" && req.method === "POST") {
      if (!loadCapsule(ws)) { json(res, 400, { ok: false, error: "no capsule for this project" }); return; }
      if (ws.capsule.runs.get("__provision__")?.state === "running") { json(res, 409, { ok: false, error: "already provisioning" }); return; }
      void generateProvision(ws);
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/capsule/fix" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const action = capsule?.actions.find((a) => a.id === id);
        if (!capsule || !action) throw new Error("unknown action");
        if (ws.capsule.runs.get(action.id)?.state === "running") throw new Error("already running");
        void generateFix(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/chat" && req.method === "POST") {
      try {
        const { message } = JSON.parse(await readBody(req)) as { message?: string };
        if (!message?.trim()) throw new Error("message is required");
        if (!loadCapsule(ws)) throw new Error("no capsule for this project");
        if (ws.capsule.runs.get("__chat__")?.state === "running") throw new Error("already editing");
        generateCapsuleChat(ws, message.trim());
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/chat/draft" && req.method === "GET") {
      const draft = ws.capsule.chatDraft;
      json(res, 200, { has: !!draft, diff: draft ? capsuleDiff(loadCapsule(ws), draft) : [] });
      return;
    }
    if (url.pathname === "/api/capsule/chat/apply" && req.method === "POST") {
      try {
        if (!ws.capsule.chatDraft) throw new Error("nothing to apply");
        writeFileSync(capsuleFile(ws), JSON.stringify(ws.capsule.chatDraft, null, 2), "utf-8");
        ws.capsule.chatDraft = null;
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/chat/discard" && req.method === "POST") {
      ws.capsule.chatDraft = null;
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/capsule/judge" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const action = capsule?.actions.find((a) => a.id === id);
        if (!capsule || !action) throw new Error("unknown action");
        if (ws.capsule.judgments.get(action.id)?.state === "running") throw new Error("already judging");
        void judgeAction(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/judge" && req.method === "GET") {
      const jr = ws.capsule.judgments.get(url.searchParams.get("id") ?? "");
      json(res, 200, {
        state: jr?.state ?? "idle", output: (jr?.output ?? "").slice(-6000),
        verdict: jr?.verdict ?? null, confidence: jr?.confidence ?? null,
        reasons: jr?.reasons ?? [], hasShot: !!(jr?.shot && existsSync(jr.shot)),
      });
      return;
    }
    if (url.pathname === "/api/capsule/judge/shot" && req.method === "GET") {
      const jr = ws.capsule.judgments.get(url.searchParams.get("id") ?? "");
      if (!jr?.shot || !existsSync(jr.shot)) { json(res, 404, { ok: false, error: "no screenshot" }); return; }
      const buf = readFileSync(jr.shot);
      res.writeHead(200, { "content-type": "image/png", "content-length": buf.length, "cache-control": "no-store" });
      res.end(buf);
      return;
    }
    if (url.pathname === "/api/capsule/service" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const action = capsule?.actions.find((a) => a.id === id);
        if (!capsule || !action || !action.service) throw new Error("not a service action");
        void startService(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/service/stop" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        stopService(ws, id ?? "");
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/capsule/service" && req.method === "GET") {
      const s = ws.capsule.services.get(url.searchParams.get("id") ?? "");
      json(res, 200, { state: s?.state ?? "stopped", url: s?.url ?? null, output: (s?.output ?? "").slice(-8000) });
      return;
    }
    if (url.pathname === "/api/capsule/consent" && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        const capsule = loadCapsule(ws);
        const consent = (capsule?.consents ?? []).find((c) => c.id === id);
        if (!capsule || !consent) throw new Error("unknown consent");
        const r = await runCapsuleConsent(ws, capsule, consent, workspaceRepo(ws) ?? ws.workdir);
        if (r.state !== "ok") throw new Error(r.output.trim().slice(-400) || "provisioning failed");
        json(res, 200, { ok: true, output: r.output.trim() });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }
    if (url.pathname === "/api/capsule/artifact" && req.method === "GET") {
      const capsule = loadCapsule(ws);
      const action = capsule?.actions.find((a) => a.id === url.searchParams.get("id"));
      const repo = workspaceRepo(ws) ?? ws.workdir;
      const file = action?.artifact ? join(repo, action.artifact) : null;
      if (!file || !existsSync(file)) { json(res, 404, { ok: false, error: "no artifact built yet" }); return; }
      const buf = readFileSync(file);
      const type = extname(file).toLowerCase() === ".apk"
        ? "application/vnd.android.package-archive" : "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "content-disposition": `attachment; filename="${basename(file)}"`,
        "content-length": buf.length,
        "cache-control": "no-store",
      });
      res.end(buf);
      return;
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const { message } = JSON.parse(await readBody(req)) as { message?: string };
        if (!message?.trim()) throw new Error("message is required");
        if (ws.jobs.chat.state === "running") throw new Error("the supervisor is still answering");
        // Persist the exchange so the conversation survives a reload (the server
        // is the sole writer of this file) AND push each turn over SSE — the
        // conversation lives in the same rail as the companion timeline.
        const run = ws.tailer.run ?? "";
        const userMsg: ChatMsg = { who: "you", text: message.trim(), ts: new Date().toISOString(), run };
        const userIdx = readChatHistory(ws).length;
        appendChatMsg(ws, userMsg);
        pushCompanion(ws, chatObs(userMsg, userIdx));
        // --json: the reply comes back as the ask envelope (structured suggestions
        // → one-click buttons). --stream: per-turn progress on stderr, surfaced live
        // in the rail. The answer is parsed from STDOUT only (stderr holds progress).
        spawnJob(ws, "chat", opts.factory, ["ask", "--json", "--stream", message.trim()], undefined,
          (ok, output, stdout) => {
            const raw = stdout || output || (ok ? "(no answer)" : "The supervisor failed to answer.");
            const { text, suggestions } = parseAnswer(raw);
            const reply: ChatMsg = {
              who: "supervisor", text: text.slice(0, 4000), ts: new Date().toISOString(),
              run: ws.tailer.run ?? "", ...(suggestions.length ? { suggestions } : {}),
            };
            const idx = readChatHistory(ws).length;
            appendChatMsg(ws, reply);
            pushCompanion(ws, chatObs(reply, idx));
          },
          true); // streamProgress: parse per-turn progress into ws.jobs.chat.progress
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/analytics" && req.method === "GET") {
      // One point per run, oldest first — spend/tokens/outcomes over time.
      const runsDir = ws.tailer.runsDir;
      const names = existsSync(runsDir)
        ? readdirSync(runsDir).filter((r) => existsSync(join(runsDir, r, "events.jsonl"))).sort()
        : [];
      const series = names.map((run) => {
        const s = summarizeRun(runsDir, run);
        return {
          run, ts: s.updatedTs, spend: s.spend, tokens: s.tokens,
          merged: s.counts.merged, needs: s.counts.needs, total: s.total,
          mode: s.mode,
        };
      });
      json(res, 200, { series });
      return;
    }

    if (url.pathname === "/api/ticket/complete" && req.method === "POST") {
      // Expand a hand-written ticket into a proper Goal + Done-when body, on demand.
      try {
        const { title, notes } = JSON.parse(await readBody(req)) as { title?: string; notes?: string };
        if (!title?.trim() && !notes?.trim()) throw new Error("write a title or a few notes first");
        const prompt = "You are drafting ONE work ticket for a coding agent working on this project. "
          + "Turn the rough note below into a crisp, single-scope ticket. Reply with GitHub-flavored "
          + "markdown ONLY (no preamble, no code fences): a \"## Goal\" section of 2-4 concrete sentences, "
          + "then a \"## Done when\" checklist of \"- \" acceptance items. Keep it to one focused change.\n\n"
          + `Rough title: ${title?.trim() || "(none)"}\nRough notes: ${notes?.trim() || "(none)"}`;
        const raw = await askOneShot(opts.factory, ws.workdir, prompt);
        const { text } = parseAnswer(raw);
        json(res, 200, { ok: true, body: text });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/ticket/review" && req.method === "POST") {
      // Opt-in companion review: a developer finished a MANUAL ticket by hand and
      // chose to have the AI check it. We hand the model the ticket plus the repo's
      // git diff (working changes, else the last commit) and ask for a review.
      try {
        const { file } = JSON.parse(await readBody(req)) as { file?: string };
        if (!file?.trim()) throw new Error("file is required");
        const ticketPath = join(ws.workdir, "backlog", basename(file));
        if (!existsSync(ticketPath)) throw new Error("ticket not found");
        const content = readFileSync(ticketPath, "utf-8");
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
        const repoRaw = /^repo:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1]?.trim();
        const repo = repoRaw ? resolve(repoRaw) : (workspaceRepo(ws) ?? "");
        if (!repo || !existsSync(join(repo, ".git"))) throw new Error("no git repository to review");
        let diff = (await runCmd("git", ["diff", "HEAD"], repo)).output.trim();
        if (!diff) diff = (await runCmd("git", ["show", "-p", "--stat", "HEAD"], repo)).output.trim();
        diff = diff.slice(0, 28_000);
        const prompt = "A developer says they finished this ticket BY HAND (not the AI). Review their work "
          + "as a careful code reviewer: does it fulfil the ticket, and are there bugs, gaps, missing tests, "
          + "or risks? Be concise and concrete; if it looks solid, say so plainly. Do not take any action.\n\n"
          + `# Ticket\n${content}\n\n# Repository changes\n`
          + (diff || "(no diff found — review from the ticket intent and by reading the repo files)");
        const raw = await askOneShot(opts.factory, ws.workdir, prompt);
        const { text } = parseAnswer(raw);
        json(res, 200, { ok: true, review: text });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/plan" && req.method === "POST") {
      try {
        const { goal, repo, ask, clarifications } = JSON.parse(await readBody(req)) as
          { goal?: string; repo?: string; ask?: boolean; clarifications?: string };
        if (!goal?.trim()) throw new Error("goal is required");
        if (!repo?.trim()) throw new Error("repo path is required");
        if (ws.jobs.plan.state === "running" || ws.jobs.run.state === "running") {
          throw new Error("a job is already running in this workspace");
        }
        // Remember the repo on the workspace: it survives reloads, browser
        // switches and the phone — the repo belongs to the project, not the tab.
        ws.repo = resolve(repo.trim());
        registry.save();
        // Fold the operator's answers into the goal so the ticket pass plans with
        // them in hand — the planner is stateless between the ask and draft passes.
        const goalText = clarifications?.trim()
          ? `${goal.trim()}\n\n## Operator's answers to clarifying questions\n${clarifications.trim()}`
          : goal.trim();
        const args = ["plan", goalText, "--repo", repo.trim()];
        if (ask) args.push("--ask");
        // In the ask pass, parse the questions the planner emitted and hang them
        // off the plan job for the cockpit to render (the pass writes no drafts).
        const onDone = ask
          ? (ok: boolean, _out: string, stdout: string): void => {
              if (!ok) return;
              const qs = parsePlanQuestions(stdout);
              if (qs && qs.length) ws.jobs.plan.questions = qs;
              else {
                ws.jobs.plan.state = "error";
                ws.jobs.plan.output += "\n(the planner returned no clarifying questions — try again or skip plan mode)";
              }
            }
          : undefined;
        spawnJob(ws, "plan", opts.factory, args, undefined, onDone);
        // spawnJob replaced the job object; tag the fresh one so /api/status tells
        // the client which pass is running and to clear any stale questions.
        ws.jobs.plan.mode = ask ? "questions" : "tickets";
        ws.jobs.plan.questions = undefined;
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      try {
        const { slots } = JSON.parse(await readBody(req)) as { slots?: number };
        if (ws.jobs.run.state === "running") throw new Error("a run is already in progress");
        const args = ["run"];
        if (slots && Number.isFinite(slots) && slots > 0) args.push("--slots", String(slots));
        // The run reads project lessons from its own workdir; the shared global
        // lessons live outside it, so hand their path over explicitly.
        spawnJob(ws, "run", opts.factory, args, { FACTORY_GLOBAL_MEMORY: globalMemFile });
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/tickets/hidden" && req.method === "GET") {
      json(res, 200, { hidden: [...ws.hidden] });
      return;
    }
    if ((url.pathname === "/api/tickets/hide" || url.pathname === "/api/tickets/unhide") && req.method === "POST") {
      try {
        const { id } = JSON.parse(await readBody(req)) as { id?: string };
        if (!id) throw new Error("id is required");
        if (url.pathname.endsWith("/hide")) ws.hidden.add(id); else ws.hidden.delete(id);
        saveHidden(ws);
        json(res, 200, { ok: true, hidden: [...ws.hidden] });
      } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
      return;
    }
    if (url.pathname === "/api/backlog" && req.method === "GET") {
      const tickets = existsSync(backlogDir)
        ? readdirSync(backlogDir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f) => ({ file: f, content: readFileSync(join(backlogDir, f), "utf-8") }))
        : [];
      json(res, 200, { tickets });
      return;
    }

    if (url.pathname.startsWith("/api/backlog/")) {
      const file = basename(decodeURIComponent(url.pathname.slice("/api/backlog/".length)));
      if (!SAFE_NAME.test(file)) {
        json(res, 400, { ok: false, error: "bad ticket filename" });
        return;
      }
      const path = join(backlogDir, file);
      // The client saves via postJSON (POST); accept PUT too for symmetry.
      if (req.method === "PUT" || req.method === "POST") {
        const { content } = JSON.parse(await readBody(req)) as { content?: string };
        if (typeof content !== "string" || !content.startsWith("---")) {
          json(res, 400, { ok: false, error: "ticket must start with YAML front matter" });
          return;
        }
        mkdirSync(backlogDir, { recursive: true });
        writeFileSync(path, content, "utf-8");
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "DELETE") {
        if (existsSync(path)) unlinkSync(path);
        json(res, 200, { ok: true });
        return;
      }
    }

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

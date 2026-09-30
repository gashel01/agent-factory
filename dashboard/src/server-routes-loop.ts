/* Per-workspace routes for the autopilot loop (`factory loop`): its state, its
 * own backlog, start / stop / live re-steer, and the AI-drafted objective.
 * Split out of server-routes-run.ts — no behaviour change. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  askOneShot, HttpError, json, launchConflict, readJSON, sendError, spawnJob, writeFileAtomic,
} from "./server-core.js";
import { killTree } from "./server-preview.js";
import type { WsRouteCtx } from "./server-routes.js";

/** The newest loop's directory under <workdir>/runs (or null). */
function activeLoopDir(workdir: string): string | null {
  const runs = join(workdir, "runs");
  if (!existsSync(runs)) return null;
  const dirs = readdirSync(runs)
    .filter((d) => d.startsWith("loop-") && existsSync(join(runs, d, "loop.jsonl")))
    .map((d) => join(runs, d))
    .sort((a, b) => statSync(join(b, "loop.jsonl")).mtimeMs - statSync(join(a, "loop.jsonl")).mtimeMs);
  return dirs[0] ?? null;
}

/** Parse the latest state of an autopilot loop from its loop.jsonl (loop_start /
 *  loop_iter / loop_end events). Returns null when no loop has run for this ws. */
function readLoopState(workdir: string): Record<string, unknown> | null {
  const dir = activeLoopDir(workdir);
  if (!dir) return null;
  const state: Record<string, unknown> = {};
  for (const line of readFileSync(join(dir, "loop.jsonl"), "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as Record<string, unknown>;
      if (e.event === "loop_start") Object.assign(state, {
        name: e.name, mode: e.mode, objective: e.objective, integ: e.integ, base: e.base,
        budget: e.budget, maxIterations: e.max_iterations,
      });
      else if (e.event === "loop_iter") Object.assign(state, { iteration: e.n, spent: e.spent });
      else if (e.event === "steered") state.objective = e.objective;
      else if (e.event === "loop_end") Object.assign(state, {
        stop: e.stop, spent: e.spent, accepted: e.accepted, pr: e.pr,
      });
    } catch { /* skip a torn line */ }
  }
  // The LIVE objective (objective.md) is authoritative — it reflects any re-steer.
  const objFile = join(dir, "objective.md");
  if (existsSync(objFile)) {
    const txt = readFileSync(objFile, "utf-8").trim();
    if (txt) state.objective = txt;
  }
  return state;
}

/** Pull a {objective, accept} JSON object out of a model's free-text answer. */
function extractDraft(text: string): { objective: string; accept: string } | null {
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "{") starts.push(i);
  for (const i of starts.reverse()) {
    try {
      const obj = JSON.parse(text.slice(i, text.lastIndexOf("}") + 1)) as Record<string, unknown>;
      if (typeof obj.objective === "string" && typeof obj.accept === "string") {
        return { objective: obj.objective, accept: obj.accept };
      }
    } catch { /* try an earlier brace */ }
  }
  return null;
}

export async function handleLoopRoutes(ctx: WsRouteCtx): Promise<boolean> {
  const { req, res, url, ws, opts, globalMemFile } = ctx;

  if (url.pathname === "/api/loop" && req.method === "GET") {
    json(res, 200, { state: ws.jobs.loop.state, ...(readLoopState(ws.workdir) ?? {}) });
    return true;
  }

  if (url.pathname === "/api/loop/backlog" && req.method === "GET") {
    // The active loop's own backlog tickets (with their depends_on) — so the board
    // can show the dependency graph for an autopilot run, whose tickets live here
    // rather than in the workspace backlog.
    const dir = activeLoopDir(ws.workdir);
    const bl = dir ? join(dir, "backlog") : "";
    const tickets = bl && existsSync(bl)
      ? readdirSync(bl).filter((f) => f.endsWith(".md"))
          .map((f) => ({ content: readFileSync(join(bl, f), "utf-8") }))
      : [];
    json(res, 200, { tickets });
    return true;
  }

  if (url.pathname === "/api/loop/start" && req.method === "POST") {
    try {
      const b = await readJSON(req) as {
        objective?: string; accept?: string; mode?: string; sourceBacklog?: string;
        budget?: number; maxIterations?: number; name?: string; repo?: string;
      };
      const mode = ["explicit", "backlog", "self", "supervisor"].includes(b.mode ?? "")
        ? (b.mode as string) : "explicit";
      if (!b.repo?.trim()) throw new Error("repo path is required");
      // No loop without a hard budget cap — the whole point is it can't run away.
      if (!b.budget || !Number.isFinite(b.budget) || b.budget <= 0) {
        throw new Error("a budget cap (USD) greater than 0 is required");
      }
      const conflict = launchConflict(ws);
      if (conflict) throw new HttpError(409, conflict);
      const name = (b.name?.trim() || "autopilot").replace(/[^\w.-]/g, "-");
      const iters = b.maxIterations && b.maxIterations > 0 ? Math.floor(b.maxIterations) : 5;
      const repo = b.repo.trim();
      // Map each command mode to its `factory loop` args.
      const args = ["loop"];
      if (mode === "explicit" || mode === "supervisor") {
        if (!b.objective?.trim()) throw new Error(`${mode} mode needs an objective`);
        args.push(b.objective.trim(), "--mode", mode);
        if (mode === "explicit" && b.accept?.trim()) args.push("--accept", b.accept.trim());
      } else if (mode === "self") {
        args.push("--mode", "self");
      } else {
        const dir = b.sourceBacklog?.trim() || join(ws.workdir, "backlog");
        if (!existsSync(dir)) throw new Error(`backlog directory not found: ${dir}`);
        args.push("--mode", "backlog", "--source-backlog", dir);
      }
      args.push("--budget", String(b.budget), "--max-iterations", String(iters),
                "--name", name, "--repo", repo);
      ws.repo = resolve(repo);
      ws.loopProc = spawnJob(ws, "loop", opts.factory, args,
        { FACTORY_GLOBAL_MEMORY: globalMemFile });
      json(res, 200, { ok: true });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/loop/stop" && req.method === "POST") {
    if (ws.loopProc) { killTree(ws.loopProc); ws.loopProc = null; }
    ws.jobs.loop.state = "idle";
    json(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/loop/steer" && req.method === "POST") {
    // The live volant: rewrite the running loop's objective.md; the loop re-reads
    // it at the top of its next round (no restart).
    try {
      const { objective } = await readJSON(req) as { objective?: string };
      if (!objective?.trim()) throw new Error("a new objective is required");
      const dir = activeLoopDir(ws.workdir);
      if (!dir) throw new Error("no active loop to steer");
      writeFileAtomic(join(dir, "objective.md"), objective.trim());
      json(res, 200, { ok: true });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/loop/draft" && req.method === "POST") {
    try {
      const { repo } = await readJSON(req) as { repo?: string };
      if (!repo?.trim()) throw new Error("repo path is required");
      const prompt =
        "Propose an autopilot objective for THIS repository. Read enough to be "
        + "concrete. Return: (1) a one-paragraph objective statement, and (2) an "
        + "EXECUTABLE acceptance command that exits 0 when the objective is met — "
        + "read-only, using the repo's own runner (tests / typecheck / build). End "
        + 'your answer with a strict JSON block: {"objective":"...","accept":"..."}';
      const raw = await askOneShot(opts.factory, resolve(repo.trim()), prompt);
      const draft = extractDraft(raw);
      if (!draft) throw new Error("the model did not return a usable objective — try again");
      json(res, 200, { ok: true, ...draft });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }


  return false;
}

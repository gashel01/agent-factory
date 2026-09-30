/* Extracted from server.ts — mechanical split. Per-workspace routes for the run
 * lifecycle: SSE events, operator control, task logs, config, status, doctor, the
 * supervisor chat, analytics, diagnostics, forecasts, plan and run. The loop,
 * backlog/tickets and architecture groups live in their own server-routes-*.ts. */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  HttpError, json, launchConflict, liveRunLock, parsePlanQuestions, readJSON, sendError, spawnJob,
  summarizeRun, workspaceRepo, writeFileAtomic,
} from "./server-core.js";
import { agentVersion } from "./server-usage.js";
import { summarize } from "./diagnostics.js";
import {
  analyzeErrorPatterns, buildForecasts, diagnoseTask, isSafeId, pickRun, readPendingForecast, readRunForecast,
  reconcileRun, savePendingForecast,
} from "./insights.js";
import {
  appendChatMsg, chatObs, parseAnswer, pushCompanion, readChatHistory,
} from "./server-companion.js";
import type { ChatMsg } from "./server-companion.js";
import type { WsRouteCtx } from "./server-routes.js";

/** SSE comment line sent on an idle stream so proxies, the OS and the browser
 *  don't reap a connection that is quiet between runs. */
const SSE_HEARTBEAT_MS = 25_000;

export async function handleRunRoutes(ctx: WsRouteCtx): Promise<boolean> {
  const { req, res, url, ws, opts, globalMemFile } = ctx;
  const backlogDir = join(ws.workdir, "backlog");

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    ws.tailer.attach(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      ws.tailer.clients.delete(res);
    });
    return true;
  }

  if (url.pathname === "/api/control" && req.method === "POST") {
    try {
      const { op, task, text, to } = await readJSON(req) as {
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
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/log") {
    const task = url.searchParams.get("task") ?? "";
    if (!/^[\w.-]+$/.test(task) || !ws.tailer.run) {
      res.writeHead(400).end("bad task id or no run");
      return true;
    }
    const file = join(ws.tailer.runsDir, ws.tailer.run, "agents", `${task}.stdout.jsonl`);
    if (!existsSync(file)) {
      res.writeHead(404).end("no log for this task (yet)");
      return true;
    }
    const size = statSync(file).size;
    const tail = readFileSync(file, "utf-8").slice(Math.max(0, size - 64_000));
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(tail);
    return true;
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    const file = join(ws.workdir, "factory.yaml");
    json(res, 200, {
      content: existsSync(file) ? readFileSync(file, "utf-8") : "",
      path: file,
    });
    return true;
  }
  if (url.pathname === "/api/config" && req.method === "PUT") {
    try {
      const { content } = await readJSON(req) as { content?: string };
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("config cannot be empty");
      }
      writeFileAtomic(join(ws.workdir, "factory.yaml"), content);
      json(res, 200, { ok: true });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/status") {
    const backlog = existsSync(backlogDir)
      ? readdirSync(backlogDir).filter((f) => f.endsWith(".md")).length
      : 0;
    json(res, 200, {
      plan: ws.jobs.plan,
      run: ws.jobs.run,
      loop: ws.jobs.loop,
      chat: ws.jobs.chat,
      doctor: ws.jobs.doctor,
      backlogCount: backlog,
      currentRun: ws.tailer.run,
      workspace: ws.name,
      // A `factory run`/`loop` holding the workspace lock that this server did
      // not start (e.g. launched from a terminal) — launches are refused meanwhile.
      externalRun: ws.jobs.run.state !== "running" && ws.jobs.loop.state !== "running"
        ? liveRunLock(ws.workdir) : null,
      agentVersion: await agentVersion(),
    });
    return true;
  }

  if (url.pathname === "/api/doctor" && req.method === "POST") {
    try {
      if (ws.jobs.doctor.state === "running") throw new Error("a capability check is already running");
      spawnJob(ws, "doctor", opts.factory, ["doctor"]);
      json(res, 200, { ok: true });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    try {
      const { message } = await readJSON(req) as { message?: string };
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
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/analytics" && req.method === "GET") {
    // One point per run, oldest first — spend/tokens/outcomes over time.
    const runsDir = ws.tailer.runsDir;
    const names = existsSync(runsDir)
      ? readdirSync(runsDir).filter((r) => existsSync(join(runsDir, r, "events.jsonl"))).sort()
      : [];
    const series = names.map((run) => {
      const s = summarizeRun(runsDir, run);
      const patterns = analyzeErrorPatterns(runsDir, run);
      return {
        run, ts: s.updatedTs, spend: s.spend, tokens: s.tokens,
        merged: s.counts.merged, needs: s.counts.needs, total: s.total,
        mode: s.mode,
        error_counts: patterns.errorCounts,
      };
    });
    json(res, 200, { series });
    return true;
  }

  if (url.pathname === "/api/diagnostics" && req.method === "GET") {
    // Why one ticket ended the way it did. `run` is optional: without it the
    // question is about the run the operator is currently watching.
    try {
      const task = url.searchParams.get("task") ?? "";
      if (!isSafeId(task)) throw new Error("bad task id");
      const run = pickRun(ws.tailer.runsDir, url.searchParams.get("run"), ws.tailer.run);
      // A workspace with no run at all still answers: `diagnose` reports an
      // honest "unknown" for a task it has no evidence about.
      const diagnosis = diagnoseTask(ws.tailer.runsDir, run, task);
      json(res, 200, { ok: true, run, task, diagnosis, summary: summarize(diagnosis) });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/forecast" && req.method === "GET") {
    const slots = Number(url.searchParams.get("slots"));
    const bundle = buildForecasts(ws.workdir, ws.tailer.runsDir, slots, workspaceRepo(ws));
    // `pending` is the estimate accepted for a launch that has not been paired
    // with its run yet — the panel shows it so an accepted estimate never
    // disappears between the click and the first event.
    json(res, 200, { ok: true, ...bundle, pending: readPendingForecast(ws.workdir) });
    return true;
  }

  if (url.pathname === "/api/forecast/actual" && req.method === "GET") {
    try {
      const run = pickRun(ws.tailer.runsDir, url.searchParams.get("run"), ws.tailer.run);
      const reconciliation = reconcileRun(ws.workdir, ws.tailer.runsDir, run);
      if (!reconciliation) {
        json(res, 200, {
          ok: false, run, reconciliation: null, forecast: null,
          error: "no estimate was stored for this run",
        });
        return true;
      }
      json(res, 200, {
        ok: true, run, reconciliation, forecast: readRunForecast(ws.tailer.runsDir, run),
      });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }


  if (url.pathname === "/api/plan" && req.method === "POST") {
    try {
      const { goal, repo, ask, clarifications } = await readJSON(req) as
        { goal?: string; repo?: string; ask?: boolean; clarifications?: string };
      if (!goal?.trim()) throw new Error("goal is required");
      if (!repo?.trim()) throw new Error("repo path is required");
      const conflict = launchConflict(ws);
      if (conflict) throw new HttpError(409, conflict);
      // Remember the repo on the workspace: it survives reloads, browser
      // switches and the phone — the repo belongs to the project, not the tab.
      ws.repo = resolve(repo.trim());
      ctx.registry.save();
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
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/run" && req.method === "POST") {
    try {
      const { slots, profile, forecast, base } = await readJSON(req) as
        { slots?: number; profile?: string; forecast?: unknown; base?: string };
      const conflict = launchConflict(ws);
      if (conflict) throw new HttpError(409, conflict);
      // A launch from the estimate panel carries the estimate the operator
      // accepted. Persist it BEFORE spawning: the dispatcher names the run, so
      // there is a moment where the run exists and the estimate would not —
      // and an unnamed profile aborts the launch rather than starting a run
      // nothing can later be scored against.
      if (profile !== undefined || forecast !== undefined) {
        savePendingForecast(ws.workdir, profile, forecast);
      }
      const args = ["run"];
      if (slots && Number.isFinite(slots) && slots > 0) args.push("--slots", String(slots));
      // Per-run delivery target: the factory creates + checks out this branch, so a
      // batch lands on a fresh integration branch (one PR) without a factory.yaml edit.
      if (typeof base === "string" && base.trim() && /^(?!-)[\w./-]+$/.test(base.trim())) {
        args.push("--base", base.trim());
      }
      // The run reads project lessons from its own workdir; the shared global
      // lessons live outside it, so hand their path over explicitly.
      spawnJob(ws, "run", opts.factory, args, { FACTORY_GLOBAL_MEMORY: globalMemFile });
      json(res, 200, { ok: true });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  return false;
}

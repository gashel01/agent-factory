/* Extracted from server.ts — mechanical split. Per-workspace routes for the run
 * lifecycle: SSE events, operator control, task logs, config, status, doctor, the
 * supervisor chat, analytics, ticket drafting/review, plan, run, and the backlog. */

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  askOneShot, json, parsePlanQuestions, readBody, runCmd, SAFE_NAME, saveHidden,
  spawnJob, summarizeRun, workspaceRepo,
} from "./server-core.js";
import { agentVersion } from "./server-usage.js";
import {
  appendChatMsg, chatObs, parseAnswer, pushCompanion, readChatHistory,
} from "./server-companion.js";
import type { ChatMsg } from "./server-companion.js";
import type { WsRouteCtx } from "./server-routes.js";

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
    req.on("close", () => ws.tailer.clients.delete(res));
    return true;
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
      const { content } = JSON.parse(await readBody(req)) as { content?: string };
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("config cannot be empty");
      }
      writeFileSync(join(ws.workdir, "factory.yaml"), content, "utf-8");
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
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
      chat: ws.jobs.chat,
      doctor: ws.jobs.doctor,
      backlogCount: backlog,
      currentRun: ws.tailer.run,
      workspace: ws.name,
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
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
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
      return {
        run, ts: s.updatedTs, spend: s.spend, tokens: s.tokens,
        merged: s.counts.merged, needs: s.counts.needs, total: s.total,
        mode: s.mode,
      };
    });
    json(res, 200, { series });
    return true;
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
    return true;
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
    return true;
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
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
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
    return true;
  }

  if (url.pathname === "/api/tickets/hidden" && req.method === "GET") {
    json(res, 200, { hidden: [...ws.hidden] });
    return true;
  }
  if ((url.pathname === "/api/tickets/hide" || url.pathname === "/api/tickets/unhide") && req.method === "POST") {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      if (!id) throw new Error("id is required");
      if (url.pathname.endsWith("/hide")) ws.hidden.add(id); else ws.hidden.delete(id);
      saveHidden(ws);
      json(res, 200, { ok: true, hidden: [...ws.hidden] });
    } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
    return true;
  }
  if (url.pathname === "/api/backlog" && req.method === "GET") {
    const tickets = existsSync(backlogDir)
      ? readdirSync(backlogDir)
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((f) => ({ file: f, content: readFileSync(join(backlogDir, f), "utf-8") }))
      : [];
    json(res, 200, { tickets });
    return true;
  }

  if (url.pathname.startsWith("/api/backlog/")) {
    const file = basename(decodeURIComponent(url.pathname.slice("/api/backlog/".length)));
    if (!SAFE_NAME.test(file)) {
      json(res, 400, { ok: false, error: "bad ticket filename" });
      return true;
    }
    const path = join(backlogDir, file);
    // The client saves via postJSON (POST); accept PUT too for symmetry.
    if (req.method === "PUT" || req.method === "POST") {
      const { content } = JSON.parse(await readBody(req)) as { content?: string };
      if (typeof content !== "string" || !content.startsWith("---")) {
        json(res, 400, { ok: false, error: "ticket must start with YAML front matter" });
        return true;
      }
      mkdirSync(backlogDir, { recursive: true });
      writeFileSync(path, content, "utf-8");
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === "DELETE") {
      if (existsSync(path)) unlinkSync(path);
      json(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

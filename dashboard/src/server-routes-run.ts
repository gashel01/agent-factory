/* Extracted from server.ts — mechanical split. Per-workspace routes for the run
 * lifecycle: SSE events, operator control, task logs, config, status, doctor, the
 * supervisor chat, analytics, ticket drafting/review, plan, run, and the backlog. */

import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  askOneShot, json, latestRun, parsePlanQuestions, readBody, runCmd, SAFE_NAME, saveHidden,
  spawnJob, summarizeRun, workspaceRepo,
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
import { killTree } from "./server-preview.js";
import type { WsRouteCtx } from "./server-routes.js";

/** Parse the latest state of an autopilot loop from its loop.jsonl (loop_start /
 *  loop_iter / loop_end events). Returns null when no loop has run for this ws. */
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

export async function handleRunRoutes(ctx: WsRouteCtx): Promise<boolean> {
  const { req, res, url, ws, opts, globalMemFile } = ctx;
  const backlogDir = join(ws.workdir, "backlog");

  if (url.pathname === "/api/coordination") {
    // The shared workspace agents see: who claims/lands which files, the symbols
    // now defined, and the decisions/notes they've posted. Folded from the run's
    // append-only coordination.jsonl (mirrors factory.coordination.world_index).
    const runsDir = ws.tailer.runsDir;
    const run = latestRun(runsDir);
    const file = run ? join(runsDir, run, "coordination.jsonl") : "";
    const events: Array<Record<string, unknown>> = [];
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { events.push(JSON.parse(t)); } catch { /* skip a half-written line */ }
      }
    }
    const claimFiles = new Map<string, string[]>();
    const landedFiles = new Map<string, string[]>();
    const ended = new Set<string>();
    const symbols: Array<{ name: string; file: string; ticket: string }> = [];
    const symSeen = new Set<string>();
    const decisions = new Map<string, { value: string; ticket: string }>();
    const discoveries: Array<{ ticket: string; note: string }> = [];
    for (const e of events) {
      const tk = String(e.ticket ?? "");
      const kind = e.kind;
      if (kind === "claim") {
        claimFiles.set(tk, (e.writes as string[] ?? []).map(String));
      } else if (kind === "landed") {
        ended.add(tk);
        landedFiles.set(tk, (e.files as string[] ?? []).map(String));
        for (const [name, f] of Object.entries((e.symbols as Record<string, string>) ?? {})) {
          const key = `${name}@${f}`;
          if (!symSeen.has(key)) { symSeen.add(key); symbols.push({ name: String(name), file: String(f), ticket: tk }); }
        }
      } else if (kind === "released") {
        ended.add(tk);
      } else if (kind === "decision") {
        decisions.set(String(e.key ?? ""), { value: String(e.value ?? ""), ticket: tk });
      } else if (kind === "discovery") {
        discoveries.push({ ticket: tk, note: String(e.note ?? "") });
      }
    }
    const agents: Array<{ ticket: string; files: string[]; state: string; symbols: string[] }> = [];
    for (const tk of new Set([...claimFiles.keys(), ...landedFiles.keys()])) {
      const landed = landedFiles.has(tk);
      agents.push({
        ticket: tk,
        files: landed ? landedFiles.get(tk)! : (claimFiles.get(tk) ?? []),
        state: landed ? "landed" : (ended.has(tk) ? "released" : "live"),
        symbols: symbols.filter((s) => s.ticket === tk).map((s) => s.name),
      });
    }
    agents.sort((a, b) => a.ticket.localeCompare(b.ticket));
    json(res, 200, {
      run,
      agents,
      symbols: symbols.sort((a, b) => a.name.localeCompare(b.name)),
      decisions: [...decisions.entries()]
        .filter(([k]) => k)
        .map(([key, v]) => ({ key, value: v.value, ticket: v.ticket }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      discoveries: discoveries.slice(-20),
    });
    return true;
  }

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
      loop: ws.jobs.loop,
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
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if (url.pathname === "/api/forecast" && req.method === "GET") {
    const slots = Number(url.searchParams.get("slots"));
    const bundle = buildForecasts(ws.workdir, ws.tailer.runsDir, slots);
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
      json(res, 400, { ok: false, error: String(err) });
    }
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
      const { slots, profile, forecast, base } = JSON.parse(await readBody(req)) as
        { slots?: number; profile?: string; forecast?: unknown; base?: string };
      if (ws.jobs.run.state === "running") throw new Error("a run is already in progress");
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
      if (typeof base === "string" && base.trim() && /^[\w./-]+$/.test(base.trim())) {
        args.push("--base", base.trim());
      }
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

  // --------------------------------- autopilot loop ---------------------------------
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
      const b = JSON.parse(await readBody(req)) as {
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
      if (ws.jobs.loop.state === "running" || ws.jobs.run.state === "running"
          || ws.jobs.plan.state === "running") {
        throw new Error("a job is already running in this workspace");
      }
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
      json(res, 400, { ok: false, error: String(err) });
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
      const { objective } = JSON.parse(await readBody(req)) as { objective?: string };
      if (!objective?.trim()) throw new Error("a new objective is required");
      const dir = activeLoopDir(ws.workdir);
      if (!dir) throw new Error("no active loop to steer");
      writeFileSync(join(dir, "objective.md"), objective.trim(), "utf-8");
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if (url.pathname === "/api/loop/draft" && req.method === "POST") {
    try {
      const { repo } = JSON.parse(await readBody(req)) as { repo?: string };
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
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if (url.pathname === "/api/attachments" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        dataUrl?: string; name?: string; content?: string;
      };

      // Case 1: Image upload (existing behavior) — workspace attachments for goals/tickets
      if (body.dataUrl) {
        const { dataUrl, name } = body;
        const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? "").trim());
        if (!m) throw new Error("expected a base64 image data URL");
        const buf = Buffer.from(m[2]!, "base64");
        if (buf.length > 12 * 1024 * 1024) throw new Error("image too large (max 12 MB)");
        const ext = m[1] === "jpeg" ? "jpg" : m[1]!;
        const dir = join(ws.workdir, "attachments");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${createHash("sha1").update(buf).digest("hex").slice(0, 10)}.${ext}`);
        writeFileSync(file, buf);
        json(res, 200, { path: file, name: name || basename(file) });
        return true;
      }

      // Case 2: File upload to run (new behavior) — supervisor companion attachments
      if (body.content !== undefined && body.name) {
        const { content, name } = body;
        if (!ws.tailer.run) throw new Error("no active run");

        // Validate filename (prevent directory traversal attacks)
        if (!name.trim()) throw new Error("filename cannot be empty");
        if (name.includes("..") || name.includes("/") || name.includes("\\")) {
          throw new Error("filename contains invalid path characters");
        }

        // Decode content: try base64 if it looks like base64, else treat as UTF-8
        let buf: Buffer;
        const trimmed = content.trim();
        if (/^[A-Za-z0-9+/=\n\r]*$/.test(trimmed)) {
          // Looks like base64 (or could be), try to decode
          try {
            buf = Buffer.from(trimmed, "base64");
          } catch {
            // Failed to decode as base64, treat as UTF-8
            buf = Buffer.from(content, "utf8");
          }
        } else {
          // Contains non-base64 characters, treat as UTF-8
          buf = Buffer.from(content, "utf8");
        }

        if (buf.length > 50 * 1024 * 1024) throw new Error("file too large (max 50 MB)");

        const dir = join(ws.tailer.runsDir, ws.tailer.run, "uploads");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, name);
        writeFileSync(file, buf);

        json(res, 200, { path: file, name });
        return true;
      }

      throw new Error("provide either dataUrl (for images) or name + content (for files)");
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  return false;
}

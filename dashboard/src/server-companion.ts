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
import { type Workspace } from "./server-core.js";
import { type Observation, type ObsAction, foldRun, newCtx } from "./companion.js";


/** Fold a workspace's runs into the companion timeline — the narrated,
 *  persistent record of "what happened in this project", newest last. Derived
 *  fresh from events.jsonl each call, so it is always consistent with the board. */
export function companionTimeline(runsDir: string, limit: number): Observation[] {
  if (!existsSync(runsDir)) return [];
  const runs = readdirSync(runsDir)
    .filter((n) => existsSync(join(runsDir, n, "events.jsonl")))
    .sort(); // run ids are timestamped, so lexical order is chronological
  const all: Observation[] = [];
  for (const run of runs) {
    try {
      all.push(...foldRun(readFileSync(join(runsDir, run, "events.jsonl"), "utf-8"), newCtx(run)));
    } catch { /* skip an unreadable run */ }
  }
  return all.slice(-limit);
}


/* ------------------------------ companion briefings ------------------------------ */

// LLM-composed briefings (the supervisor's own voice). Unlike event-derived
// observations these cannot be re-derived, so they are persisted per workspace
// and merged into the timeline. Deduped by their stable id.
export const briefInFlight = new Set<string>();


// A run is "stalled" when nothing has moved for this long while work is in
// flight. Overridable (mostly for tests) via FACTORY_STALL_MS.
export const STALL_MS = Number(process.env.FACTORY_STALL_MS) || 5 * 60 * 1000;


// Cadence for the periodic mid-run stand-up. Only fires when someone is watching
// AND real progress landed since the last one, so cost stays bounded.
export const STANDUP_MS = Number(process.env.FACTORY_STANDUP_MS) || 12 * 60 * 1000;


export function briefingsFile(ws: Workspace): string {
  return join(ws.workdir, "companion-briefings.jsonl");
}


/** Push one observation to every SSE client of the workspace's live feed. */
export function pushCompanion(ws: Workspace, obs: Observation): void {
  const payload = `event: companion\ndata: ${JSON.stringify(obs)}\n\n`;
  for (const client of ws.tailer.clients) client.write(payload);
}


export function readBriefings(ws: Workspace): Observation[] {
  const file = briefingsFile(ws);
  if (!existsSync(file)) return [];
  const out: Observation[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as Observation); } catch { /* skip a torn line */ }
  }
  return out;
}


export const CONTROL_OPS = new Set<ObsAction["op"]>(["retry", "kill", "pause", "resume", "stop"]);


/** Parse `factory ask --json` stdout into the briefing text plus validated,
 *  executable suggestions. Defense in depth: even though the CLI already
 *  validates, we re-check the ops here before they can become live buttons.
 *  Falls back to treating the output as prose if it is not the JSON envelope. */
export function parseAnswer(raw: string): { text: string; suggestions: ObsAction[] } {
  try {
    const j = JSON.parse(raw) as { reply?: unknown; suggestions?: unknown };
    if (j && typeof j.reply === "string") {
      const suggestions: ObsAction[] = [];
      if (Array.isArray(j.suggestions)) {
        for (const s of j.suggestions as Array<Record<string, unknown>>) {
          if (!s || typeof s !== "object") continue;
          const op = String(s.op ?? "") as ObsAction["op"];
          // "plan" is not a control op: it carries a goal for the ticket planner,
          // not a task to act on. Keep it only when the goal is present.
          if (op === "plan") {
            const goal = String(s.goal ?? "").trim();
            if (!goal) continue;
            const label = (String(s.label ?? "Draft tickets").slice(0, 24) || "Draft tickets");
            suggestions.push({ op, label, goal: goal.slice(0, 2000) });
            continue;
          }
          if (!CONTROL_OPS.has(op)) continue;
          const task = s.task ? String(s.task) : undefined;
          if ((op === "retry" || op === "kill") && !task) continue;
          const label = (String(s.label ?? op).slice(0, 24) || op);
          suggestions.push({ op, label, ...(task ? { task } : {}) });
        }
      }
      return { text: j.reply.trim(), suggestions };
    }
  } catch { /* not the JSON envelope — treat as prose */ }
  return { text: raw, suggestions: [] };
}


/**
 * Spawn the supervisor to compose a briefing (its own voice) and drop it into
 * the companion feed. Fire-and-forget: `factory ask` on the shared --resume
 * session (continuity), then persist + push over SSE. Deduped durably by id and
 * skipped while a live chat holds the session. Used for run wrap-ups and stalls.
 */
export function spawnBriefing(
  ws: Workspace, factory: string[], run: string, id: string, prompt: string,
  render: (reply: string) => Pick<Observation, "level" | "icon">,
): void {
  if (briefInFlight.has(id)) return;
  if (readBriefings(ws).some((o) => o.id === id)) return; // already briefed
  if (ws.jobs.chat.state === "running") return; // don't collide on the shared session
  briefInFlight.add(id);

  const [cmd, ...prefix] = factory;
  // --json gives us the structured answer (reply + machine-executable
  // suggestions) instead of prose, so proposals become one-click buttons.
  const child = spawn(cmd!, [...prefix, "ask", "--json", prompt], {
    cwd: ws.workdir, shell: false, windowsHide: true, env: process.env,
  });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString("utf-8")));
  child.stderr.on("data", (c: Buffer) => (out += c.toString("utf-8")));
  child.on("error", () => briefInFlight.delete(id));
  child.on("exit", (code) => {
    briefInFlight.delete(id);
    const raw = out.trim();
    if (code !== 0 || !raw) return;
    const { text, suggestions } = parseAnswer(raw);
    if (!text) return;
    const { level, icon } = render(text);
    const obs: Observation = {
      id, ts: new Date().toISOString(), run, level, degree: 1, icon,
      text: text.slice(0, 2000), kind: "briefing",
      ...(suggestions.length ? { suggestions } : {}),
    };
    try { appendFileSync(briefingsFile(ws), JSON.stringify(obs) + "\n", "utf-8"); } catch { /* best effort */ }
    pushCompanion(ws, obs);
    // Token saver: the wrap-up closes the run's chapter, so retire the shared
    // supervisor session. It grows with every chat + briefing and is otherwise
    // NEVER reset — each exchange would re-pay an ever-longer history. The next
    // ask starts a fresh session (contract re-sent once; the ground truth lives
    // in the files it reads, not in the conversation).
    if (id.endsWith("#wrapup")) {
      try { unlinkSync(join(ws.workdir, ".supervisor-session")); } catch { /* none yet */ }
    }
  });
}


/** LLM wrap-up of a run that just finished. Once per run (durable dedup). */
export function composeWrapup(ws: Workspace, factory: string[], run: string, counts: Record<string, number>): void {
  const failed = counts.FAILED ?? 0;
  const prompt =
    "The run just finished. In 2-3 sentences, give the operator a wrap-up: what shipped, " +
    "anything that failed or still needs their attention, and what you'd suggest doing next. " +
    "Ground it in the run's events. Warm and concrete, no preamble. Do not take any action.";
  spawnBriefing(ws, factory, run, `brief#${run}#wrapup`, prompt,
    () => ({ level: failed ? "warn" : "good", icon: "🤖" }));
}


/** LLM diagnosis when a live run goes quiet while work is still in flight. The
 *  gap-anchored id fires it at most once per quiet period. */
export function composeStall(ws: Workspace, factory: string[], run: string, quietSince: number, activeN: number): void {
  const mins = Math.round((Date.now() - quietSince) / 60000);
  const prompt =
    `Nothing has moved for about ${mins} minute(s), yet ${activeN} task(s) are still in flight. ` +
    "Look at the running agents' recent activity (their stdout logs) and tell the operator in 1-2 " +
    "sentences what is happening and whether they should step in. Concrete, no preamble. Do not act.";
  spawnBriefing(ws, factory, run, `brief#${run}#stall#${quietSince}`, prompt,
    () => ({ level: "warn", icon: "🐢" }));
}


/** Periodic mid-run stand-up: the companion's proactive "here's where we are"
 *  while a run is progressing. The `n`-suffixed id keeps each one distinct. */
export function composeStandup(ws: Workspace, factory: string[], run: string, n: number): void {
  const prompt =
    "Give the operator a brief mid-run stand-up: where things stand now, what's in flight, " +
    "and anything worth keeping an eye on. 2-3 sentences, concrete, grounded in the run's events. " +
    "No preamble. Do not take any action.";
  spawnBriefing(ws, factory, run, `brief#${run}#standup#${n}`, prompt,
    () => ({ level: "info", icon: "📋" }));
}


/* ------------------------------ supervisor chat history ------------------------------ */

// One turn of the operator <-> supervisor conversation. Since the companion and
// the supervisor merged into one thread, each turn also carries the run it was
// said during (gates the reply's one-click suggestions to the live run).
export interface ChatMsg {
  who: "you" | "supervisor";
  text: string;
  ts: string;
  run?: string;
  suggestions?: ObsAction[];
}


export function chatHistoryFile(ws: Workspace): string {
  return join(ws.workdir, ".supervisor-chat.jsonl");
}


export function readChatHistory(ws: Workspace): ChatMsg[] {
  const file = chatHistoryFile(ws);
  if (!existsSync(file)) return [];
  const out: ChatMsg[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ChatMsg); } catch { /* skip a torn line */ }
  }
  return out;
}


export function appendChatMsg(ws: Workspace, msg: ChatMsg): void {
  appendFileSync(chatHistoryFile(ws), JSON.stringify(msg) + "\n", "utf-8");
}


/** A chat turn as a timeline Observation. The id is the line index in the
 *  history file — stable across reloads, so the client dedups history vs SSE. */
export function chatObs(m: ChatMsg, i: number): Observation {
  const base = { id: `chat#${i}`, ts: m.ts, run: m.run ?? "", degree: 0 as const, level: "info" as const };
  return m.who === "you"
    ? { ...base, icon: "•", text: m.text, kind: "chat", who: "you" }
    : { ...base, icon: "🤖", text: m.text, kind: "briefing",
        ...(m.suggestions?.length ? { suggestions: m.suggestions } : {}) };
}


export function chatObservations(ws: Workspace): Observation[] {
  return readChatHistory(ws).map(chatObs);
}

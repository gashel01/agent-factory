/* Extracted from app.tsx — mechanical split. */
/** Agent Factory dashboard — React app. Mounts into #app. */

import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import type {
  BlockedContext, FactoryEvent, TaskState,
  CapsuleAction, CapsuleConsent, CapsulePanel, CapsuleView,
} from "./types.js";
import {
  api, fetchJSON, getText, getWs, initToken, initWs, postJSON, repoGet, repoPath, scopedJSON, setRepoPath, setWs,
} from "./api.js";
import {
  ACTIVITY, Checkpoint, EFFORT_CHOICES, HistoryTicket, MODEL_CHOICES, Model, Settings, StoryItem, TaskModel,
  ago, fmtDuration, fmtTokens, fmtUsd, freshModel, generateConfig, inFlight, narrate,
  parseDiff, parseSettings, reduce, seedHistory,
} from "./model.js";
import { langFromPath, tokenizeLine } from "./highlight.js";
import { qrSvg } from "./qr.js";
import type { Observation } from "./companion.js";
import {
  ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpFromLine,
  BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Circle,
  CircleDot, CircleHelp, Command, CompanionIcon, CornerDownLeft, CornerDownRight,
  ExternalLink, Eye, FileText, FlaskConical, Flag, Folder, FolderOpen, FolderPlus,
  GitBranch, GitMerge, Globe, InfinityIcon, Key, Laptop, Lightbulb, ListChecks, Lock, MessageCircle,
  MoreHorizontal, Palette, Pause, Pencil, Play, Plus, RotateCw, Search, Send,
  ShieldCheck, Smartphone, Sparkles, Square, Terminal, Timer, Trash2, TriangleAlert, Undo2, Upload, X,
} from "./icons.js";
import type { LucideIcon } from "./icons.js";
import { Button, STATE_META, Skeleton, StatusPill } from "./core.js";
import { describe } from "./modals.js";
import { ConfirmButton, Modal, quickRun, sendControl } from "./widgets.js";
import { Ticket, ticketTitle } from "./work.js";

/* --------------------------------- board --------------------------------- */

export type Screen = "projects" | "cockpit" | "memory";

export type ModalState =
  | null
  | { type: "settings" }
  | { type: "newwork"; tab?: "one" | "goal"; goal?: string }
  | { type: "editticket"; ticket: BoardTicket }
  | { type: "repo" }
  | { type: "preview" }
  | { type: "cockpit" }
  | { type: "removed" }
  | { type: "answer"; taskId: string; title: string; question: string; context: BlockedContext | null }
  | { type: "lesson"; draft: { text: string; ticketId: string } }
  | { type: "runguard" }
  | { type: "appearance" }
  | { type: "diff"; taskId: string; title: string; diff: { repo: string; from: string; to: string } }
  | { type: "review"; taskId: string }
  | { type: "analytics" }
  | { type: "depgraph" }
  | { type: "cmdk" }
  | { type: "docs" }
  | { type: "aireview"; file: string; title: string }
  | { type: "log"; taskId: string; title: string };

export function headline(model: Model, runActive: boolean): { text: string; tone: string } {
  if (!model.run) return { text: "No run yet — describe some work to begin.", tone: "warning" };
  if (!model.endedTs && !runActive) {
    return {
      text: "This run is no longer active — its process has stopped. Start a new run to finish the rest.",
      tone: "warning",
    };
  }
  const tasks = [...model.tasks.values()];
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const blocked = tasks.filter((t) => t.state === "BLOCKED").length;
  const done = tasks.filter((t) => t.state === "DONE").length;
  if (model.endedTs) {
    const queued = tasks.filter((t) => t.state === "QUEUED").length;
    if (model.budgetHit) {
      return { text: `Stopped — budget reached (${fmtUsd(model.spentUsd)}). Raise it in Settings, then run again.`, tone: "warning" };
    }
    if (model.stopped || queued > 0) {
      return { text: `Stopped — ${queued} task${queued > 1 ? "s" : ""} still waiting. They run on the next start.`, tone: "warning" };
    }
    if (failed === 0 && blocked === 0) return { text: "All done — everything merged.", tone: "good" };
    const parts = [`${done} merged`];
    if (failed) parts.push(`${failed} failed`);
    if (blocked) parts.push(`${blocked} waiting on you`);
    return { text: `Finished: ${parts.join(", ")}.`, tone: failed ? "critical" : "warning" };
  }
  if (blocked > 0) return { text: `${blocked} task${blocked > 1 ? "s" : ""} need${blocked > 1 ? "" : "s"} you.`, tone: "warning" };
  if (model.manualPause) return { text: "Paused by you.", tone: "warning" };
  if (model.ratePause) return { text: `Paused — usage limit hit, retrying in ${fmtDuration(model.ratePause.cooldown_s)}. Nothing is lost.`, tone: "warning" };
  return { text: "Everything is running fine.", tone: "good" };
}

/** Post-run integration check (DevOps): the full suite on the merged branch. */
export function IntegrationBanner({ integ }: { integ: Model["integration"] }): JSX.Element | null {
  const { running, results } = integ;
  if (!running && results.length === 0) return null;
  const failed = results.filter((r) => !r.ok);
  const tone = running ? "run" : failed.length ? "fail" : "pass";
  return (
    <div className={`integ-banner integ-${tone}`}>
      <span className="integ-icon">{running ? <RotateCw size={13} /> : failed.length ? <X size={13} /> : <Check size={13} />}</span>
      <div className="integ-body">
        {running
          ? <strong>Integration check running… (the full suite on the merged branch)</strong>
          : failed.length
            ? <strong>Integration check failed — the merged tickets don't hold together</strong>
            : <strong>Integration check passed — the merged tickets hold together</strong>}
        {failed.map((r, i) => (
          <div key={i} className="integ-fail">
            <span className="mono">{r.repo.split(/[\\/]/).pop()}</span>
            <ul>{r.failures.map((f, j) => <li key={j}>{f}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The payoff panel a finished run deserves — what shipped, in numbers, above the
 *  board. Without it the completed state is an empty Kanban under a green bar. */
export function RunSummary(
  { tasks, startedTs, endedTs, spent, tokens, mode, onAnalytics }:
  { tasks: TaskModel[]; startedTs: string | null; endedTs: string | null; spent: number; tokens: number;
    mode?: "subscription" | "api"; onAnalytics?: () => void },
): JSX.Element | null {
  const merged = tasks.filter((t) => t.state === "DONE");
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const blocked = tasks.filter((t) => t.state === "BLOCKED" || t.state === "AWAITING_APPROVAL").length;
  if (merged.length === 0 && failed === 0) return null;
  const clean = failed === 0 && blocked === 0;
  const dur = startedTs && endedTs ? (Date.parse(endedTs) - Date.parse(startedTs)) / 1000 : null;
  const title = clean
    ? `Run complete — ${merged.length} ticket${merged.length === 1 ? "" : "s"} shipped`
    : `Run finished — ${merged.length} shipped${failed ? `, ${failed} failed` : ""}${blocked ? `, ${blocked} waiting on you` : ""}`;
  return (
    <section className={`run-summary${clean ? " clean" : ""}`} aria-label="Run summary">
      <div className="rs-head">
        <span className="rs-badge" aria-hidden="true">{clean ? <Check size={16} /> : <CircleDot size={16} />}</span>
        <div>
          <div className="rs-title">{title}</div>
          <div className="rs-sub">{clean ? "Merged into your base branch and verified." : "Some tickets need a look before they're done."}</div>
        </div>
      </div>
      <div className="rs-stats">
        <div className="rs-stat"><span className="rs-n tnum">{merged.length}</span><span className="rs-k">shipped</span></div>
        {dur !== null && <div className="rs-stat"><span className="rs-n tnum">{fmtDuration(dur)}</span><span className="rs-k">wall time</span></div>}
        <div className="rs-stat"><span className="rs-n tnum">{fmtUsd(spent)}</span><span className="rs-k">{mode === "api" ? "cost" : "est. cost"}</span></div>
        <div className="rs-stat"><span className="rs-n tnum">{fmtTokens(tokens)}</span><span className="rs-k">tokens</span></div>
        {onAnalytics && (
          <button className="rs-trend" onClick={onAnalytics}>Cost &amp; activity across runs <ArrowRight size={13} /></button>
        )}
      </div>
      {merged.length > 0 && (
        <ul className="rs-list">
          {merged.slice(0, 6).map((t) => <li key={t.id}>{t.title}</li>)}
          {merged.length > 6 && <li className="rs-more">+{merged.length - 6} more</li>}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------ cost analytics (D8) ------------------------------ */

export interface RunPoint { run: string; ts: string | null; spend: number; tokens: number; merged: number; needs: number; total: number; mode?: "subscription" | "api" }

/** A dependency-free SVG bar chart, theme-aware via currentColor + CSS vars.
 *  A bar reveals its value + run on hover (desktop) or tap (mobile). */
export function BarChart(
  { data, fmt, height = 120 }:
  { data: Array<{ label: string; value: number; hint: string }>; fmt: (n: number) => string; height?: number },
): JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const n = Math.max(1, data.length);
  const bw = 100 / n;
  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img"
        aria-label={data.length ? `Bar chart, ${data.length} point${data.length === 1 ? "" : "s"}, latest ${fmt(data[data.length - 1]!.value)}` : "Bar chart, no data"}>
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 18);
          return (
            <rect key={i} className={`bar${active === i ? " on" : ""}`} x={i * bw + bw * 0.15} y={height - 14 - h}
              width={bw * 0.7} height={Math.max(0.5, h)} rx={0.6}
              onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive((a) => (a === i ? null : a))}
              onClick={() => setActive((a) => (a === i ? null : i))} />
          );
        })}
      </svg>
      {active !== null && data[active] && (
        <div className="chart-tip" style={{ left: `${Math.min(88, Math.max(12, (active + 0.5) * bw))}%` }}>
          <span className="chart-tip-v">{data[active]!.hint}</span>
          <span className="chart-tip-l">{data[active]!.label}</span>
        </div>
      )}
    </div>
  );
}

/** A run id like "2026-07-17_203726" → a human date+time, from the timestamp when
 *  present (falls back to parsing the id). */
export function humanRun(r: RunPoint): string {
  const d = r.ts ? new Date(r.ts) : null;
  if (d && !Number.isNaN(d.getTime())) {
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }
  return r.run.replace(/^\d{4}-/, "").replace("_", " · ");
}

export function AnalyticsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [series, setSeries] = useState<RunPoint[] | null>(null);
  useEffect(() => {
    void fetchJSON<{ series: RunPoint[] }>("/api/analytics").then((r) => setSeries(r.series)).catch(() => setSeries([]));
  }, []);
  const runs = series ?? [];
  const totalSpend = runs.reduce((a, r) => a + r.spend, 0);
  const totalTokens = runs.reduce((a, r) => a + r.tokens, 0);
  const totalMerged = runs.reduce((a, r) => a + r.merged, 0);
  const peakSpend = Math.max(0, ...runs.map((r) => r.spend));
  const peakTokens = Math.max(0, ...runs.map((r) => r.tokens));
  const costCaption = runs.every((r) => r.mode !== "api") ? "estimated · not billed"
    : runs.every((r) => r.mode === "api") ? "billed to your API key" : "estimated · some billed";
  return (
    <Modal title="Cost & activity over time" onClose={onClose} wide>
      {series === null ? <Skeleton lines={4} />
        : runs.length === 0 ? <p className="hint">No runs yet — this fills in once you've run some work.</p>
        : (
          <div className="analytics">
            <p className="an-intro">Every run you've done — what it cost, how many tokens it used, and how many tickets it shipped.</p>
            <div className="an-tiles">
              <div className="an-tile"><span className="an-fig">{fmtUsd(totalSpend)}</span><span className="an-cap">{costCaption}</span></div>
              <div className="an-tile"><span className="an-fig">{fmtTokens(totalTokens)}</span><span className="an-cap">tokens used</span></div>
              <div className="an-tile"><span className="an-fig">{totalMerged}</span><span className="an-cap">tickets shipped · {runs.length} run{runs.length > 1 ? "s" : ""}</span></div>
            </div>

            <div className="an-chart-block">
              <div className="an-chart-head"><h4 className="an-h">What each run cost</h4>{peakSpend > 0 && <span className="an-peak">most expensive: {fmtUsd(peakSpend)}</span>}</div>
              <BarChart data={runs.map((r) => ({ label: humanRun(r), value: r.spend, hint: fmtUsd(r.spend) }))} fmt={fmtUsd} />
            </div>
            <div className="an-chart-block">
              <div className="an-chart-head"><h4 className="an-h">Tokens each run used</h4>{peakTokens > 0 && <span className="an-peak">busiest: {fmtTokens(peakTokens)}</span>}</div>
              <BarChart data={runs.map((r) => ({ label: humanRun(r), value: r.tokens, hint: fmtTokens(r.tokens) }))} fmt={fmtTokens} />
            </div>

            <div className="an-table">
              <div className="an-row an-head">
                <span>Run</span><span>Cost</span><span>Tokens</span><span>Result</span>
              </div>
              {[...runs].reverse().map((r) => (
                <div key={r.run} className="an-row">
                  <span className="an-when">{humanRun(r)}</span>
                  <span className="an-spend">{fmtUsd(r.spend)}</span>
                  <span className="an-tok">{fmtTokens(r.tokens)}</span>
                  <span className="an-result">
                    {r.merged > 0
                      ? <span className="ok">{r.merged} shipped</span>
                      : <span className="none">nothing shipped</span>}
                    {r.needs > 0 && <span className="warn"> · {r.needs} need you</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
    </Modal>
  );
}

/* ------------------------------ dependency graph (D7) ------------------------------ */

export interface DepNode { id: string; title: string; deps: string[] }

export function parseTicketDeps(content: string): { id: string; title: string; deps: string[] } {
  const id = content.match(/^id:\s*["']?([\w.-]+)["']?/m)?.[1] ?? "?";
  const title = ticketTitle(content);
  const depLine = content.match(/^depends_on:\s*(.+)$/m)?.[1] ?? "";
  const deps = [...depLine.matchAll(/["']?([\w.-]+)["']?/g)].map((m) => m[1]!).filter((d) => d && d !== "[]");
  return { id, title, deps };
}

/** Longest-path layering → columns; simple, no crossing-minimisation, but enough
 *  to read what blocks what and the critical path. */
export function layerNodes(nodes: DepNode[]): DepNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const n = byId.get(id);
    const d = n && n.deps.length ? 1 + Math.max(...n.deps.map((x) => compute(x, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) compute(n.id, new Set());
  const maxD = Math.max(0, ...[...depth.values()]);
  const layers: DepNode[][] = Array.from({ length: maxD + 1 }, () => []);
  for (const n of nodes) layers[depth.get(n.id) ?? 0]!.push(n);
  return layers;
}

export function DepGraphModal({ stateOf, onClose }: { stateOf: (id: string) => TaskState | undefined; onClose: () => void }): JSX.Element {
  const [nodes, setNodes] = useState<DepNode[] | null>(null);
  useEffect(() => {
    void fetchJSON<{ tickets: Array<{ content: string }> }>("/api/backlog")
      .then((r) => setNodes(r.tickets.map((t) => parseTicketDeps(t.content))))
      .catch(() => setNodes([]));
  }, []);
  if (nodes === null) return <Modal title="Ticket dependencies" onClose={onClose} wide><Skeleton lines={4} /></Modal>;
  if (nodes.length === 0) return <Modal title="Ticket dependencies" onClose={onClose} wide><p className="hint">No pending tickets — the graph shows the current backlog (merged tickets are archived).</p></Modal>;

  const layers = layerNodes(nodes);
  const COL = 210, ROW = 92, NW = 168, NH = 58, PAD = 24;
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, ci) => layer.forEach((n, ri) => pos.set(n.id, { x: PAD + ci * COL, y: PAD + ri * ROW })));
  const width = PAD * 2 + Math.max(1, layers.length) * COL;
  const height = PAD * 2 + Math.max(1, ...layers.map((l) => l.length)) * ROW;
  const fam = (id: string): string => {
    const st = stateOf(id);
    return st ? (STATE_META[st]?.fam ?? "upnext") : "upnext";
  };
  return (
    <Modal title="Ticket dependencies" onClose={onClose} wide>
      <p className="hint dep-legend">Arrows point from a ticket to what it depends on. Columns are the execution order (leftmost runs first).</p>
      <div className="depgraph-scroll">
        <svg className="depgraph" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="dep-arrowhead" />
            </marker>
          </defs>
          {nodes.flatMap((n) => n.deps.map((d) => {
            const a = pos.get(n.id), b = pos.get(d);
            if (!a || !b) return null;
            const x1 = a.x, y1 = a.y + NH / 2, x2 = b.x + NW, y2 = b.y + NH / 2;
            const mx = (x1 + x2) / 2;
            return <path key={`${n.id}-${d}`} className="dep-edge" markerEnd="url(#arrow)" d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} />;
          }))}
          {nodes.map((n) => {
            const p = pos.get(n.id)!;
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                <rect className={`dep-node fam-${fam(n.id)}`} width={NW} height={NH} rx={8} />
                <text className="dep-id" x={10} y={20}>{n.id}</text>
                <text className="dep-title" x={10} y={38}>{n.title.length > 26 ? n.title.slice(0, 25) + "…" : n.title}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </Modal>
  );
}

/** Remote sync outcome at run start (PR mode keeps the base fresh). */
export function SyncNote({ sync }: { sync: Model["sync"] }): JSX.Element | null {
  if (!sync || (sync.behind === 0 && sync.ahead === 0)) return null;
  const msg = sync.pulled
    ? `Base was ${sync.behind} commit${sync.behind > 1 ? "s" : ""} behind the remote — pulled to catch up.`
    : sync.behind > 0
      ? `Base is ${sync.behind} behind and ${sync.ahead} ahead of the remote (diverged) — not pulled; reconcile by hand.`
      : `Base is ${sync.ahead} commit${sync.ahead > 1 ? "s" : ""} ahead of the remote (unpushed).`;
  return (
    <div className={`sync-note ${sync.pulled ? "sync-pulled" : "sync-warn"}`}>
      <span className="sync-icon">{sync.pulled ? <ArrowDownToLine size={13} /> : <ArrowUpFromLine size={13} />}</span>
      <span>{msg}</span>
    </div>
  );
}

/* --------------------------------- kanban --------------------------------- */

/** States a new run would actually (re-)execute — what "Run again (N)" counts.
 *  Excludes DONE (merged), AWAITING_APPROVAL (finished, needs your approval — not a
 *  re-run) and MERGE_QUEUED/MERGING (already succeeded, about to land). */
export const RERUNNABLE: ReadonlySet<TaskState> = new Set<TaskState>([
  "QUEUED", "RUNNING", "VERIFYING", "REVIEWING", "FAILED", "BLOCKED",
] as TaskState[]);

export const COLUMNS: Array<{ key: string; title: string; states: TaskState[]; tone: string }> = [
  { key: "queued", title: "Up next", states: ["QUEUED"], tone: "neutral" },
  { key: "working", title: "Working", states: ["RUNNING"], tone: "accent" },
  { key: "checking", title: "Checking", states: ["VERIFYING", "REVIEWING"], tone: "accent" },
  { key: "approval", title: "To review", states: ["AWAITING_APPROVAL"], tone: "critical" },
  { key: "merging", title: "Merging", states: ["MERGE_QUEUED", "MERGING"], tone: "accent" },
  { key: "done", title: "Merged", states: ["DONE"], tone: "good" },
  { key: "attention", title: "Needs you", states: ["FAILED", "BLOCKED"], tone: "critical" },
];

/** Inline actions for a card, mirroring the prototype's per-status button set. */
export function CardActions(
  { t, live, onLog, onAnswer, onLesson, onDiff }:
  { t: TaskModel; live: boolean; onLog: () => void; onAnswer: () => void; onLesson: () => void; onDiff: () => void },
): JSX.Element {
  const attention = t.state === "FAILED" || t.state === "BLOCKED";
  return (
    <div className="kcard-actions" onClick={(e) => e.stopPropagation()}>
      {t.state === "BLOCKED" && live && (
        <button className="act primary" onClick={onAnswer}>Answer</button>
      )}
      {attention && !(t.state === "BLOCKED" && live) && (live
        ? <Button kind="act" variant="primary" autoPending onClick={() => sendControl("retry", t.id)}>Try again</Button>
        : <button className="act primary" onClick={() => void quickRun()}>Run again</button>)}
      {(t.state === "RUNNING" || t.state === "VERIFYING" || t.state === "REVIEWING") && live && (
        <Button kind="act" variant="danger" autoPending onClick={() => sendControl("kill", t.id)}>Stop</Button>
      )}
      {t.state === "AWAITING_APPROVAL" && (
        <Button kind="act" variant="primary" autoPending onClick={() => sendControl("approve", t.id)}>Approve</Button>
      )}
      {t.state === "AWAITING_APPROVAL" && (
        <button className="act ghost" onClick={onDiff}>Review</button>
      )}
      {t.state === "AWAITING_APPROVAL" && live && (
        <ConfirmButton label="Discard" confirm="Discard before merge?" plain className="act danger"
          onConfirm={() => void sendControl("kill", t.id)} />
      )}
      {t.state === "QUEUED" && live && (
        <ConfirmButton label="Cancel" confirm="Remove before it runs?" plain className="act danger"
          onConfirm={() => void sendControl("kill", t.id)} />
      )}
      {attention && (
        <button className="act ghost" onClick={onLesson} title="Record what went wrong as a lesson for next time">Save lesson</button>
      )}
      {t.state === "DONE" && t.prUrl && (
        <a className="act ghost" href={t.prUrl} target="_blank" rel="noreferrer">View PR <ExternalLink size={13} /></a>
      )}
      {t.state === "DONE" && t.diff && (
        <button className="act ghost" onClick={onDiff}>View diff</button>
      )}
      {t.diff?.repo && (
        <a className="act ghost" title="Open the repo in your IDE"
          href={`vscode://file/${t.diff.repo.replace(/\\/g, "/")}`}>Open in IDE</a>
      )}
      {t.state !== "AWAITING_APPROVAL" && (
        <button className="act ghost" onClick={onLog}>{inFlight(t.state) ? "Watch live" : "History"}</button>
      )}
    </div>
  );
}

/** The measures band: live timer (chip-coloured) · cost · tokens · attempt. */
export function CardMeasures({ t, now }: { t: TaskModel; now: number }): JSX.Element | null {
  const running = t.state === "RUNNING" && t.runningSince !== null;
  const hasTimer = running || t.wallS !== null;
  const liveTokens = running && t.liveTokens > 0;
  if (!hasTimer && t.costUsd === 0 && t.retries === 0) return null;
  return (
    <div className="meas">
      {running
        ? <span className="timer"><span className="d" />{fmtDuration((now - t.runningSince!) / 1000)}</span>
        : t.wallS !== null ? <span className="cost">{fmtDuration(t.wallS)}</span> : null}
      {/* While running, show the live turn/token count (C6); after, the final cost. */}
      {running && t.liveTurns > 0 && <span className="tok" title="Turns so far">turn {t.liveTurns}</span>}
      {liveTokens && <span className="tok live" title="Tokens so far (live)">{fmtTokens(t.liveTokens)}</span>}
      {!running && t.costUsd > 0 && <span className="cost" title="Cost">{fmtUsd(t.costUsd)}</span>}
      {!running && t.tokens > 0 && <span className="tok" title="Tokens">{fmtTokens(t.tokens)}</span>}
      {t.retries > 0 && <span className="try">attempt {t.retries + 1}</span>}
    </div>
  );
}

export function KanbanCard(
  { t, live, now, onLog, onAnswer, onLesson, onDiff, onDelete }:
  { t: TaskModel; live: boolean; now: number; onLog: () => void; onAnswer: () => void; onLesson: () => void; onDiff: () => void; onDelete?: () => void },
): JSX.Element {
  const attention = t.state === "FAILED" || t.state === "BLOCKED";
  const running = t.state === "RUNNING";
  return (
    <div className={`kcard state-${t.state.toLowerCase()}`} onClick={onLog}
      role="button" tabIndex={0} aria-label={`${t.id} ${t.title} — ${STATE_META[t.state].label}. Open its history`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onLog(); } }}
      title="Open its history">
      <div className="kcard-head">
        <span className="kcard-id">{t.id}</span>
        {t.model && <span className="model-badge" title="Model pinned for this ticket">{t.model}</span>}
        {t.effort && <span className="model-badge" title="Reasoning effort pinned for this ticket"><Brain size={12} /> {t.effort}</span>}
        <StatusPill state={t.state} live={running} />
        {onDelete && (
          <button className="btn icon kcard-del" aria-label="Remove from board" title="Remove from the board (keeps run history — restore it from “Removed”)"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
        )}
      </div>
      <div className="kcard-title">{t.title}</div>
      <div className="kcard-activity">
        {running && <span className="pulse" />}
        <span>{t.note && !attention ? t.note : ACTIVITY[t.state]}</span>
      </div>
      {attention && t.note && <div className="kcard-note"><span className="flag"><Flag size={12} /></span><span>{t.note}</span></div>}
      <CardMeasures t={t} now={now} />
      <CardActions t={t} live={live} onLog={onLog} onAnswer={onAnswer} onLesson={onLesson} onDiff={onDiff} />
    </div>
  );
}

export interface BoardTicket {
  file: string; content: string; id: string; title: string;
  assignee: "ai" | "human"; status: string; hold: boolean;
}

/** Removed tickets: hidden from the board (history + files intact), restorable. */
export function RemovedModal(
  { removed, onRestore, onClose }:
  { removed: Array<{ id: string; title: string }>; onRestore: (id: string) => Promise<void>; onClose: () => void },
): JSX.Element {
  return (
    <Modal title="Removed tickets" onClose={onClose}>
      <p className="phone-sub" style={{ marginTop: 0 }}>
        These are hidden from the board only — their run history and files are untouched. Restore any of them below.
      </p>
      {removed.length === 0 ? (
        <div className="kcol-empty">Nothing removed.</div>
      ) : (
        <div className="removed-list">
          {removed.map((r) => (
            <div key={r.id} className="removed-row">
              <span className="kcard-id">{r.id}</span>
              <span className="removed-title">{r.title}</span>
              <Button kind="btn" variant="ghost" autoPending onClick={() => onRestore(r.id)}>
                <RotateCw size={13} /> Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** The "+ Add a ticket" affordance that lives in the Up-next column (and Focus). */
export function AddTicketCard({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button className="add-ticket-card" onClick={onClick}>
      <Plus size={16} /> <span>Add a ticket</span>
    </button>
  );
}

/** An AI backlog ticket drafted but not yet run — a light "queued" card in Up
 *  next. It can be paused (hold), handed to the developer, edited or deleted. */
export function DraftCard(
  { draft, onEdit, onDelete, onAssign, onHold }:
  { draft: BoardTicket; onEdit: () => void; onDelete: () => void; onAssign: () => void; onHold: () => void },
): JSX.Element {
  return (
    <div className={`kcard draft-card${draft.hold ? " is-held" : ""}`} role="button" tabIndex={0} onClick={onEdit}
      onKeyDown={(e) => { if (e.key === "Enter") onEdit(); }}>
      <div className="kcard-head">
        <span className="kcard-id">{draft.id}</span>
        <span className="draft-chip">{draft.hold ? "held" : "draft"}</span>
        <button className="btn icon draft-edit" aria-label="Edit ticket" title="Edit this ticket" onClick={(e) => { e.stopPropagation(); onEdit(); }}><Pencil size={13} /></button>
        <button className="btn icon draft-del" aria-label="Delete ticket" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
      </div>
      <div className="kcard-title">{draft.title}</div>
      <div className="kcard-actions" onClick={(e) => e.stopPropagation()}>
        <button className="act ghost" title={draft.hold ? "Let a run pick this up again" : "Pause: a run will skip this ticket"}
          onClick={(e) => { e.stopPropagation(); onHold(); }}>{draft.hold ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Hold</>}</button>
        <button className="act ghost" title="Take it yourself — the AI won't run it"
          onClick={(e) => { e.stopPropagation(); onAssign(); }}><Laptop size={13} /> Do it myself</button>
      </div>
    </div>
  );
}

/** A human-owned ticket: the developer's own work, dragged across the board and
 *  never touched by the AI. Drag it between columns to set its status; hand it to
 *  the AI to drop it back into the automated pipeline. */
export function ManualCard(
  { ticket, onDragStart, onDragEnd, onEdit, onAssignAi, onDelete, onReview }:
  { ticket: BoardTicket; onDragStart: () => void; onDragEnd: () => void; onEdit: () => void; onAssignAi: () => void;
    onDelete: () => void; onReview: () => void },
): JSX.Element {
  return (
    <div className="kcard manual-card" draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", ticket.file); e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd} title="Drag me between columns">
      <div className="kcard-head">
        <span className="kcard-id">{ticket.id}</span>
        <span className="you-chip"><Laptop size={11} /> You</span>
        <button className="btn icon draft-edit" aria-label="Edit ticket" title="Edit this ticket" onClick={(e) => { e.stopPropagation(); onEdit(); }}><Pencil size={13} /></button>
        <button className="btn icon draft-del" aria-label="Delete ticket" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
      </div>
      <div className="kcard-title">{ticket.title}</div>
      <div className="kcard-actions">
        {(ticket.status === "review" || ticket.status === "done") && (
          <button className="act primary" title="Optional: let the AI review the work you just finished"
            onClick={(e) => { e.stopPropagation(); onReview(); }}><Sparkles size={13} /> Ask AI to review</button>
        )}
        <button className="act ghost" title="Hand this ticket to the AI agents" onClick={(e) => { e.stopPropagation(); onAssignAi(); }}><Bot size={13} /> Give to AI</button>
      </div>
    </div>
  );
}

/** Opt-in companion review: the AI reads the diff of a manual ticket the dev just
 *  finished, against the ticket's intent, and gives concise feedback. Purely a
 *  choice — nothing runs unless the operator asks for it from a done manual card. */
export function AiReviewModal(
  { file, title, onClose, onSendToAi }:
  { file: string; title: string; onClose: () => void; onSendToAi: (review: string) => Promise<void> },
): JSX.Element {
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [text, setText] = useState("");
  useEffect(() => {
    void (async () => {
      try {
        const r = await postJSON<{ review?: string; error?: string }>("/api/ticket/review", { file });
        const body = r.review?.trim();
        if (body) { setText(body); setState("done"); }
        else { setText(r.error || "The reviewer returned nothing — try again in a moment."); setState("error"); }
      } catch (err) { setText(String(err)); setState("error"); }
    })();
  }, [file]);
  return (
    <Modal title={`AI review — ${title}`} onClose={onClose}>
      {state === "loading"
        ? <div className="ai-review-wait"><span className="spinner" /> Reading your changes and reviewing…</div>
        : <div className={`ai-review${state === "error" ? " is-error" : ""}`}>{text}</div>}
      {state === "done" && (
        <div className="ai-review-actions">
          <button className="btn ghost" onClick={onClose}>Looks good — close</button>
          <Button kind="btn" variant="primary" autoPending onClick={() => onSendToAi(text)}>
            <Bot size={14} /> Hand to AI to fix
          </Button>
        </div>
      )}
    </Modal>
  );
}

/** Which board column a manual ticket's status lives in, and the reverse: the
 *  status a manual ticket takes when dropped in a given column. Manual work only
 *  ever sits in these three human-meaningful lanes. */
export const MANUAL_COL: Record<string, string> = { todo: "queued", doing: "working", review: "approval", done: "done" };
export const COL_STATUS: Record<string, string> = { queued: "todo", working: "doing", approval: "review", done: "done" };

export function Kanban(
  { tasks, live, now, onLog, onAnswer, onLesson, onDiff, focus, pending, manual,
    onAddTicket, onEditTicket, onRemoveTicket, onRemoveTask, onMoveManual, onSetAssignee, onSetHold, onReviewManual }:
  { tasks: TaskModel[]; live: boolean; now: number; onLog: (t: TaskModel) => void;
    onAnswer: (t: TaskModel) => void; onLesson: (t: TaskModel) => void; onDiff: (t: TaskModel) => void; focus?: boolean;
    pending: BoardTicket[]; manual: BoardTicket[]; onAddTicket: () => void; onEditTicket: (bt: BoardTicket) => void;
    onRemoveTicket: (bt: BoardTicket) => void; onRemoveTask: (id: string) => void; onMoveManual: (bt: BoardTicket, status: string) => void;
    onSetAssignee: (bt: BoardTicket, toHuman: boolean) => void; onSetHold: (bt: BoardTicket, on: boolean) => void;
    onReviewManual: (bt: BoardTicket) => void },
): JSX.Element {
  const [drag, setDrag] = useState<string | null>(null); // file of the manual card being dragged
  const boardRef = useRef<HTMLElement>(null);
  // Pin every column that FITS the board so it never scrolls; only a column taller
  // than the viewport stays unpinned and scrolls (as a whole) with the board. CSS
  // alone can't tell short from tall, so measure after each render (7 cols = cheap).
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const measure = (): void => {
      const bh = board.clientHeight;
      board.querySelectorAll<HTMLElement>(".kcol").forEach((col) => {
        col.classList.remove("kcol-pinned");                 // measure natural height unpinned
        col.classList.toggle("kcol-pinned", col.offsetHeight <= bh);
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  const byState = (states: TaskState[]) => tasks.filter((t) => states.includes(t.state));
  const manualIn = (colKey: string) => manual.filter((m) => (MANUAL_COL[m.status] ?? "queued") === colKey);
  // Focus view keeps only the columns that need a human, attention first.
  const cols = focus
    ? COLUMNS.filter((c) => c.key === "attention" || c.key === "working")
        .sort((a) => (a.key === "attention" ? -1 : 1))
    : COLUMNS;

  const draftCard = (d: BoardTicket) => (
    <DraftCard key={d.file} draft={d} onEdit={() => onEditTicket(d)} onDelete={() => onRemoveTicket(d)}
      onAssign={() => onSetAssignee(d, true)} onHold={() => onSetHold(d, !d.hold)} />
  );
  const manualCard = (m: BoardTicket) => (
    <ManualCard key={m.file} ticket={m} onDragStart={() => setDrag(m.file)} onDragEnd={() => setDrag(null)}
      onEdit={() => onEditTicket(m)} onAssignAi={() => onSetAssignee(m, false)}
      onDelete={() => onRemoveTicket(m)} onReview={() => onReviewManual(m)} />
  );
  const taskCard = (t: TaskModel) => (
    <KanbanCard key={t.id} t={t} live={live} now={now} onDelete={() => onRemoveTask(t.id)}
      onLog={() => onLog(t)} onAnswer={() => onAnswer(t)} onLesson={() => onLesson(t)} onDiff={() => onDiff(t)} />
  );

  // The Up-next body: the Add affordance, then running QUEUED cards, AI drafts and
  // manual "to do" cards. Keep the "No tasks" placeholder when the column is empty.
  const queuedBody = (items: TaskModel[]): JSX.Element => {
    const mine = manualIn("queued");
    return (
      <>
        <AddTicketCard onClick={onAddTicket} />
        {items.map(taskCard)}
        {pending.map(draftCard)}
        {mine.map(manualCard)}
        {items.length === 0 && pending.length === 0 && mine.length === 0 && <div className="kcol-empty">No tasks</div>}
      </>
    );
  };

  return (
    <main className={`board${focus ? " focus" : ""}`} ref={boardRef}>
      <div className="board-track">
        {cols.map((col) => {
          const items = byState(col.states);
          const mine = manualIn(col.key);
          const isQueued = col.key === "queued";
          const dropStatus = COL_STATUS[col.key]; // set only on the three human lanes
          const canDrop = !!dropStatus && drag !== null;
          const count = (isQueued ? items.length + pending.length : items.length) + mine.length;
          const isEmpty = items.length === 0 && mine.length === 0 && !isQueued;
          return (
            <section key={col.key}
              className={`kcol kcol-${col.key} tone-${col.tone}${isEmpty ? " is-empty" : ""}${canDrop ? " kcol-drop" : ""}`}
              onDragOver={canDrop ? (e) => e.preventDefault() : undefined}
              onDrop={dropStatus ? (e) => {
                e.preventDefault();
                const file = e.dataTransfer.getData("text/plain") || drag;
                const bt = manual.find((m) => m.file === file);
                if (bt && bt.status !== dropStatus) onMoveManual(bt, dropStatus);
                setDrag(null);
              } : undefined}>
              <div className="kcol-head">
                <span className="kcol-title">{col.title}</span>
                <span className="kcol-count">{count}</span>
              </div>
              <div className="kcol-body">
                {isQueued
                  ? queuedBody(items)
                  : items.length === 0 && mine.length === 0
                    ? <div className="kcol-empty">No tasks</div>
                    : <>{items.map(taskCard)}{mine.map(manualCard)}</>}
              </div>
            </section>
          );
        })}
        {/* Focus hides the queued column, but you can still add work from here. */}
        {focus && (
          <section className="kcol kcol-queued tone-neutral">
            <div className="kcol-head">
              <span className="kcol-title">Up next</span>
              <span className="kcol-count">{pending.length + manualIn("queued").length}</span>
            </div>
            <div className="kcol-body">{queuedBody([])}</div>
          </section>
        )}
      </div>
    </main>
  );
}


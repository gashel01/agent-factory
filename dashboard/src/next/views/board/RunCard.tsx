/** The run at a glance, above the board: the one-line synthesis (headline), a
 *  progress bar split by state, the counts, what it cost, and the run controls
 *  (Pause/Resume and Stop while live; Run / Run again otherwise, through the
 *  run-estimate sheet). Once a run has finished it also shows the payoff —
 *  what shipped, the wall time — like the classic RunSummary. */

import { useState } from "react";
import type { JSX } from "react";
import { ago, fmtDuration, fmtTokens, fmtUsd } from "../../../model.js";
import type { TaskModel } from "../../../model.js";
import type { TaskState } from "../../../types.js";
import { sendControl } from "../../../control.js";
import { useWarden } from "../../data.js";
import { ArrowRight, ChevronDown, ChevronUp, Pause, Play, Square } from "../../icons.js";
import { Bar, Btn, Tag } from "../../ui.js";
import { ConfirmBtn } from "./ConfirmBtn.js";

const GROUPS: Array<{ label: string; color: string; states: TaskState[] }> = [
  { label: "merged", color: "var(--st-merged)", states: ["DONE", "MERGE_QUEUED", "MERGING"] },
  { label: "to review", color: "var(--st-review)", states: ["AWAITING_APPROVAL"] },
  { label: "checking", color: "var(--st-checking)", states: ["VERIFYING", "REVIEWING"] },
  { label: "working", color: "var(--st-working)", states: ["RUNNING"] },
  { label: "need you", color: "var(--st-needs)", states: ["FAILED", "BLOCKED"] },
  { label: "up next", color: "var(--st-queued)", states: ["QUEUED"] },
];

export const TONE_COLOR: Record<string, string> = {
  good: "var(--st-merged)", warning: "var(--st-review)", critical: "var(--st-needs)", accent: "var(--st-working)",
};

function Shipped({ tasks, startedTs, endedTs }: { tasks: TaskModel[]; startedTs: string | null; endedTs: string }): JSX.Element | null {
  const merged = tasks.filter((t) => t.state === "DONE");
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const waiting = tasks.filter((t) => t.state === "BLOCKED" || t.state === "AWAITING_APPROVAL").length;
  if (merged.length === 0 && failed === 0) return null;
  const clean = failed === 0 && waiting === 0;
  const wall = startedTs ? (Date.parse(endedTs) - Date.parse(startedTs)) / 1000 : null;
  return (
    <div className="bd-shipped">
      <p className="hint">
        {clean ? "Merged into your base branch and verified." : "Some tickets need a look before they're done."}
        {wall !== null && Number.isFinite(wall) && <> Wall time {fmtDuration(wall)}.</>}
      </p>
      {merged.length > 0 && (
        <ul className="bd-shipped-list" aria-label="Shipped">
          {merged.slice(0, 6).map((t) => <li key={t.id}><span className="mono faint">{t.id}</span> {t.title}</li>)}
          {merged.length > 6 && <li className="faint">+{merged.length - 6} more</li>}
        </ul>
      )}
    </div>
  );
}

/** A finished run as one line — the board below is what matters now. What it
 *  shipped folds open on demand instead of pushing the board down. */
function FinishedRun(): JSX.Element {
  const w = useWarden();
  const { model } = w;
  const [open, setOpen] = useState(false);
  const tasks = w.visible;
  const groups = GROUPS.map((g) => ({ ...g, n: tasks.filter((t) => g.states.includes(t.state)).length })).filter((g) => g.n > 0);
  const merged = tasks.filter((t) => t.state === "DONE").length;
  return (
    <section className="card bd-run bd-run-done" aria-label="Last run">
      <div className="bd-run-main">
        <div className="row bd-run-title">
          <span className="bd-run-dot" style={{ background: TONE_COLOR[w.headline.tone] ?? "var(--st-working)" }} aria-hidden="true" />
          <b>{w.headline.text}</b>
          {model.endedTs && <span className="faint bd-run-meta">ended {ago(model.endedTs)}{w.spent > 0 ? ` · ${fmtUsd(w.spent)} ${model.mode === "api" ? "spent" : "est. cost"}` : ""}</span>}
          <span className="spacer" />
          {groups.map((g) => <Tag key={g.label} color={g.color} dot>{g.n} {g.label}</Tag>)}
        </div>
        {open && model.endedTs && <Shipped tasks={tasks} startedTs={model.startedTs} endedTs={model.endedTs} />}
      </div>
      <div className="bd-run-ctl bd-run-ctl-row">
        {merged > 0 && (
          <Btn kind="ghost" small onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {open ? "Hide" : "What shipped"}
          </Btn>
        )}
        {w.willRun > 0 && (
          <Btn kind="fill" small onClick={() => w.open({ type: "runestimate", tickets: w.willRun })}>
            <Play size={14} /> {w.rerunnable > 0 ? "Run again" : "Run"} ({w.willRun})
          </Btn>
        )}
        <Btn kind="ghost" small onClick={() => w.go("insights")}>Cost &amp; activity <ArrowRight size={13} /></Btn>
      </div>
    </section>
  );
}

export function RunCard(): JSX.Element | null {
  const w = useWarden();
  const { model } = w;
  if (!model.run && w.willRun === 0) return null;
  if (model.endedTs && !w.live) return <FinishedRun />;
  const tasks = w.visible;
  const total = tasks.length || 1;
  const groups = GROUPS.map((g) => ({ ...g, n: tasks.filter((t) => g.states.includes(t.state)).length })).filter((g) => g.n > 0);
  const tokens = w.tasks.reduce((s, t) => s + t.tokens, 0);
  const paused = model.manualPause || model.ratePause !== null;
  const budgetPct = model.budgetUsd ? Math.min(100, (w.spent / model.budgetUsd) * 100) : 0;
  const meta = [
    model.startedTs ? `started ${ago(model.startedTs)}` : "",
    model.slots ? `${model.slots} slot${model.slots > 1 ? "s" : ""}` : "",
    w.spent > 0 ? `${fmtUsd(w.spent)} ${model.mode === "api" ? "spent" : "est. cost"}` : "",
    tokens > 0 ? `${fmtTokens(tokens)} tokens` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className="card bd-run" aria-label="Run summary">
      <div className="bd-run-main">
        <div className="row bd-run-title">
          <span className="bd-run-dot" style={{ background: TONE_COLOR[w.headline.tone] ?? "var(--st-working)" }} aria-hidden="true" />
          <b>{w.headline.text}</b>
        </div>
        {meta && <span className="faint bd-run-meta">{meta}</span>}
        {groups.length > 0 && (
          <>
            <Bar height={8} segments={groups.map((g) => ({ pct: (g.n / total) * 100, color: g.color, label: g.label }))} />
            <div className="row bd-run-counts">
              {groups.map((g) => <Tag key={g.label} color={g.color} dot>{g.n} {g.label}</Tag>)}
            </div>
          </>
        )}
        {model.budgetUsd ? (
          <div className="bd-budget">
            <span className="faint">Budget {fmtUsd(w.spent)} of {fmtUsd(model.budgetUsd)}</span>
            <Bar height={4} segments={[{
              pct: budgetPct, label: "budget used",
              color: budgetPct >= 90 ? "var(--st-needs)" : budgetPct >= 70 ? "var(--st-review)" : "var(--st-merged)",
            }]} />
          </div>
        ) : null}
        {model.endedTs && <Shipped tasks={tasks} startedTs={model.startedTs} endedTs={model.endedTs} />}
      </div>
      <div className="bd-run-ctl">
        {w.live ? (
          <>
            {paused
              ? <Btn small onClick={() => sendControl("resume")}><Play size={14} /> Resume</Btn>
              : <Btn small kind="ghost" onClick={() => sendControl("pause")}><Pause size={14} /> Pause</Btn>}
            <ConfirmBtn small label={<><Square size={13} /> Stop all</>} confirm="Sure? Click again" onConfirm={() => sendControl("stop")} />
          </>
        ) : w.willRun > 0 ? (
          // "Run again" only when re-executing tickets of the finished run; fresh
          // backlog work — even after a prior run — is a plain "Run".
          <Btn kind="fill" small onClick={() => w.open({ type: "runestimate", tickets: w.willRun })}>
            <Play size={14} /> {w.rerunnable > 0 ? "Run again" : "Run"} ({w.willRun})
          </Btn>
        ) : null}
        {model.run && (
          <Btn kind="ghost" small onClick={() => w.go("insights")}>Cost &amp; activity <ArrowRight size={13} /></Btn>
        )}
      </div>
    </section>
  );
}

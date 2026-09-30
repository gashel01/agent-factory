/** One run ticket on the board: id, pinned model/effort, what it is doing now,
 *  the live measures, and the actions valid for its state (the classic
 *  KanbanCard + CardActions, same controls and same requests). The title is the
 *  card's link: it opens the ticket sheet, and its hit area covers the card. */

import type { JSX } from "react";
import { quickRun, sendControl } from "../../../control.js";
import { ACTIVITY, fmtDuration, fmtTokens, fmtUsd, inFlight } from "../../../model.js";
import type { TaskModel } from "../../../model.js";
import { Brain, CircleHelp, ExternalLink, Flag, InfinityIcon, Pencil, Trash2 } from "../../icons.js";
import { Btn, IconBtn, STATE_LABEL, StateTag, Tag } from "../../ui.js";
import type { TicketActions } from "./actions.js";
import { ConfirmBtn } from "./ConfirmBtn.js";

/** Live timer · turns · live tokens while running; wall time · cost · attempt after. */
export function CardMeasures({ t, now }: { t: TaskModel; now: number }): JSX.Element | null {
  const running = t.state === "RUNNING" && t.runningSince !== null;
  if (!running && t.wallS === null && t.costUsd === 0 && t.retries === 0) return null;
  return (
    <div className="bd-meas">
      {running
        ? <span className="bd-meas-live"><span className="bd-pulse" aria-hidden="true" />{fmtDuration((now - t.runningSince!) / 1000)}</span>
        : t.wallS !== null ? <span>{fmtDuration(t.wallS)}</span> : null}
      {running && t.liveTurns > 0 && <span title="Turns so far">turn {t.liveTurns}</span>}
      {running && t.liveTokens > 0 && <span title="Tokens so far (live)">{fmtTokens(t.liveTokens)} tokens</span>}
      {!running && t.costUsd > 0 && (
        <span title={t.tokens > 0 ? `${fmtTokens(t.tokens)} tokens` : "Cost"}>{fmtUsd(t.costUsd)}</span>
      )}
      {t.retries > 0 && <span>attempt {t.retries + 1}</span>}
    </div>
  );
}

/** The per-state buttons, mirroring the classic card exactly. */
export function CardActions({ t, live, act }: { t: TaskModel; live: boolean; act: TicketActions }): JSX.Element | null {
  const attention = t.state === "FAILED" || t.state === "BLOCKED";
  const busy = t.state === "RUNNING" || t.state === "VERIFYING" || t.state === "REVIEWING";
  const items: JSX.Element[] = [];
  if (t.state === "BLOCKED" && live) {
    items.push(<Btn key="answer" kind="fill" small onClick={() => act.answer(t)}>{t.decision ? "Decide" : "Answer"}</Btn>);
  }
  if (attention && !(t.state === "BLOCKED" && live)) {
    items.push(live
      ? <Btn key="retry" kind="fill" small onClick={() => sendControl("retry", t.id)}>Try again</Btn>
      : <Btn key="rerun" kind="fill" small onClick={() => quickRun()}>Run again</Btn>);
  }
  if (attention) {
    items.push(<Btn key="edit" kind="ghost" small title="Edit this ticket's spec (scope, criteria, out-of-scope) before you retry"
      onClick={() => act.editTask(t)}><Pencil size={13} /> Edit</Btn>);
  }
  if (busy && live) items.push(<Btn key="stop" kind="danger" small onClick={() => sendControl("kill", t.id)}>Stop</Btn>);
  if (t.state === "AWAITING_APPROVAL") {
    items.push(<Btn key="approve" kind="fill" small onClick={() => sendControl("approve", t.id)}>Approve</Btn>);
    if (t.diff) items.push(<Btn key="review" small onClick={() => act.diff(t)}>Review diff</Btn>);
    if (live) items.push(<ConfirmBtn key="discard" small kind="ghost" label="Discard" confirm="Discard before merge?" onConfirm={() => sendControl("kill", t.id)} />);
  }
  if (t.state === "QUEUED" && live) {
    items.push(<ConfirmBtn key="cancel" small kind="ghost" label="Cancel" confirm="Remove before it runs?" onConfirm={() => sendControl("kill", t.id)} />);
  }
  // Only a FAILED ticket has something to post-mortem; a blocked one is waiting, not broken.
  if (t.state === "FAILED") {
    items.push(<Btn key="why" kind="ghost" small title="Read the failure: what happened, what proves it, what to do next"
      onClick={() => act.open(t.id, "why")}><CircleHelp size={13} /> Why did it fail?</Btn>);
  }
  if (attention) {
    items.push(<Btn key="lesson" kind="ghost" small title="Record what went wrong as a lesson for next time" onClick={() => act.lesson(t)}>Save lesson</Btn>);
  }
  if (t.state === "DONE" && t.prUrl) {
    items.push(<a key="pr" className="btn sm ghost" href={t.prUrl} target="_blank" rel="noreferrer">View PR <ExternalLink size={13} /></a>);
  }
  if (t.state === "DONE" && t.diff) items.push(<Btn key="diff" kind="ghost" small onClick={() => act.diff(t)}>View diff</Btn>);
  if (t.diff?.repo) {
    items.push(<a key="ide" className="btn sm ghost" title="Open the repo in your IDE"
      href={`vscode://file/${t.diff.repo.replace(/\\/g, "/")}`}>Open in IDE</a>);
  }
  if (inFlight(t.state)) items.push(<Btn key="watch" kind="ghost" small onClick={() => act.open(t.id)}>Watch live</Btn>);
  return items.length ? <div className="bd-actions">{items}</div> : null;
}

export function TaskCard({
  t, live, now, act, autopilot, column, wide,
}: {
  t: TaskModel; live: boolean; now: number; act: TicketActions; autopilot: boolean;
  /** The column's title: the state tag only shows when it says something the column doesn't. */
  column?: string; wide?: boolean;
}): JSX.Element {
  const attention = t.state === "FAILED" || t.state === "BLOCKED";
  const running = t.state === "RUNNING";
  const activity = t.decision ? "Needs a decision from you" : t.note && !attention ? t.note : ACTIVITY[t.state];
  return (
    <article className={`bd-card${wide ? " bd-card-wide" : ""}${attention ? " bd-card-needs" : ""}${t.state === "AWAITING_APPROVAL" ? " bd-card-review" : ""}`}>
      <div className="bd-card-head">
        <span className="mono faint">{t.id}</span>
        {autopilot && <Tag color="var(--st-info)"><InfinityIcon size={11} /> auto</Tag>}
        {t.model && <Tag>{t.model}</Tag>}
        {t.effort && <Tag><Brain size={11} /> {t.effort}</Tag>}
        {STATE_LABEL[t.state] !== column && <StateTag state={t.state} />}
        <span className="spacer" />
        <span className="bd-card-tool">
          <IconBtn small label={`Remove ${t.id} from the board (keeps its history)`} onClick={() => void act.removeTask(t.id)}><Trash2 size={14} /></IconBtn>
        </span>
      </div>
      <button type="button" className="bd-card-title" onClick={() => act.open(t.id)}
        aria-label={`${t.id} ${t.title} — ${STATE_LABEL[t.state]}. Open its history`}>{t.title}</button>
      <div className="bd-card-activity">
        {running && <span className="bd-pulse" aria-hidden="true" />}
        <span>{activity}</span>
      </div>
      {attention && t.note && <div className="bd-card-note"><Flag size={12} /><span>{t.note}</span></div>}
      {t.state === "QUEUED" && t.deps.length > 0 && <div className="bd-card-deps faint">after {t.deps.join(", ")}</div>}
      <CardMeasures t={t} now={now} />
      <CardActions t={t} live={live} act={act} />
    </article>
  );
}

/** The supervisor thread: one continuous conversation mixing the operator's
 *  turns, the supervisor's replies and briefings, and the narrated run events —
 *  grouped into one collapsible chapter per run, oldest at the top, newest by
 *  the composer. The latest chapter opens by default; earlier ones fold.
 *
 *  A reply's suggestion chips are only offered for the run that is current:
 *  a "retry 014" proposed during last week's run must not fire against today's. */

import { useState } from "react";
import type { JSX } from "react";
import type { Observation } from "../../../companion.js";
import type { FactoryEvent } from "../../../types.js";
import { describe } from "../../../story.js";
import { agoShort } from "../../../tickets.js";
import { useWarden } from "../../data.js";
import { Bot, ChevronDown, ChevronRight, CompanionIcon } from "../../icons.js";
import { Suggestion } from "./Suggestion.js";

/** Group observations into run chapters, keeping first-seen (chronological) order. */
function chapters(obs: Observation[]): Array<{ run: string; events: Observation[] }> {
  const order: string[] = [];
  const byRun = new Map<string, Observation[]>();
  for (const o of obs) {
    if (!byRun.has(o.run)) { byRun.set(o.run, []); order.push(o.run); }
    byRun.get(o.run)!.push(o);
  }
  return order.map((run) => ({ run, events: byRun.get(run)! }));
}

function chapterTitle(first: Observation): string {
  const d = new Date(first.ts);
  if (Number.isNaN(d.getTime())) return first.run || "Conversation";
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** How much of a run event reads as its headline; the rest (tool output, npm and
 *  git errors joined with " | ") folds behind "Details". */
const EVENT_HEAD_CHARS = 140;

function EventText({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const cut = text.indexOf(" | ");
  const head = (cut > 0 ? text.slice(0, cut) : text).slice(0, EVENT_HEAD_CHARS);
  if (head.length === text.length) return <p className="sv-event-text">{text}</p>;
  return (
    <div className="sv-event-text">
      <p>{head.trimEnd()}…</p>
      <button type="button" className="sv-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide details" : "Details"}
      </button>
      {open && <pre className="sv-event-detail">{text.split(" | ").join("\n")}</pre>}
    </div>
  );
}

function Entry({ o, now, current }: { o: Observation; now: number; current: boolean }): JSX.Element {
  const w = useWarden();
  if (o.kind === "chat") {
    return (
      <div className="sv-msg me">
        <p className="sv-msg-text">{o.text}</p>
        <span className="sv-ago">{agoShort(o.ts, now)}</span>
      </div>
    );
  }
  if (o.kind === "briefing") {
    return (
      <div className="sv-reply">
        <div className="sv-msg it">
          <p className="sv-msg-text">{o.text}</p>
          <span className="sv-ago">{agoShort(o.ts, now)}</span>
        </div>
        {!!o.actions?.length && <p className="sv-did">Already done: {o.actions.join(" · ")}</p>}
        {!!o.suggestions?.length && current && (
          <div className="sv-chips">{o.suggestions.map((s, i) => <Suggestion key={i} s={s} />)}</div>
        )}
      </div>
    );
  }
  // An attention event carries its own obvious next step (retry a failure, stop
  // an over-budget run) — offered only while it still applies.
  const task = o.action?.task ? w.model.tasks.get(o.action.task) : undefined;
  const actionable = current && w.live && o.action
    && (o.action.op !== "retry" || task?.state === "FAILED");
  return (
    <div className={`sv-event lvl-${o.level}`}>
      <span className="sv-event-ic" aria-hidden="true"><CompanionIcon emoji={o.icon} /></span>
      <EventText text={o.text} />
      <span className="sv-ago">{agoShort(o.ts, now)}</span>
      {actionable && <div className="sv-chips sv-event-act"><Suggestion s={o.action!} /></div>}
    </div>
  );
}

function Chapter({ run, events, defaultOpen, now }: {
  run: string; events: Observation[]; defaultOpen: boolean; now: number;
}): JSX.Element {
  const w = useWarden();
  const [open, setOpen] = useState(defaultOpen);
  const shipped = events.filter((o) => o.icon === "✅").length;
  return (
    <section className="sv-chapter">
      <button type="button" className="sv-chapter-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="sv-chapter-title">{run ? `Run · ${chapterTitle(events[0]!)}` : chapterTitle(events[0]!)}</span>
        {shipped > 0 && <span className="sv-chapter-shipped">{shipped} shipped</span>}
      </button>
      {open && (
        <div className="sv-chapter-body">
          {events.map((o) => <Entry key={o.id} o={o} now={now} current={o.run === (w.model.run ?? "") && !!o.run} />)}
        </div>
      )}
    </section>
  );
}

export function Thread({ obs, showAll, now }: { obs: Observation[]; showAll: boolean; now: number }): JSX.Element {
  const list = chapters(obs.filter((o) => showAll || o.degree <= 1));
  return (
    <div className="sv-thread">
      {list.map((ch, i) => (
        <Chapter key={ch.run || "_"} run={ch.run} events={ch.events} defaultOpen={i === list.length - 1} now={now} />
      ))}
    </div>
  );
}

/** The raw, unfolded event log for the current run (the classic "Activity log"). */
export function RawLog({ feed }: { feed: FactoryEvent[] }): JSX.Element {
  if (feed.length === 0) return <p className="sv-empty">No events yet.</p>;
  return (
    <div className="sv-raw" role="log" aria-label="Raw event log">
      {feed.map((e, i) => (
        <div key={i} className="sv-raw-line">
          <span className="sv-raw-ts">{e.ts?.slice(11, 19) ?? ""}</span>
          <span className="sv-raw-body">{describe(e)}</span>
        </div>
      ))}
    </div>
  );
}

/** The "it's composing an answer" bubble, with the live progress line. */
export function Thinking({ progress }: { progress: string }): JSX.Element {
  return (
    <div className="sv-msg it sv-thinking" role="status" aria-label="The supervisor is answering">
      <Bot size={14} aria-hidden />
      <span className="sv-dots" aria-hidden="true"><i /><i /><i /></span>
      {progress && <span className="sv-progress">{progress}</span>}
    </div>
  );
}

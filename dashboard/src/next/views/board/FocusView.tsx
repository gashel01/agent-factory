/** Focus: the board reduced to what a human has to look at — tickets that need
 *  you (failed, blocked), tickets waiting for your review, what is moving right
 *  now — plus Up next so new work can still be added from here. Merged work
 *  is left out; the Kanban shows it. */

import type { CSSProperties, JSX } from "react";
import { inFlight } from "../../../model.js";
import type { TaskModel } from "../../../model.js";
import { Check } from "../../icons.js";
import { Empty } from "../../ui.js";
import { AddTicketCard, DraftCard, ManualCard } from "./BacklogCards.js";
import type { BoardProps } from "./Kanban.js";
import { TaskCard } from "./TaskCard.js";

export function FocusView(p: BoardProps): JSX.Element {
  const needs = p.tasks.filter((t) => t.state === "FAILED" || t.state === "BLOCKED");
  const review = p.tasks.filter((t) => t.state === "AWAITING_APPROVAL");
  const working = p.tasks.filter((t) => inFlight(t.state));
  const queued = p.tasks.filter((t) => t.state === "QUEUED");
  const mineTodo = p.manual.filter((m) => m.status !== "done");
  const card = (t: TaskModel): JSX.Element => (
    <TaskCard key={t.id} t={t} live={p.live} now={p.now} act={p.act} autopilot={p.autopilot} wide />
  );
  const section = (title: string, color: string, items: TaskModel[]): JSX.Element | null => items.length === 0 ? null : (
    <section className="bd-focus-sec" style={{ "--c": color } as CSSProperties} aria-label={`${title}, ${items.length}`}>
      <h2 className="bd-focus-head">{title}<span className="faint">{items.length}</span></h2>
      {items.map(card)}
    </section>
  );
  const nothing = needs.length + review.length + working.length === 0;
  return (
    <div className="bd-focus">
      {section("Needs you", "var(--st-needs)", needs)}
      {section("To review", "var(--st-review)", review)}
      {section("Working", "var(--st-working)", working)}
      {nothing && (
        <Empty icon={<Check size={22} />} title="Nothing needs you right now">
          No ticket is failing, waiting on an answer or waiting for your review.
        </Empty>
      )}
      <section className="bd-focus-sec" style={{ "--c": "var(--st-queued)" } as CSSProperties} aria-label="Up next">
        <h2 className="bd-focus-head">Up next<span className="faint">{queued.length + p.pending.length + mineTodo.length}</span></h2>
        {queued.map(card)}
        {p.pending.map((d) => <DraftCard key={d.file} draft={d} act={p.act} onRemove={() => p.onRemove(d.id)} />)}
        {mineTodo.map((m) => (
          <ManualCard key={m.file} ticket={m} act={p.act} onRemove={() => p.onRemove(m.id)} onReview={() => p.onReview(m)}
            onDragStart={() => undefined} onDragEnd={() => undefined} />
        ))}
        <AddTicketCard onClick={p.onAdd} />
      </section>
    </div>
  );
}

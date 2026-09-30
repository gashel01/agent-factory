/** The Kanban: four lanes that answer the operator's questions — what's next,
 *  what's moving, what needs me, what shipped — instead of one column per
 *  internal stage (the classic board had seven, most of them empty most of the
 *  time). Each card still carries its exact state tag when its lane groups
 *  several (Checking vs Working, Failed vs To review).
 *
 *  Lane keys match the classic COL_STATUS / MANUAL_COL ones, so a manual ticket
 *  dragged into a lane gets the same human status as on the classic board. */

import { useState } from "react";
import type { CSSProperties, JSX } from "react";
import { COL_STATUS, MANUAL_COL } from "../../../board-model.js";
import type { BoardTicket } from "../../../board-model.js";
import type { TaskModel } from "../../../model.js";
import type { TaskState } from "../../../types.js";
import type { TicketActions } from "./actions.js";
import { AddTicketCard, DraftCard, ManualCard } from "./BacklogCards.js";
import { TaskCard } from "./TaskCard.js";

export interface BoardProps {
  tasks: TaskModel[]; pending: BoardTicket[]; manual: BoardTicket[];
  live: boolean; now: number; autopilot: boolean; act: TicketActions;
  onAdd: () => void; onRemove: (id: string) => void; onReview: (bt: BoardTicket) => void;
}

/** `label` is what a card's state tag is compared with: a card whose state
 *  label equals it doesn't repeat the lane's name. */
const LANES: Array<{ key: string; title: string; label: string; states: TaskState[]; color: string }> = [
  { key: "queued", title: "Up next", label: "Up next", states: ["QUEUED"], color: "var(--st-queued)" },
  { key: "working", title: "In progress", label: "Working",
    states: ["RUNNING", "VERIFYING", "REVIEWING", "MERGE_QUEUED", "MERGING"], color: "var(--st-working)" },
  { key: "approval", title: "For you", label: "",
    states: ["AWAITING_APPROVAL", "BLOCKED", "FAILED"], color: "var(--st-review)" },
  { key: "done", title: "Merged", label: "Merged", states: ["DONE"], color: "var(--st-merged)" },
];

export function Kanban(p: BoardProps): JSX.Element {
  const [drag, setDrag] = useState<string | null>(null); // file of the manual card being dragged
  const manualIn = (key: string): BoardTicket[] => p.manual.filter((m) => (MANUAL_COL[m.status] ?? "queued") === key);
  const manualCard = (m: BoardTicket): JSX.Element => (
    <ManualCard key={m.file} ticket={m} act={p.act} onRemove={() => p.onRemove(m.id)} onReview={() => p.onReview(m)}
      onDragStart={() => setDrag(m.file)} onDragEnd={() => setDrag(null)} />
  );
  return (
    <div className="bd-cols">
      {LANES.map((lane) => {
        // Within "For you", what blocks the run (a question, a failure) comes
        // before what merely waits for approval.
        const items = p.tasks
          .filter((t) => lane.states.includes(t.state))
          .sort((a, b) => lane.states.indexOf(b.state) - lane.states.indexOf(a.state) || a.id.localeCompare(b.id));
        const mine = manualIn(lane.key);
        const queued = lane.key === "queued";
        const dropStatus = COL_STATUS[lane.key];
        const canDrop = !!dropStatus && drag !== null;
        const count = items.length + mine.length + (queued ? p.pending.length : 0);
        return (
          <section key={lane.key} aria-label={`${lane.title}, ${count}`}
            className={`bd-col${canDrop ? " bd-col-drop" : ""}${count === 0 && !queued ? " bd-col-empty" : ""}`}
            style={{ "--c": lane.color } as CSSProperties}
            onDragOver={canDrop ? (e) => e.preventDefault() : undefined}
            onDrop={dropStatus ? (e) => {
              e.preventDefault();
              const file = e.dataTransfer.getData("text/plain") || drag;
              const bt = p.manual.find((m) => m.file === file);
              if (bt && bt.status !== dropStatus) void p.act.moveManual(bt, dropStatus);
              setDrag(null);
            } : undefined}>
            <h2 className="bd-colhead"><span className="bd-coldot" aria-hidden="true" />{lane.title}<span className="bd-colcount">{count}</span></h2>
            <div className="bd-colbody">
              {queued && <AddTicketCard onClick={p.onAdd} />}
              {items.map((t) => (
                <TaskCard key={t.id} t={t} live={p.live} now={p.now} act={p.act} autopilot={p.autopilot} column={lane.label} />
              ))}
              {queued && p.pending.map((d) => <DraftCard key={d.file} draft={d} act={p.act} onRemove={() => p.onRemove(d.id)} />)}
              {mine.map(manualCard)}
              {count === 0 && <p className="bd-colempty">{queued ? "Nothing queued" : lane.key === "approval" ? "Nothing needs you" : "No tickets"}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

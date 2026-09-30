/** Backlog tickets that are not (yet) part of a run: the AI drafts waiting in
 *  Up next, and the tickets a human owns. A draft can be held, taken over,
 *  edited or removed; a manual ticket moves between the human lanes (drag, or
 *  the Status select for keyboard users), goes back to the AI, or asks the AI
 *  for a review once done. */

import type { JSX } from "react";
import type { BoardTicket } from "../../../board-model.js";
import { Bot, Laptop, Pause, Pencil, Play, Plus, Sparkles, Trash2 } from "../../icons.js";
import { Btn, IconBtn, Tag } from "../../ui.js";
import type { TicketActions } from "./actions.js";

export function AddTicketCard({ onClick }: { onClick: () => void }): JSX.Element {
  return <button type="button" className="bd-add" onClick={onClick}><Plus size={15} /> Add a ticket</button>;
}

export function DraftCard({ draft, act, onRemove }: { draft: BoardTicket; act: TicketActions; onRemove: () => void }): JSX.Element {
  return (
    <article className={`bd-card bd-card-draft${draft.hold ? " bd-card-held" : ""}`}>
      <div className="bd-card-head">
        <span className="mono faint">{draft.id}</span>
        <Tag>{draft.hold ? "held" : "draft"}</Tag>
        <span className="spacer" />
        <span className="bd-card-tool">
          <IconBtn small label={`Edit ${draft.id}`} onClick={() => act.editDraft(draft)}><Pencil size={14} /></IconBtn>
          <IconBtn small label={`Remove ${draft.id} from the board`} onClick={onRemove}><Trash2 size={14} /></IconBtn>
        </span>
      </div>
      <button type="button" className="bd-card-title" onClick={() => act.editDraft(draft)}
        aria-label={`${draft.id} ${draft.title} — ${draft.hold ? "held" : "draft"}. Edit it`}>{draft.title}</button>
      {draft.deps.length > 0 && <div className="bd-card-deps faint">after {draft.deps.join(", ")}</div>}
      <div className="bd-actions">
        <Btn kind="ghost" small title={draft.hold ? "Let a run pick this up again" : "Pause: a run will skip this ticket"}
          onClick={() => act.setHold(draft, !draft.hold)}>
          {draft.hold ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Hold</>}
        </Btn>
        <Btn kind="ghost" small title="Take it yourself — the AI won't run it" onClick={() => act.setAssignee(draft, true)}>
          <Laptop size={13} /> Do it myself
        </Btn>
      </div>
    </article>
  );
}

const HUMAN_STATUSES: Array<[string, string]> = [["todo", "To do"], ["doing", "Doing"], ["review", "In review"], ["done", "Done"]];

export function ManualCard({
  ticket, act, onRemove, onReview, onDragStart, onDragEnd,
}: {
  ticket: BoardTicket; act: TicketActions; onRemove: () => void; onReview: () => void;
  onDragStart: () => void; onDragEnd: () => void;
}): JSX.Element {
  const selectId = `bd-status-${ticket.file}`;
  return (
    <article className="bd-card bd-card-manual" draggable title="Drag me between columns"
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", ticket.file); e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd}>
      <div className="bd-card-head">
        <span className="mono faint">{ticket.id}</span>
        <Tag color="var(--accent)"><Laptop size={11} /> You</Tag>
        <span className="spacer" />
        <span className="bd-card-tool">
          <IconBtn small label={`Edit ${ticket.id}`} onClick={() => act.editDraft(ticket)}><Pencil size={14} /></IconBtn>
          <IconBtn small label={`Remove ${ticket.id} from the board`} onClick={onRemove}><Trash2 size={14} /></IconBtn>
        </span>
      </div>
      <button type="button" className="bd-card-title" onClick={() => act.editDraft(ticket)}
        aria-label={`${ticket.id} ${ticket.title} — yours. Edit it`}>{ticket.title}</button>
      <div className="bd-actions">
        <label className="sr-only" htmlFor={selectId}>Status of {ticket.id}</label>
        <select id={selectId} className="bd-status" value={ticket.status}
          onChange={(e) => { if (e.target.value !== ticket.status) void act.moveManual(ticket, e.target.value); }}>
          {HUMAN_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {(ticket.status === "review" || ticket.status === "done") && (
          <Btn kind="fill" small title="Optional: let the AI review the work you just finished" onClick={onReview}>
            <Sparkles size={13} /> Ask AI to review
          </Btn>
        )}
        <Btn kind="ghost" small title="Hand this ticket to the AI agents" onClick={() => act.setAssignee(ticket, false)}>
          <Bot size={13} /> Give to AI
        </Btn>
      </div>
    </article>
  );
}

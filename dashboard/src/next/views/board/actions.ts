/** Every action a ticket can take from the board, the focus list or the ticket
 *  sheet, in one hook so each surface calls the same code: the backlog writes go
 *  through saveTicket + fmSet, run controls through sendControl. */

import type { BoardTicket } from "../../../board-model.js";
import { toast } from "../../../core.js";
import type { TaskModel } from "../../../model.js";
import { fmSet } from "../../../tickets.js";
import { useWarden } from "../../data.js";
import type { Overlay } from "../../routes.js";
import { requestTab } from "../ticket/tabs.js";
import type { TicketTab } from "../ticket/tabs.js";

/** The overlay that answers a blocked ticket: a decision gate when the agent
 *  offered options, a free-text answer otherwise. */
export function answerOverlay(t: TaskModel): Overlay {
  return t.decision
    ? { type: "decision", taskId: t.id, title: t.title, question: t.note ?? "", options: t.decision }
    : { type: "answer", taskId: t.id, title: t.title, question: t.note ?? "", context: t.blockedContext };
}

export interface TicketActions {
  open: (id: string, tab?: TicketTab) => void;
  answer: (t: TaskModel) => void;
  diff: (t: TaskModel) => void;
  editTask: (t: TaskModel) => void;
  lesson: (t: TaskModel) => void;
  removeTask: (id: string) => Promise<void>;
  editDraft: (bt: BoardTicket) => void;
  moveManual: (bt: BoardTicket, status: string) => Promise<void>;
  setAssignee: (bt: BoardTicket, toHuman: boolean) => Promise<void>;
  setHold: (bt: BoardTicket, on: boolean) => Promise<void>;
}

export function useTicketActions(): TicketActions {
  const w = useWarden();
  return {
    open: (id, tab) => { requestTab(id, tab ?? null); w.open({ type: "ticket", taskId: id }); },
    answer: (t) => w.open(answerOverlay(t)),
    // The diff page switches to review mode by itself for a ticket awaiting approval.
    diff: (t) => { if (t.diff) { w.close(); w.go("diff", t.id); } },
    // Re-scope a stuck ticket before retrying: its backlog file still exists, so
    // open the full editor on it. The next "Run again" uses the saved file.
    editTask: (t) => {
      const bt = w.boardTickets.find((x) => x.id === t.id);
      if (bt) w.open({ type: "editticket", ticket: bt });
      else toast("This ticket's file is gone (merged or removed) — nothing to edit.", true);
    },
    lesson: (t) => w.open({ type: "lesson", text: t.note ? `${t.note}\n\nLesson: ` : "", ticketId: t.id }),
    removeTask: (id) => w.removeTicket(id),
    editDraft: (bt) => w.open({ type: "editticket", ticket: bt }),
    // A manual ticket dropped in a column takes that column's human status.
    moveManual: (bt, status) => w.saveTicket(bt, fmSet(bt.content, "status", status), `${bt.id} moved to ${status}.`),
    // Hand a ticket to the dev (the AI leaves it alone) or back to the AI.
    setAssignee: (bt, toHuman) => w.saveTicket(bt,
      fmSet(fmSet(bt.content, "assignee", toHuman ? "human" : ""), "status", toHuman ? "todo" : ""),
      toHuman ? `${bt.id} is yours now — the AI won't touch it.` : `${bt.id} handed to the AI.`),
    // Pause / resume an AI draft (a run skips it while held).
    setHold: (bt, on) => w.saveTicket(bt, fmSet(bt.content, "hold", on ? "true" : ""),
      on ? `${bt.id} on hold — a run will skip it.` : `${bt.id} back in the queue.`),
  };
}

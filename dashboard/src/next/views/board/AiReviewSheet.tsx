/** Opt-in AI review of a manual ticket the developer just finished: the AI reads
 *  its diff against the ticket's intent and gives concise feedback. "Hand to AI
 *  to fix" closes the loop — the notes are appended to the ticket as
 *  instructions and the ticket goes back to the AI as a draft. Nothing runs
 *  unless the operator asks for it from a manual card. Local to the board (the
 *  overlay set has no entry for it), same request and edits as the classic
 *  AiReviewModal + handToAiWithFeedback. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { postJSON } from "../../../api.js";
import type { BoardTicket } from "../../../board-model.js";
import { toast } from "../../../core.js";
import { fmSet } from "../../../tickets.js";
import { useWarden } from "../../data.js";
import { Bot } from "../../icons.js";
import { Btn, Sheet, Spinner } from "../../ui.js";

export function AiReviewSheet({ ticket, onClose }: { ticket: BoardTicket; onClose: () => void }): JSX.Element {
  const w = useWarden();
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await postJSON<{ review?: string; error?: string }>("/api/ticket/review", { file: ticket.file });
        if (!alive) return;
        const body = r.review?.trim();
        if (body) { setText(body); setState("done"); }
        else { setText(r.error || "The reviewer returned nothing — try again in a moment."); setState("error"); }
      } catch (err) {
        if (alive) { setText(`The review couldn't run: ${String(err)}`); setState("error"); }
      }
    })();
    return () => { alive = false; };
  }, [ticket.file]);

  // Append the review as instructions, flip the ticket back to the AI and drop
  // its manual status so it re-enters the pipeline as a draft.
  const handToAi = async (): Promise<void> => {
    const bt = w.boardTickets.find((t) => t.file === ticket.file);
    if (!bt) { toast("Ticket not found.", true); return; }
    const body = `${bt.content.replace(/\s*$/, "")}\n\n## Reviewer feedback (address this)\n${text.trim()}\n`;
    try {
      await postJSON(`/api/backlog/${encodeURIComponent(bt.file)}`, { content: fmSet(fmSet(body, "assignee", ""), "status", "") });
      toast(`${bt.id} handed to the AI with the review notes — start a run to apply them.`);
      w.refreshBacklog();
      onClose();
    } catch (err) { toast(String(err), true); }
  };

  return (
    <Sheet title={`AI review — ${ticket.title}`} eyebrow={<span className="mono faint">{ticket.id}</span>} onClose={onClose}
      footer={state === "done" ? (
        <>
          <Btn kind="ghost" onClick={onClose}>Looks good — close</Btn>
          <span className="spacer" />
          <Btn kind="fill" onClick={handToAi}><Bot size={15} /> Hand to AI to fix</Btn>
        </>
      ) : undefined}>
      {state === "loading"
        ? <div className="row dim"><Spinner /> Reading your changes and reviewing…</div>
        : <div className={`bd-review-text${state === "error" ? " bd-review-error" : ""}`}>{text}</div>}
    </Sheet>
  );
}

/** The ticket sheet's footer: the actions valid for the ticket's state, the
 *  same set as the classic log modal and card (answer, approve / request
 *  changes, retry / run again, stop, cancel, edit, lesson, diff, PR, IDE,
 *  remove). "Request changes" opens a note field in place; the note goes back
 *  to the agent as a "changes" control. */

import { useState } from "react";
import type { JSX } from "react";
import { inFlight } from "../../../model.js";
import type { TaskModel } from "../../../model.js";
import { quickRun, sendControl } from "../../../control.js";
import { useWarden } from "../../data.js";
import { ExternalLink, Pencil, Trash2 } from "../../icons.js";
import { Btn, IconBtn } from "../../ui.js";
import type { TicketActions } from "../board/actions.js";
import { ConfirmBtn } from "../board/ConfirmBtn.js";

export function TicketFooter({ t, act }: { t: TaskModel; act: TicketActions }): JSX.Element {
  const w = useWarden();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const attention = t.state === "FAILED" || t.state === "BLOCKED";
  const done = (p: Promise<void>): Promise<void> => p.then(() => w.close());

  if (t.state === "AWAITING_APPROVAL" && asking) {
    return (
      <div className="stack tk-changes">
        <label className="field-label" htmlFor="tk-changes-text">What needs to change? The agent restarts with this note.</label>
        <textarea id="tk-changes-text" className="input" autoFocus value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. the validation is wrong, also handle the empty case…" />
        <div className="row">
          <Btn kind="fill" disabled={!note.trim()} onClick={() => done(sendControl("changes", t.id, note.trim()))}>Send back to the agent</Btn>
          <Btn kind="ghost" onClick={() => { setAsking(false); setNote(""); }}>Cancel</Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="row tk-foot">
      {t.state === "BLOCKED" && w.live && (
        <Btn kind="fill" onClick={() => act.answer(t)}>{t.decision ? "Decide" : "Answer"}</Btn>
      )}
      {t.state === "AWAITING_APPROVAL" && (
        <>
          <Btn kind="fill" onClick={() => done(sendControl("approve", t.id))}>Approve and merge</Btn>
          <Btn kind="danger" onClick={() => setAsking(true)}>Request changes</Btn>
          {w.live && <ConfirmBtn kind="ghost" label="Discard" confirm="Discard before merge?" onConfirm={() => sendControl("kill", t.id)} />}
        </>
      )}
      {attention && !(t.state === "BLOCKED" && w.live) && (w.live
        ? <Btn kind="fill" onClick={() => sendControl("retry", t.id)}>Try again</Btn>
        : <Btn kind="fill" onClick={() => quickRun()}>Run again</Btn>)}
      {(t.state === "RUNNING" || t.state === "VERIFYING" || t.state === "REVIEWING") && w.live && (
        <Btn kind="danger" onClick={() => sendControl("kill", t.id)}>Stop</Btn>
      )}
      {t.state === "QUEUED" && w.live && (
        <ConfirmBtn kind="ghost" label="Cancel" confirm="Remove before it runs?" onConfirm={() => sendControl("kill", t.id)} />
      )}
      {attention && <Btn kind="ghost" onClick={() => act.editTask(t)}><Pencil size={14} /> Edit ticket</Btn>}
      {attention && <Btn kind="ghost" onClick={() => act.lesson(t)}>Save lesson</Btn>}
      {t.diff && !inFlight(t.state) && (
        <Btn kind={t.state === "AWAITING_APPROVAL" ? "default" : "ghost"} onClick={() => act.diff(t)}>
          {t.state === "AWAITING_APPROVAL" ? "Review diff" : "View diff"}
        </Btn>
      )}
      {t.state === "DONE" && t.prUrl && (
        <a className="btn ghost" href={t.prUrl} target="_blank" rel="noreferrer">View PR <ExternalLink size={14} /></a>
      )}
      {t.diff?.repo && (
        <a className="btn ghost" title="Open the repo in your IDE" href={`vscode://file/${t.diff.repo.replace(/\\/g, "/")}`}>Open in IDE</a>
      )}
      <span className="spacer" />
      <IconBtn label={`Remove ${t.id} from the board (keeps its history)`}
        onClick={() => { void act.removeTask(t.id).then(() => w.close()); }}><Trash2 size={16} /></IconBtn>
    </div>
  );
}

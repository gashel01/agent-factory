/** Edit a ticket that hasn't started yet — an AI draft in Up next or a ticket
 *  the operator owns. Both are backlog .md files, so the title and body are
 *  rewritten in place and every front-matter flag the sheet doesn't manage is
 *  kept (id, repo, depends_on, files_hint, priority…). The sheet also edits the
 *  per-ticket overrides: proof command, model, effort, skip flags, owner, hold. */

import { useState } from "react";
import type { JSX } from "react";
import type { BoardTicket } from "../../../board-model.js";
import { toast, useFileAttachments } from "../../../core.js";
import { fmGet, fmSet, ticketBody, withTitleAndBody } from "../../../tickets.js";
import { useWarden } from "../../data.js";
import { Btn, Seg, Sheet, Switch, Tag } from "../../ui.js";
import { AttachRow } from "./Attachments.js";
import { splitCommands, verifyGet, verifySet } from "./frontmatter.js";
import { ProvenBy, useVerifyPolicy } from "./ProvenBy.js";
import { EffortPills, ModelPills } from "./TuneFields.js";

function Toggle({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <div className="nw-ask">
      <div className="stack nw-ask-text"><b>{label}</b><span className="hint">{hint}</span></div>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

export function EditTicketSheet({ ticket }: { ticket: BoardTicket }): JSX.Element {
  const w = useWarden();
  const c = ticket.content;
  const policy = useVerifyPolicy();
  const att = useFileAttachments();
  const [title, setTitle] = useState(ticket.title === "(untitled)" ? "" : ticket.title);
  const [body, setBody] = useState(ticketBody(c));
  const [verify, setVerify] = useState(verifyGet(c).join(", "));
  const [skipVerify, setSkipVerify] = useState(fmGet(c, "skip_verify") === "true");
  const [skipReview, setSkipReview] = useState(fmGet(c, "skip_review") === "true");
  const [model, setModel] = useState(fmGet(c, "model"));
  const [effort, setEffort] = useState(fmGet(c, "effort"));
  const [owner, setOwner] = useState<"ai" | "human">(ticket.assignee);
  const [hold, setHold] = useState(ticket.hold);

  const save = async (): Promise<void> => {
    if (!title.trim()) { toast("Give the ticket a title.", true); return; }
    let next = withTitleAndBody(c, title.trim(), body + att.refs());
    next = fmSet(next, "model", model);
    next = fmSet(next, "effort", effort);
    next = fmSet(next, "skip_verify", skipVerify ? "true" : "");
    next = fmSet(next, "skip_review", skipReview ? "true" : "");
    next = fmSet(next, "assignee", owner === "human" ? "human" : "");
    next = fmSet(next, "hold", owner === "ai" && hold ? "true" : "");
    next = verifySet(next, splitCommands(verify));
    await w.saveTicket(ticket, next, `Ticket ${ticket.id} updated.`);
    w.close();
  };

  return (
    <Sheet title={`Edit ticket ${ticket.id}`} onClose={w.close}
      eyebrow={<><Tag>{ticket.assignee === "human" ? "Yours" : "AI draft"}</Tag>{ticket.hold && <Tag color="var(--st-review)">On hold</Tag>}</>}
      headExtra={<p className="hint">{ticket.assignee === "human" ? "Your ticket — the AI won't touch it." : "Not started yet, so it's safe to edit."}</p>}
      footer={
        <>
          <span className="faint mono nw-file">{ticket.file}</span>
          <span className="spacer" />
          <Btn kind="ghost" onClick={w.close}>Cancel</Btn>
          <Btn kind="fill" onClick={save} disabled={!title.trim() || att.uploading > 0}>Save changes</Btn>
        </>
      }>
      <div className="field">
        <label className="field-label" htmlFor="et-title">Title</label>
        <input id="et-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="et-body">Details</label>
        <textarea id="et-body" className="input nw-details" value={body} onChange={(e) => setBody(e.target.value)}
          onPaste={att.paste} onDrop={att.drop} onDragOver={(e) => e.preventDefault()} />
        <AttachRow att={att} />
      </div>
      <ProvenBy id="et-verify" value={verify} onChange={setVerify} skip={skipVerify} onSkip={setSkipVerify} policy={policy} />
      <div className="stack nw-tune">
        <ModelPills value={model} onChange={setModel} />
        <EffortPills value={effort} onChange={setEffort} />
      </div>
      <Toggle label="Skip the AI reviewer" checked={skipReview} onChange={setSkipReview}
        hint="Saves a whole review agent on a low-risk change like a title tweak." />
      <div className="nw-ask">
        <div className="stack nw-ask-text">
          <b>Who does it</b>
          <span className="hint">A ticket you own stays on the board for you; runs never pick it up.</span>
        </div>
        <Seg label="Who does it" value={owner} onChange={setOwner}
          options={[{ value: "ai", label: "An agent" }, { value: "human", label: "Me" }]} />
      </div>
      {owner === "ai" && (
        <Toggle label="On hold" checked={hold} onChange={setHold}
          hint="Stays in the backlog, but runs skip it until you lift the hold." />
      )}
    </Sheet>
  );
}

/** New work › One ticket: the operator writes a ticket by hand — title,
 *  details (optionally expanded by AI into Goal + Done-when), the command that
 *  proves it, a model — and it lands in Up next. Same request and file shape as
 *  the classic "Add to Up next". */

import { useState } from "react";
import type { JSX } from "react";
import { postJSON } from "../../../api.js";
import { toast, useFileAttachments } from "../../../core.js";
import { Plus, Sparkles } from "../../icons.js";
import { useWarden } from "../../data.js";
import { Btn } from "../../ui.js";
import { AttachRow } from "./Attachments.js";
import type { Attach } from "./Attachments.js";
import { newTicketContent, nextTicketId, splitCommands, ticketSlug } from "./frontmatter.js";
import { ProvenBy, useVerifyPolicy } from "./ProvenBy.js";
import type { VerifyPolicy } from "./ProvenBy.js";
import { useProjectRepo } from "./RepoRow.js";
import { ModelPills } from "./TuneFields.js";

export interface OneTicketState {
  title: string; setTitle: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  verify: string; setVerify: (v: string) => void;
  skipVerify: boolean; setSkipVerify: (v: boolean) => void;
  model: string; setModel: (v: string) => void;
  att: Attach;
  policy: VerifyPolicy | null;
  complete: () => Promise<void>;
  add: () => Promise<void>;
}

export function useOneTicket(): OneTicketState {
  const w = useWarden();
  const repo = useProjectRepo();
  const policy = useVerifyPolicy();
  const att = useFileAttachments();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [verify, setVerify] = useState("");
  const [skipVerify, setSkipVerify] = useState(false);
  const [model, setModel] = useState("");

  // Expand the operator's notes into a Goal + Done-when checklist.
  const complete = async (): Promise<void> => {
    try {
      const r = await postJSON<{ body?: string }>("/api/ticket/complete", { title: title.trim(), notes: notes.trim() });
      if (r.body?.trim()) { setNotes(r.body.trim()); toast("Filled in by AI — tweak it, then add."); }
      else toast("The model returned nothing — try adding a bit more detail.", true);
    } catch (err) { toast(String(err), true); }
  };

  // Write it to the backlog and close, so the new draft is seen landing in Up next.
  const add = async (): Promise<void> => {
    const t = title.trim();
    if (!t) { toast("Give the ticket a title.", true); return; }
    if (!repo.trim()) { toast("Set this project's repository first.", true); return; }
    const id = nextTicketId(w.boardTickets.map((b) => b.file), w.tasks.map((x) => x.id));
    const content = newTicketContent({
      id, title: t, repo: repo.trim(), body: notes + att.refs(),
      verify: skipVerify ? [] : splitCommands(verify), model, skipVerify,
    });
    try {
      await postJSON(`/api/backlog/${encodeURIComponent(`${id}-${ticketSlug(t)}.md`)}`, { content });
      toast(`Ticket ${id} added to Up next.`);
      att.clear();
      w.refreshBacklog();
      w.close();
    } catch (err) { toast(String(err), true); }
  };

  return { title, setTitle, notes, setNotes, verify, setVerify, skipVerify, setSkipVerify, model, setModel, att, policy, complete, add };
}

export function OneTicketBody({ st }: { st: OneTicketState }): JSX.Element {
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="nw-title">Title</label>
        <input id="nw-title" className="input" placeholder="Add a dark-mode toggle to the header" value={st.title}
          onChange={(e) => st.setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void st.add(); } }} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="nw-body">Details</label>
        <textarea id="nw-body" className="input nw-details" value={st.notes}
          placeholder="What to build, and how you’ll know it’s done… write freely, or let AI expand it."
          onChange={(e) => st.setNotes(e.target.value)}
          onPaste={st.att.paste} onDrop={st.att.drop} onDragOver={(e) => e.preventDefault()} />
        <AttachRow att={st.att} />
      </div>
      <ProvenBy id="nw-verify" value={st.verify} onChange={st.setVerify}
        skip={st.skipVerify} onSkip={st.setSkipVerify} policy={st.policy} />
      <ModelPills value={st.model} onChange={st.setModel} />
    </>
  );
}

export function OneTicketFoot({ st }: { st: OneTicketState }): JSX.Element {
  return (
    <>
      <Btn kind="ghost" onClick={st.complete} disabled={!st.title.trim() && !st.notes.trim()}
        title="Let the model expand your notes into a Goal + Done-when checklist">
        <Sparkles size={15} /> Complete with AI
      </Btn>
      <div className="spacer" />
      <Btn kind="fill" onClick={st.add} disabled={!st.title.trim() || st.att.uploading > 0}>
        <Plus size={15} /> Add to Up next
      </Btn>
    </>
  );
}

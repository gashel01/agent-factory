/** The lesson editor sheet: write the rule learned, choose where it applies
 *  (this project or every project) and which ticket it came from. Used for a
 *  new lesson (from Memory, or drafted from a ticket through the "lesson"
 *  overlay) and to edit or delete an existing one. Same toasts as the classic
 *  FactEditor. */

import { useState } from "react";
import type { JSX } from "react";
import { toast } from "../../../core.js";
import { useWarden } from "../../data.js";
import { Btn, Field, Seg, Sheet } from "../../ui.js";
import { ConfirmBtn, errText } from "../projects/ConfirmBtn.js";
import { deleteLesson, saveLesson } from "./facts.js";
import type { Fact, Scope } from "./facts.js";

export function LessonEditor({ fact, draft, onClose, onSaved }: {
  fact: Fact | null; draft?: { text: string; ticketId?: string }; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const w = useWarden();
  const [text, setText] = useState(fact?.text ?? draft?.text ?? "");
  const [scope, setScope] = useState<Scope>(fact?.scope ?? "project");
  const [ticketId, setTicketId] = useState(fact?.ticketId ?? draft?.ticketId ?? "");

  // The run's tickets, plus the lesson's own origin when it's not among them
  // (a draft, or a ticket of an older run) so the choice isn't silently lost.
  const options = w.tasks.map((t) => ({ id: t.id, label: `${t.id} · ${t.title}` }));
  if (ticketId && !options.some((o) => o.id === ticketId)) options.unshift({ id: ticketId, label: ticketId });

  const save = async (): Promise<void> => {
    if (!text.trim()) { toast("Write the lesson first.", true); return; }
    try {
      await saveLesson(fact?.id ?? null, { text: text.trim(), scope, ticketId: ticketId || null });
      toast("Lesson saved."); onSaved(); onClose();
    } catch (err) { toast(errText(err), true); }
  };
  const remove = async (): Promise<void> => {
    if (!fact) return;
    try { await deleteLesson(fact.id); toast("Lesson deleted."); onSaved(); onClose(); }
    catch (err) { toast(errText(err), true); }
  };

  return (
    <Sheet title={fact ? "Edit lesson" : "New lesson"} onClose={onClose}
      footer={<>
        {fact && <ConfirmBtn kind="ghost" label="Delete" confirm="Sure? Click again" onConfirm={remove} />}
        <span className="spacer" />
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="fill" onClick={save}>Save</Btn>
      </>}>
      <Field label="The lesson — the rule learned" htmlFor="mem-text"
        hint="Write it as a rule the next agent can follow, not as the raw failure.">
        <textarea id="mem-text" className="input mem-text-input" value={text}
          placeholder="e.g. always check test data matches the mockup before review…"
          onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="field">
        <span className="field-label">Applies to</span>
        <Seg label="Applies to" value={scope} onChange={setScope}
          options={[{ value: "project", label: "This project only" }, { value: "global", label: "All projects" }]} />
      </div>
      <Field label="Origin ticket" htmlFor="mem-ticket">
        <select id="mem-ticket" className="input" value={ticketId} onChange={(e) => setTicketId(e.target.value)}>
          <option value="">None (written by hand)</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </Field>
      {fact?.applied ? <p className="hint">Handed to agents {fact.applied}× so far.</p> : null}
    </Sheet>
  );
}

/** The visual decision gate. At a genuine design fork the agent offers concrete
 *  options instead of guessing; the operator sees them side by side — rendered
 *  live (in a script-less sandbox) when an option carries preview HTML — picks
 *  one, and the agent resumes to build exactly that. Same answer text as the
 *  classic DecisionModal: "<label> — <detail>\nAlso: <note>". */

import { useState } from "react";
import type { JSX } from "react";
import type { DecisionOption } from "../../../types.js";
import { toast } from "../../../core.js";
import { sendAnswer } from "../../../control.js";
import { useWarden } from "../../data.js";
import { Btn, Sheet, Tag } from "../../ui.js";

export function DecisionSheet({ taskId, title, question, options }: {
  taskId: string; title: string; question: string; options: DecisionOption[];
}): JSX.Element {
  const w = useWarden();
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const chosen = options.find((o) => o.id === picked) ?? null;

  const confirm = async (): Promise<void> => {
    if (!chosen) { toast("Pick an option first.", true); return; }
    const detail = chosen.detail ? ` — ${chosen.detail}` : "";
    const extra = note.trim() ? `\nAlso: ${note.trim()}` : "";
    await sendAnswer(taskId, `${chosen.label}${detail}${extra}`);
    toast(`Chose “${chosen.label}”. ${taskId} resumes with your decision.`);
    w.close();
  };

  return (
    <Sheet wide title={title} eyebrow={<><span className="mono faint">{taskId}</span><Tag color="var(--st-needs)" dot>Needs a decision</Tag></>}
      onClose={w.close}
      footer={(
        <>
          <span className="hint tk-foot-hint">{chosen ? `You picked “${chosen.label}”.` : "Pick the path the agent should take."}</span>
          <Btn kind="fill" disabled={!chosen} onClick={confirm}>Build this choice</Btn>
        </>
      )}>
      {question && <p className="tk-ask">{question}</p>}
      <div className="tk-options" role="group" aria-label="Options">
        {options.map((o) => (
          <div key={o.id} className={`tk-option${picked === o.id ? " tk-option-on" : ""}`}>
            {o.preview_html
              ? <iframe className="tk-option-frame" title={`Preview: ${o.label}`} sandbox="" srcDoc={o.preview_html} tabIndex={-1} />
              : <div className="tk-option-frame tk-option-none">No preview</div>}
            <button type="button" className="tk-option-pick" aria-pressed={picked === o.id} onClick={() => setPicked(o.id)}>
              <b>{o.label}</b>
              {o.detail && <span className="dim">{o.detail}</span>}
            </button>
          </div>
        ))}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tk-decide-note">Add a note (optional)</label>
        <textarea id="tk-decide-note" className="input" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the agent should keep in mind while building your choice…" />
      </div>
    </Sheet>
  );
}

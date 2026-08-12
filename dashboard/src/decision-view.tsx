import { useState } from "react";
import type { JSX } from "react";
import type { DecisionOption } from "./types.js";
import { toast } from "./core.js";
import { Modal, sendAnswer } from "./widgets.js";

/** The visual decision gate. When an agent reaches a genuine design fork it offers
 *  concrete options instead of guessing; the operator sees them side by side —
 *  rendered live when an option carries preview HTML — picks one, and the agent
 *  resumes to build exactly that choice. Never lose control at the fork. */
export function DecisionModal(
  { taskId, title, question, options, onClose }:
  { taskId: string; title: string; question: string;
    options: DecisionOption[]; onClose: () => void },
): JSX.Element {
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const chosen = options.find((o) => o.id === picked) ?? null;

  const confirm = async (): Promise<void> => {
    if (!chosen) { toast("Pick an option first.", true); return; }
    const detail = chosen.detail ? ` — ${chosen.detail}` : "";
    const extra = note.trim() ? `\nAlso: ${note.trim()}` : "";
    await sendAnswer(taskId, `${chosen.label}${detail}${extra}`);
    toast(`Chose “${chosen.label}”. ${taskId} resumes with your decision.`);
    onClose();
  };

  return (
    <Modal title={`Decide — ${taskId}`} onClose={onClose} wide>
      <div className="decide">
        <div className="decide-q">
          <span className="decide-title">{title}</span>
          <p className="decide-ask">{question}</p>
        </div>

        <div className="decide-grid">
          {options.map((o) => (
            <button key={o.id} type="button"
              className={`decide-card${picked === o.id ? " is-picked" : ""}`}
              aria-pressed={picked === o.id} onClick={() => setPicked(o.id)}>
              {o.preview_html
                ? (
                  <div className="decide-preview">
                    <iframe className="decide-frame" title={`Preview: ${o.label}`}
                      sandbox="" srcDoc={o.preview_html} />
                  </div>
                )
                : <div className="decide-preview decide-noprev">No preview</div>}
              <div className="decide-body">
                <span className="decide-label">{o.label}</span>
                {o.detail && <span className="decide-detail">{o.detail}</span>}
              </div>
            </button>
          ))}
        </div>

        <label className="work-label" htmlFor="decide-note">Add a note (optional)</label>
        <textarea id="decide-note" className="input decide-note" value={note}
          placeholder="Anything the agent should keep in mind while building your choice…"
          onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="panel-foot spread modal-foot">
        <span className="answer-hint">
          {chosen ? `You picked “${chosen.label}”.` : "Pick the path the agent should take."}
        </span>
        <button className="btn primary" disabled={!chosen} onClick={() => void confirm()}>
          Build this choice
        </button>
      </div>
    </Modal>
  );
}

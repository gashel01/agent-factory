/** The Story tab: the agent's log narrated as a timeline (a typed glyph, a
 *  plain line, the raw path/command dimmed under it), a one-line footprint,
 *  per-step "Rewind to here" while the ticket awaits approval, and the lessons
 *  recorded for this ticket. Narration and icons come from the classic
 *  model.narrate + story.tsx tables; only the markup is new. */

import type { JSX } from "react";
import { ago, fmtTokens } from "../../../model.js";
import type { Checkpoint, StoryItem } from "../../../model.js";
import { useFacts } from "../../../facts.js";
import { EDIT_TOOLS, KIND_ICON, actMeta } from "../../../story.js";
import { useWarden } from "../../data.js";
import { Plus, Undo2 } from "../../icons.js";
import { Btn, Tag } from "../../ui.js";

export interface UndoCtl { checkpoints: Checkpoint[]; onUndo: (sha: string) => void }

function Step({ s, cp, onUndo }: { s: StoryItem; cp?: Checkpoint; onUndo?: (sha: string) => void }): JSX.Element {
  if (s.kind === "act") {
    const m = actMeta(s.tool);
    return (
      <li className="tk-step">
        <span className="tk-glyph" aria-hidden="true"><m.Icon size={13} /></span>
        <div className="stack tk-step-body">
          <div className="row tk-step-verb">
            <span>{m.verb}</span>
            {cp && onUndo && (
              <Btn kind="ghost" small title="Rewind the branch to this step — later changes are discarded"
                onClick={() => onUndo(cp.sha)}><Undo2 size={12} /> Rewind to here</Btn>
            )}
          </div>
          {s.detail && <span className="mono faint tk-step-detail">{s.detail}</span>}
        </div>
      </li>
    );
  }
  const Icon = KIND_ICON[s.kind];
  const label = s.kind === "say" ? "Thinking" : s.kind === "final" ? "Result" : s.kind === "subresult" ? "Sub-agent result" : "Delegated";
  const text = s.kind === "delegate" ? `Delegated to ${s.who}${s.mission ? ` — ${s.mission}` : ""}` : s.text;
  return (
    <li className={`tk-step tk-step-${s.kind}`}>
      <span className="tk-glyph" aria-hidden="true"><Icon size={13} /></span>
      <div className="stack tk-step-body">
        <span className="label">{label}</span>
        <p className="tk-step-text">{text}</p>
      </div>
    </li>
  );
}

function footprint(story: StoryItem[], tokens: number): string {
  const acts = story.filter((s): s is Extract<StoryItem, { kind: "act" }> => s.kind === "act");
  const files = new Set(acts.filter((a) => EDIT_TOOLS.has(a.tool) && a.detail).map((a) => a.detail));
  const parts: string[] = [];
  if (acts.length) parts.push(`${acts.length} ${acts.length === 1 ? "tool" : "tools"}`);
  if (files.size) parts.push(`${files.size} ${files.size === 1 ? "file" : "files"}`);
  if (tokens > 0) parts.push(`${fmtTokens(tokens)} tokens`);
  return parts.join(" · ");
}

export function StoryTimeline({ story, tokens, undo }: { story: StoryItem[]; tokens: number; undo?: UndoCtl }): JSX.Element {
  if (!story.length) return <p className="hint">No activity recorded yet.</p>;
  // Checkpoints are recorded once per file-edit tool, oldest first: the k-th
  // edit step maps to the k-th checkpoint.
  let editIdx = -1;
  const foot = footprint(story, tokens);
  return (
    <div className="stack">
      <ol className="tk-story">
        {story.map((s, i) => {
          let cp: Checkpoint | undefined;
          if (s.kind === "act" && EDIT_TOOLS.has(s.tool)) { editIdx++; cp = undo?.checkpoints[editIdx]; }
          return <Step key={i} s={s} cp={cp} onUndo={undo?.onUndo} />;
        })}
      </ol>
      {foot && <span className="mono faint">{foot}</span>}
    </div>
  );
}

/** Lessons recorded against this ticket; adding one opens the lesson sheet. */
export function TicketLessons({ taskId, draft }: { taskId: string; draft: string }): JSX.Element {
  const w = useWarden();
  const { facts } = useFacts(w.ws);
  const mine = (facts ?? []).filter((f) => f.ticketId === taskId);
  return (
    <section className="stack tk-lessons" aria-label="Learned from this ticket">
      <div className="row">
        <h3 className="tk-h3">Learned from this ticket</h3>
        <span className="spacer" />
        <Btn kind="ghost" small onClick={() => w.open({ type: "lesson", text: draft, ticketId: taskId })}><Plus size={13} /> Add a lesson</Btn>
      </div>
      {facts === null ? <div className="skeleton tk-skel" />
        : mine.length === 0 ? <p className="hint">No lesson recorded yet. Capture what went wrong so the next agent avoids it.</p>
        : mine.map((f) => (
          <div key={f.id} className="card tight tk-lesson">
            <p>{f.text}</p>
            <div className="row tk-lesson-meta">
              <Tag>{f.scope === "global" ? "Global" : "This project"}</Tag>
              {f.applied ? <Tag color="var(--st-merged)">used {f.applied}×</Tag> : null}
              <span className="faint">{ago(f.createdTs)}</span>
            </div>
          </div>
        ))}
    </section>
  );
}

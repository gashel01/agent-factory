/** One lesson in Memory: the rule, where it applies, the ticket it came from
 *  (opens that ticket when it's in the current run), how often it was handed to
 *  an agent, and when it was learned. */

import type { JSX } from "react";
import { ago } from "../../../model.js";
import { useWarden } from "../../data.js";
import { CornerDownLeft } from "../../icons.js";
import { Btn, Tag } from "../../ui.js";
import type { Fact } from "./facts.js";

export function LessonCard({ f, onEdit }: { f: Fact; onEdit: () => void }): JSX.Element {
  const w = useWarden();
  const origin = f.ticketId ? w.tasks.find((t) => t.id === f.ticketId) : undefined;
  return (
    <article className="card mem-card">
      <div className="mem-card-top">
        <p className="mem-text">{f.text}</p>
        <Btn small kind="ghost" onClick={onEdit}>Edit</Btn>
      </div>
      <div className="row mem-meta">
        <Tag color={f.scope === "global" ? "var(--st-info)" : undefined}>{f.scope === "global" ? "Global" : "This project"}</Tag>
        {f.ticketId && (origin ? (
          <button type="button" className="mem-origin" title={`Open ${origin.id} · ${origin.title}`}
            onClick={() => w.open({ type: "ticket", taskId: origin.id })}>
            <CornerDownLeft size={12} /> from {f.ticketId}
          </button>
        ) : (
          <Tag color="var(--st-review)"><CornerDownLeft size={12} /> from {f.ticketId}</Tag>
        ))}
        {f.applied ? (
          <span title="How often this lesson was fed to an agent"><Tag color="var(--st-merged)">applied {f.applied}×</Tag></span>
        ) : null}
        <span className="faint mem-when">{ago(f.createdTs)}</span>
      </div>
    </article>
  );
}

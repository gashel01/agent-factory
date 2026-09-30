/** "Needs you": exactly what's on the operator's plate right now — a question
 *  to answer, a change to review, a failure to retry — with the same safe
 *  one-click actions as the classic rail. Answer and Retry only make sense
 *  while a run is live (the dispatcher picks them up); Review/Approve work any
 *  time a change is waiting. */

import type { CSSProperties, JSX } from "react";
import { toast } from "../../../core.js";
import type { TaskModel } from "../../../model.js";
import { sendControl } from "../../../control.js";
import { useWarden } from "../../data.js";
import { Btn, STATE_COLOR } from "../../ui.js";

const NEEDS = new Set(["BLOCKED", "FAILED", "AWAITING_APPROVAL"]);

function why(t: TaskModel): string {
  if (t.state === "BLOCKED") return t.note ? t.note : "needs an answer";
  if (t.state === "AWAITING_APPROVAL") return "ready for your review";
  return "failed — needs a retry or a look";
}

export function NeedsYouList(): JSX.Element | null {
  const w = useWarden();
  const tasks = w.visible.filter((t) => NEEDS.has(t.state));
  if (tasks.length === 0) return null;

  const answer = (t: TaskModel): void => {
    w.open(t.decision
      ? { type: "decision", taskId: t.id, title: t.title, question: t.note ?? "", options: t.decision }
      : { type: "answer", taskId: t.id, title: t.title, question: t.note ?? "", context: t.blockedContext });
  };
  const review = (t: TaskModel): void => {
    if (t.diff) w.go("diff", t.id);
    else toast(`${t.id} has no change to show yet.`);
  };

  return (
    <section className="sv-needs" aria-label="Needs you">
      <h3 className="sv-needs-head">Needs you <span className="sv-count">{tasks.length}</span></h3>
      <ul className="sv-needs-list">
        {tasks.map((t) => (
          <li key={t.id} className="sv-need" style={{ "--c": STATE_COLOR[t.state] } as CSSProperties}>
            <div className="sv-need-info">
              <p className="sv-need-title"><span className="sv-need-id">{t.id}</span> {t.title}</p>
              <p className="sv-need-why">{why(t)}</p>
            </div>
            <div className="sv-need-acts">
              {t.state === "BLOCKED" && w.live && <Btn small kind="fill" onClick={() => answer(t)}>Answer</Btn>}
              {t.state === "AWAITING_APPROVAL" && (
                <>
                  <Btn small onClick={() => review(t)}>Review</Btn>
                  <Btn small kind="fill" onClick={() => sendControl("approve", t.id)}>Approve</Btn>
                </>
              )}
              {t.state === "FAILED" && w.live && <Btn small kind="fill" onClick={() => sendControl("retry", t.id)}>Retry</Btn>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

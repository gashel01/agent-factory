/** Answer a blocked agent. Shows its question, warns when it is asking for a
 *  destructive git command (blocked at the tool layer anyway), the git ground
 *  truth captured when it blocked, and two quick replies for the common
 *  "already done" case. The ticket goes back in the queue with the answer.
 *  Same wording, same /api/control "answer" call as the classic AnswerModal. */

import { useState } from "react";
import type { JSX } from "react";
import { DESTRUCTIVE_HINT, QUICK_REPLIES } from "../../../answer-hints.js";
import type { BlockedContext } from "../../../types.js";
import { toast } from "../../../core.js";
import { sendAnswer } from "../../../control.js";
import { useWarden } from "../../data.js";
import { CircleHelp, TriangleAlert } from "../../icons.js";
import { Btn, Pills, Sheet, Tag } from "../../ui.js";

export function AnswerSheet({ taskId, title, question, context }: {
  taskId: string; title: string; question: string; context: BlockedContext | null;
}): JSX.Element {
  const w = useWarden();
  const [text, setText] = useState("");
  const send = async (): Promise<void> => {
    if (!text.trim()) { toast("Write your answer first.", true); return; }
    await sendAnswer(taskId, text.trim());
    w.close();
  };
  const quick = QUICK_REPLIES.find((q) => q.text === text)?.label ?? "";

  return (
    <Sheet title={title} eyebrow={<><span className="mono faint">{taskId}</span><Tag color="var(--st-needs)" dot>Needs an answer</Tag></>}
      onClose={w.close}
      footer={(
        <>
          <span className="hint tk-foot-hint">The ticket goes back in the queue and runs again with your answer.</span>
          <Btn kind="fill" onClick={send}>Send answer</Btn>
        </>
      )}>
      {question && (
        <div className="tk-question"><CircleHelp size={17} /><p>{question}</p></div>
      )}
      {DESTRUCTIVE_HINT.test(question) && (
        <div className="tk-callout tk-callout-warn" role="alert">
          <TriangleAlert size={16} />
          <span className="tk-callout-body">This agent wants to run a destructive git command. It is blocked at the tool layer — don't approve it.
            Guide it, or do the git yourself if it's truly needed.</span>
        </div>
      )}
      {context && (
        <section className="card tight tk-facts" aria-label="Git ground truth when it blocked">
          <span className="label">Git ground truth · when it blocked</span>
          <div className="row tk-facts-row">
            <Tag color={context.clean ? "var(--st-merged)" : "var(--st-review)"}>{context.clean ? "working tree clean" : "uncommitted changes"}</Tag>
            <Tag color={context.commits === 0 ? "var(--st-review)" : "var(--st-merged)"}>{context.commits} new commit{context.commits === 1 ? "" : "s"}</Tag>
            {context.commits === 0 && context.clean && <span className="hint">nothing to lose — likely already implemented</span>}
          </div>
          {context.diffstat.length > 0 && <pre className="code tk-pre">{context.diffstat.join("\n")}</pre>}
          {context.status.length > 0 && <pre className="code tk-pre">{context.status.join("\n")}</pre>}
        </section>
      )}
      <div className="stack tk-quick">
        <span className="label">Quick replies</span>
        <Pills label="Quick replies" value={quick} onChange={(label) => setText(QUICK_REPLIES.find((q) => q.label === label)?.text ?? "")}
          options={QUICK_REPLIES.map((q) => ({ value: q.label, label: q.label }))} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tk-answer">Your answer</label>
        <textarea id="tk-answer" className="input tk-answer" value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Answer the agent's question — it restarts with your reply as context…" />
      </div>
    </Sheet>
  );
}

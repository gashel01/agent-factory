/** New work › From a goal: describe the outcome, the planner explores the repo
 *  and drafts several tickets — optionally asking a few questions first. The
 *  drafts then show up in the review list below the form. */

import type { JSX } from "react";
import { CircleHelp, Sparkles } from "../../icons.js";
import { Btn, Switch } from "../../ui.js";
import { AttachRow } from "./Attachments.js";
import { PlanProgress } from "./PlanProgress.js";
import type { Planner } from "./usePlanner.js";

function Questions({ p }: { p: Planner }): JSX.Element {
  return (
    <section className="card tight nw-questions">
      <div className="row"><CircleHelp size={16} aria-hidden="true" /><b>A few questions to aim the plan</b></div>
      <p className="hint">Pick a suggestion or write your own. Blank answers use the planner’s default.</p>
      {(p.questions ?? []).map((q, i) => (
        <div key={i} className="nw-question">
          <label className="nw-question-q" htmlFor={`nw-q-${i}`}><span className="nw-question-n">{i + 1}</span>{q.q}</label>
          {q.why && <p className="hint">{q.why}</p>}
          {q.suggestions.length > 0 && (
            <div className="pills" role="group" aria-label={`Suggestions for question ${i + 1}`}>
              {q.suggestions.map((s, j) => (
                <button key={j} type="button" className="pill" aria-pressed={(p.answers[i] ?? "") === s}
                  onClick={() => p.setAnswer(i, s)}>{s}</button>
              ))}
            </div>
          )}
          <input id={`nw-q-${i}`} className="input" placeholder="Your answer (or pick one above)…"
            value={p.answers[i] ?? ""} onChange={(e) => p.setAnswer(i, e.target.value)} />
        </div>
      ))}
      <div className="row">
        <Btn kind="ghost" onClick={p.skipQuestions}>Skip — just draft</Btn>
        <span className="spacer" />
        <Btn kind="fill" onClick={p.draftWithAnswers}><Sparkles size={15} /> Draft tickets</Btn>
      </div>
    </section>
  );
}

export function FromGoalBody({ p }: { p: Planner }): JSX.Element {
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="nw-goal">What do you want done?</label>
        <textarea id="nw-goal" className="input nw-goal" value={p.goal}
          placeholder="One or two sentences (paste an image too). The planner explores the repo and drafts the tickets."
          onChange={(e) => p.setGoal(e.target.value)}
          onPaste={p.att.paste} onDrop={p.att.drop} onDragOver={(e) => e.preventDefault()} />
        <AttachRow att={p.att} />
      </div>
      <div className="nw-ask">
        <div className="stack nw-ask-text">
          <b>Ask me questions first</b>
          <span className="hint">The planner explores your repo, then asks a few high-leverage questions so the plan matches what you actually want.</span>
        </div>
        <Switch label="Ask me questions first" checked={p.askMode}
          onChange={(v) => { if (!p.planning && !p.questions) p.setAskMode(v); }} />
      </div>
      {p.planning && <PlanProgress output={p.planOut} startMs={p.planStart} mode={p.planMode} />}
      {p.questions && !p.planning && <Questions p={p} />}
    </>
  );
}

export function FromGoalFoot({ p }: { p: Planner }): JSX.Element {
  if (p.questions && !p.planning) return <span className="hint">Answer the questions above, or skip them to draft directly.</span>;
  return (
    <>
      <span className="spacer" />
      <Btn kind="fill" busy={p.planning} disabled={!p.goal.trim() || p.att.uploading > 0} onClick={p.start}>
        {p.planning
          ? (p.planMode === "questions" ? "Thinking of questions…" : "Planning…")
          : p.askMode ? <><CircleHelp size={15} /> Plan with questions</> : <><Sparkles size={15} /> Draft tickets with AI</>}
      </Btn>
    </>
  );
}

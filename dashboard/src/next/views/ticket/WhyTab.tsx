/** "Why it failed" — the post-mortem of one failed ticket, answering what an
 *  operator actually asks: what happened, what proves it, what to do next.
 *  Recommendations that map to a control op get a button. Evidence stays
 *  verbatim in a code block: restyling a log excerpt into prose would make it
 *  read as our words, not the agent's. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "../../../api.js";
import { DX_CATEGORY } from "../../../diagnosis-model.js";
import type { Diagnosis } from "../../../diagnosis-model.js";
import { sendControl } from "../../../control.js";
import { FileText, Lightbulb, ListChecks, RotateCw, TriangleAlert } from "../../icons.js";
import { Btn, Tag } from "../../ui.js";
import { confidencePct, parseDiagnosis } from "./diagnosis.js";

export function WhyTab({ taskId, run }: { taskId: string; run: string | null }): JSX.Element {
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setDiag(null); setFailed(false);
    const q = `/api/diagnostics?task=${encodeURIComponent(taskId)}${run ? `&run=${encodeURIComponent(run)}` : ""}`;
    void fetchJSON<Record<string, unknown>>(q)
      .then((r) => { if (alive) setDiag(parseDiagnosis(r)); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [taskId, run, attempt]);

  if (failed) {
    return (
      <div className="tk-callout" role="alert">
        <TriangleAlert size={16} />
        <span className="tk-callout-body"><b>No diagnosis available.</b> The failure analysis couldn't be reached.</span>
        <Btn small kind="ghost" onClick={() => setAttempt((n) => n + 1)}><RotateCw size={13} /> Try again</Btn>
      </div>
    );
  }
  if (diag === null) return <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="skeleton tk-skel" />)}</div>;
  const empty = !diag.headline && !diag.detail && diag.timeline.length === 0 && diag.evidence.length === 0 && diag.recommendations.length === 0;
  if (empty) return <p className="hint">Nothing to analyse for this ticket yet — no failure was recorded in its run.</p>;
  const conf = confidencePct(diag.confidence);

  return (
    <div className="stack tk-why">
      <div className="tk-verdict">
        <div className="row">
          <Tag color="var(--st-needs)">{DX_CATEGORY[diag.category] ?? diag.category}</Tag>
          {conf !== null && <span className="faint" title="How sure this reading is">{conf}% confident</span>}
        </div>
        {diag.headline && <h3 className="tk-verdict-head">{diag.headline}</h3>}
        {diag.detail && <p className="dim">{diag.detail}</p>}
        {diag.category === "unknown" && (
          <p className="hint">The signals don't point at one cause — the excerpts below are the raw material to judge for yourself.</p>
        )}
      </div>

      {diag.recommendations.length > 0 && (
        <section className="stack tk-block">
          <h3 className="label tk-block-head"><Lightbulb size={13} /> What to do next · best first</h3>
          <ol className="tk-fixes">
            {diag.recommendations.map((f, i) => (
              <li key={i} className="tk-fix">
                <div className="stack tk-fix-text">
                  <b>{f.label}</b>
                  {f.detail && <span className="dim">{f.detail}</span>}
                </div>
                {f.op && <Btn small kind={i === 0 ? "fill" : "default"} onClick={() => sendControl(f.op, f.task || taskId)}>{f.op}</Btn>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {diag.timeline.length > 0 && (
        <section className="stack tk-block">
          <h3 className="label tk-block-head"><ListChecks size={13} /> How it got there</h3>
          <ol className="tk-steps">
            {diag.timeline.map((s, i) => (
              <li key={i}><span className="tk-step-n">{i + 1}</span><span>{s.text}</span>{s.when && <span className="mono faint">{s.when}</span>}</li>
            ))}
          </ol>
        </section>
      )}

      {diag.evidence.length > 0 && (
        <section className="stack tk-block">
          <h3 className="label tk-block-head"><FileText size={13} /> Raw excerpts · verbatim</h3>
          {diag.evidence.map((e, i) => (
            <div key={i} className="stack tk-evidence">
              {e.source && <span className="mono faint">{e.source}</span>}
              <pre className="code tk-pre">{e.text}</pre>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

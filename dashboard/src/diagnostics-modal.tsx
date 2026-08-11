import { useEffect, useState } from "react";
import type { JSX } from "react";
import { FileText, ListChecks, Lightbulb, RotateCw, TriangleAlert } from "./icons.js";
import { Button, Skeleton } from "./core.js";
import { Modal, sendControl } from "./widgets.js";
import { fetchJSON } from "./api.js";

const asRec = (v: unknown): Record<string, unknown> =>
  (v !== null && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const asStr = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const asNum = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v)) ? v : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A confidence on the wire may be a 0–1 ratio or an already-scaled percentage. */
function pct(v: number | null): number | null {
  if (v === null) return null;
  return Math.max(0, Math.min(100, Math.round(v <= 1 ? v * 100 : v)));
}

export interface DiagnosisStep { when: string; text: string }
export interface DiagnosisEvidence { source: string; text: string }
/** A recommendation with an `op` is actionable: it maps to an /api/control op. */
export interface DiagnosisFix { label: string; detail: string; op: string; task: string }
export interface Diagnosis {
  category: string; headline: string; detail: string; confidence: number | null;
  timeline: DiagnosisStep[]; evidence: DiagnosisEvidence[]; recommendations: DiagnosisFix[];
}

/** Human wording per diagnosis category. An unlisted one (or "unknown") falls
 *  back to the raw category — "no conclusive cause" is a normal answer here,
 *  not an error state. */
export const DX_CATEGORY: Record<string, string> = {
  verify: "Verification failed",
  test: "Tests failed",
  build: "Build broke",
  timeout: "Ran out of time",
  budget: "Budget reached",
  merge: "Merge conflict",
  blocked: "Needed an answer",
  agent: "The agent gave up",
  infra: "Environment problem",
  scope: "Ticket scope problem",
  unknown: "No conclusive cause",
};

function parseDiagnosis(raw: unknown): Diagnosis {
  // The endpoint wraps the diagnosis as {ok, run, task, diagnosis, summary}, so
  // unwrap it — reading the fields off the envelope gave an all-empty diagnosis
  // every time, which the modal reported as "no failure was recorded".
  const top = asRec(raw);
  const d = asRec(top["diagnosis"] ?? top);
  return {
    category: asStr(d["category"]) || "unknown",
    headline: asStr(d["headline"]),
    detail: asStr(d["detail"]),
    confidence: asNum(d["confidence"]),
    timeline: asArr(d["timeline"])
      .map((s): DiagnosisStep => {
        if (typeof s === "string") return { when: "", text: s };
        const o = asRec(s);
        return { when: asStr(o["ts"] ?? o["at"]), text: asStr(o["text"] ?? o["label"]) };
      })
      .filter((s) => s.text || s.when),
    evidence: asArr(d["evidence"])
      .map((e): DiagnosisEvidence => {
        if (typeof e === "string") return { source: "", text: e };
        const o = asRec(e);
        return { source: asStr(o["source"] ?? o["file"]), text: asStr(o["text"] ?? o["excerpt"]) };
      })
      .filter((e) => e.text),
    recommendations: asArr(d["recommendations"])
      .map((r): DiagnosisFix => {
        const o = asRec(r);
        return {
          label: asStr(o["label"]), detail: asStr(o["detail"]),
          op: asStr(o["op"]), task: asStr(o["task"]),
        };
      })
      .filter((r) => r.label || r.detail),
  };
}

/**
 * "Why did it fail?" — the post-mortem for one failed ticket. It answers the
 * three questions an operator actually has: what happened, what proves it, and
 * what to do next. The evidence stays verbatim in a monospace block — restyling
 * a log excerpt into prose would make it read as our words, not the agent's.
 */
export function DiagnosticsModal(
  { taskId, title, run, onClose }:
  { taskId: string; title: string; run?: string | null; onClose: () => void },
): JSX.Element {
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setDiag(null); setErr(null);
    const q = `/api/diagnostics?task=${encodeURIComponent(taskId)}`
      + (run ? `&run=${encodeURIComponent(run)}` : "");
    void fetchJSON<Record<string, unknown>>(q)
      .then((r) => { if (alive) setDiag(parseDiagnosis(r)); })
      .catch((e: unknown) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [taskId, run, attempt]);

  const conf = pct(diag?.confidence ?? null);
  const empty = diag !== null && !diag.headline && !diag.detail
    && diag.timeline.length === 0 && diag.evidence.length === 0 && diag.recommendations.length === 0;

  return (
    <Modal title="Why did it fail?" onClose={onClose} wide>
      <div className="dx">
        <div className="dx-task"><span className="kcard-id">{taskId}</span> {title}</div>

        {err !== null && (
          <div className="dx-error" role="alert">
            <TriangleAlert size={14} />
            <div className="dx-error-body">
              <b>No diagnosis available.</b> The dashboard couldn't reach the failure analysis.
              <div className="dx-error-detail mono">{err}</div>
            </div>
            <button className="btn ghost" onClick={() => setAttempt((n) => n + 1)}><RotateCw size={13} /> Try again</button>
          </div>
        )}

        {err === null && diag === null && <Skeleton lines={5} />}

        {err === null && empty && (
          <p className="hint">Nothing to analyse for this ticket yet — no failure was recorded in its run.</p>
        )}

        {err === null && diag !== null && !empty && (
          <>
            <div className="dx-verdict">
              <div className="dx-verdict-top">
                <span className={`dx-cat dx-cat-${diag.category}`}>{DX_CATEGORY[diag.category] ?? diag.category}</span>
                {conf !== null && (
                  <span className="dx-conf" title="How sure this reading is">
                    <span className="tnum">{conf}%</span> confident
                  </span>
                )}
              </div>
              {diag.headline && <h4 className="dx-headline">{diag.headline}</h4>}
              {diag.detail && <p className="dx-detail">{diag.detail}</p>}
              {diag.category === "unknown" && (
                <p className="dx-hedge">The signals don't point at one cause — the excerpts below are the raw material to judge for yourself.</p>
              )}
            </div>

            {diag.recommendations.length > 0 && (
              <section className="dx-block">
                <h5 className="dx-h"><Lightbulb size={13} /> What to do next <span className="dx-h-note">best first</span></h5>
                <ol className="dx-fixes">
                  {diag.recommendations.map((f, i) => (
                    <li key={i} className="dx-fix">
                      <div className="dx-fix-body">
                        <div className="dx-fix-label">{f.label}</div>
                        {f.detail && <div className="dx-fix-detail">{f.detail}</div>}
                      </div>
                      {f.op && (
                        <Button kind="btn" variant={i === 0 ? "primary" : "ghost"} autoPending
                          onClick={() => sendControl(f.op, f.task || taskId)}>{f.op}</Button>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {diag.timeline.length > 0 && (
              <section className="dx-block">
                <h5 className="dx-h"><ListChecks size={13} /> How it got there</h5>
                <ol className="dx-timeline">
                  {diag.timeline.map((s, i) => (
                    <li key={i}>
                      <span className="dx-step-n tnum">{i + 1}</span>
                      <span className="dx-step-text">{s.text}</span>
                      {s.when && <span className="dx-step-when mono">{s.when}</span>}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {diag.evidence.length > 0 && (
              <section className="dx-block">
                <h5 className="dx-h"><FileText size={13} /> Raw excerpts <span className="dx-h-note">verbatim, unedited</span></h5>
                {diag.evidence.map((e, i) => (
                  <div key={i} className="dx-ev">
                    {e.source && <div className="dx-ev-src mono">{e.source}</div>}
                    <pre className="dx-ev-text mono">{e.text}</pre>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

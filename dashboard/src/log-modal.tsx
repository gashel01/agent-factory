/* Extracted from modals.tsx — mechanical split. */
/** Agent Factory dashboard — run log modal with real-time display. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { TaskModel } from "./model.js";
import { ago, fmtDuration, fmtTokens, fmtUsd, inFlight, narrate } from "./model.js";
import { getText } from "./api.js";
import { Skeleton, StatusPill, useEsc } from "./core.js";
import { Timer, X } from "./icons.js";
import { sendControl, quickRun } from "./widgets.js";
import { FactEditor, useFacts } from "./screens.js";
import { StoryView, EDIT_TOOLS } from "./story.js";

export function ModalMeasures({ t, now }: { t: TaskModel; now: number }): JSX.Element {
  const running = t.state === "RUNNING" && t.runningSince !== null;
  return (
    <div className="log-meas mono">
      <span><Timer size={13} /> {running ? fmtDuration((now - t.runningSince!) / 1000) : t.wallS !== null ? fmtDuration(t.wallS) : "—"}</span>
      {t.costUsd > 0 && <span>{fmtUsd(t.costUsd)}</span>}
      {t.tokens > 0 && <span>{fmtTokens(t.tokens)} tokens</span>}
      <span className="faint">attempt {t.retries + 1}</span>
    </div>
  );
}

export function LogModal(
  { taskId, title, ws, live, getTask, now, onAnswer, onDiff, onClose }:
  { taskId: string; title: string; ws: string; live: boolean;
    getTask: () => TaskModel | undefined; now: number; onAnswer: () => void; onDiff: () => void; onClose: () => void },
): JSX.Element {
  const [raw, setRaw] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [addLesson, setAddLesson] = useState(false);
  const [reqChanges, setReqChanges] = useState(false);
  const [feedback, setFeedback] = useState("");
  const t = getTask();
  const { facts, reload } = useFacts(ws);
  const taskFacts = (facts ?? []).filter((f) => f.ticketId === taskId);
  const attention = t?.state === "FAILED" || t?.state === "BLOCKED";
  const [following, setFollowing] = useState(inFlight(t?.state));
  const bodyRef = useRef<HTMLDivElement>(null);
  useEsc(() => { if (addLesson) setAddLesson(false); else onClose(); });

  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      const text = await getText(`/api/log?task=${encodeURIComponent(taskId)}`);
      if (!alive) return;
      if (text !== null) setRaw(text);
      if (!inFlight(getTask()?.state)) setFollowing(false);
    };
    void refresh();
    if (!inFlight(getTask()?.state)) return;
    const id = setInterval(refresh, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [taskId]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [raw]);

  const story = useMemo(() => (raw ? narrate(raw) : []), [raw]);
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel">
        <div className="log-head">
          <div className="log-head-top">
            <span className="kcard-id">{t?.id ?? taskId}</span>
            {t && <StatusPill state={t.state} live={t.state === "RUNNING"} />}
            {following && <span className="live-tag"><span className="live-dot" />live</span>}
            <button className="btn icon" onClick={onClose}><X size={15} /></button>
          </div>
          <div className="log-title">{title}</div>
          {t && <ModalMeasures t={t} now={now} />}
        </div>
        <div className="panel-body log-body" ref={bodyRef}>
          {raw === null ? <Skeleton lines={4} />
            : rawMode ? <pre className="log-pre">{raw}</pre>
            : <StoryView story={story} tokens={t ? (t.liveTokens || t.tokens) : 0}
                undo={t && t.state === "AWAITING_APPROVAL" && live && t.checkpoints.length > 0
                  ? { checkpoints: t.checkpoints, onUndo: (sha) => void sendControl("undo", t.id, undefined, sha) }
                  : undefined} />}

          <section className="log-lessons">
            <div className="log-lessons-head">
              <h4>Learned from this task</h4>
              <button className="btn link" onClick={() => setAddLesson(true)}>+ Add a lesson</button>
            </div>
            {taskFacts.length === 0
              ? <p className="log-lessons-empty">No lesson recorded yet. Capture what went wrong so the next agent avoids it.</p>
              : <div className="fact-list">{taskFacts.map((f) => (
                  <div key={f.id} className="fact-card">
                    <div className="fact-text">{f.text}</div>
                    <div className="fact-foot">
                      <span className={`pill fam-${f.scope === "global" ? "working" : "upnext"}`}>
                        {f.scope === "global" ? "Global" : "This project"}
                      </span>
                      {f.applied ? <span className="fact-used">used {f.applied}×</span> : null}
                      <span className="fact-when">{ago(f.createdTs)}</span>
                    </div>
                  </div>
                ))}</div>}
          </section>
        </div>
        {t?.state === "AWAITING_APPROVAL" && reqChanges && (
          <div className="approval-changes">
            <label htmlFor="changes-text">What needs to change? The agent will restart with this note.</label>
            <textarea id="changes-text" autoFocus value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g. the validation is wrong, also handle the empty case…" />
          </div>
        )}
        <div className="panel-foot spread">
          <div className="log-actions">
            {t?.state === "BLOCKED" && live && (
              <button className="btn primary" onClick={onAnswer}>Answer</button>
            )}
            {t?.state === "AWAITING_APPROVAL" && !reqChanges && (
              <>
                <button className="btn primary"
                  onClick={() => { void sendControl("approve", taskId); onClose(); }}>
                  Approve and merge
                </button>
                <button className="btn danger" onClick={() => setReqChanges(true)}>
                  Request changes
                </button>
                {t.diff && <button className="btn ghost" onClick={onDiff}>View diff</button>}
              </>
            )}
            {t?.state === "AWAITING_APPROVAL" && reqChanges && (
              <>
                <button className="btn primary" disabled={!feedback.trim()}
                  onClick={() => { void sendControl("changes", taskId, feedback.trim()); onClose(); }}>
                  Send back to the agent
                </button>
                <button className="btn ghost" onClick={() => { setReqChanges(false); setFeedback(""); }}>
                  Cancel
                </button>
              </>
            )}
            {attention && !(t?.state === "BLOCKED" && live) && (live
              ? <button className="btn primary" onClick={() => void sendControl("retry", taskId)}>Try again</button>
              : <button className="btn primary" onClick={() => void quickRun()}>Run again</button>)}
            {t?.state === "RUNNING" && live && (
              <button className="btn danger" onClick={() => void sendControl("kill", taskId)}>Stop</button>
            )}
            {t?.state === "DONE" && t.diff && (
              <button className="btn ghost" onClick={onDiff}>View diff</button>
            )}
          </div>
          <button className="btn link" onClick={() => setRawMode((v) => !v)}>
            {rawMode ? "Show as story" : "Show raw log"}
          </button>
        </div>
      </div>
      {addLesson && (
        <FactEditor fact="new" tasks={t ? [t] : []}
          draft={{ text: attention && t?.note ? `${t.note}\n\nLesson: ` : "", ticketId: taskId }}
          onClose={() => setAddLesson(false)}
          onSaved={() => { setAddLesson(false); reload(); }} />
      )}
    </div>
  );
}

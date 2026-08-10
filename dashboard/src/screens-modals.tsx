import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { BlockedContext } from "./types.js";
import { fetchJSON } from "./api.js";
import { fmtUsd, parseSettings } from "./model.js";
import { Key, Lock, Play, TriangleAlert } from "./icons.js";
import { Button, toast } from "./core.js";
import { ConfirmButton, Modal, sendAnswer } from "./widgets.js";
import { DockerStatus } from "./modals.js";

export const DESTRUCTIVE_HINT = /\b(reset\s+--hard|--force|force-with-lease|git\s+rebase|git\s+clean|filter-branch|checkout\s+--)\b/i;

export const QUICK_REPLIES: Array<{ label: string; text: string }> = [
  { label: "Already done → no-op",
    text: "The ticket's change already exists in the repo. Do NOT reset, rebase, or "
      + "force anything. Report status \"done\" with \"noop\": true (already implemented)." },
  { label: "Don't rewrite history",
    text: "Do not run any destructive git command (reset --hard, rebase, force, clean). "
      + "Explain in one line what is actually missing, or report done/noop if nothing is." },
];

export function RunGuardModal(
  { runnable, budgetUsd, avgCost, onConfirm, onClose, onSettings }:
  { runnable: number; budgetUsd: number | null; avgCost: number | null;
    onConfirm: () => void | Promise<void>; onClose: () => void; onSettings: () => void },
): JSX.Element {
  const estimate = avgCost !== null ? avgCost * runnable : null;
  const noCap = budgetUsd === null || budgetUsd <= 0;
  const [apiMode, setApiMode] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [dockerReady, setDockerReady] = useState<boolean | null>(null);
  useEffect(() => {
    void fetchJSON<{ content: string }>("/api/config")
      .then((r) => {
        const s = parseSettings(r.content);
        setApiMode(s.executionMode === "api");
        setSandbox(s.isolation === "sandbox");
      })
      .catch(() => { /* offline */ });
  }, []);
  useEffect(() => {
    if (!sandbox) { setDockerReady(null); return; }
    void fetchJSON<DockerStatus>("/api/docker")
      .then((d) => setDockerReady(Boolean(d.engine) && Boolean(d.image)))
      .catch(() => setDockerReady(false));
  }, [sandbox]);
  return (
    <Modal title="Start this run?" onClose={onClose}>
      <div className="work-form">
        <div className="run-guard-line">
          <span className="rg-n">{runnable}</span>
          <span>ticket{runnable === 1 ? "" : "s"} will run (everything not yet merged).</span>
        </div>
        {apiMode && (
          <div className="run-guard-budget warn">
            <Key size={14} /> <b>API mode</b> — this run bills real dollars to your <code>ANTHROPIC_API_KEY</code>.
            <button className="btn link" onClick={onSettings}>Switch to Subscription</button>
          </div>
        )}
        {sandbox && (
          dockerReady === false ? (
            <div className="run-guard-budget warn">
              <Lock size={14} /> <b>Sandbox selected, but Docker isn't ready</b> — the run will fail until the engine is up and the image is built.
              <button className="btn link" onClick={onSettings}>Fix in Settings</button>
            </div>
          ) : (
            <div className="run-guard-budget">
              <Lock size={14} /> <b>Sandbox mode</b> — agents run confined: only their worktree is visible, egress limited to Anthropic.
            </div>
          )
        )}
        {estimate !== null
          ? <p className="work-hint">Your past runs averaged <b>{fmtUsd(avgCost!)}</b> per merged ticket — so roughly <b>{fmtUsd(estimate)}</b> for this run. A rough guide, not a quote.</p>
          : <p className="work-hint">No cost history yet, so I can't estimate this one.</p>}
        <div className={`run-guard-budget${noCap ? " warn" : ""}`}>
          {noCap
            ? <>No budget cap — this run can spend without a limit. <button className="btn link" onClick={onSettings}>Set a cap</button></>
            : <>Budget cap in force: <b>{fmtUsd(budgetUsd!)}</b>. The run stops launching new agents once it's reached.</>}
        </div>
      </div>
      <div className="panel-foot spread modal-foot">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <Button kind="btn" variant="primary" autoPending onClick={onConfirm}><Play size={14} /> Start run</Button>
      </div>
    </Modal>
  );
}

export function AnswerModal(
  { taskId, title, question, context, onClose }:
  { taskId: string; title: string; question: string; context: BlockedContext | null;
    onClose: () => void },
): JSX.Element {
  const [text, setText] = useState("");
  const send = async (): Promise<void> => {
    if (!text.trim()) { toast("Write your answer first.", true); return; }
    await sendAnswer(taskId, text.trim());
    onClose();
  };
  const destructive = DESTRUCTIVE_HINT.test(question);
  return (
    <Modal title={`Answer ${taskId}`} onClose={onClose}>
      <div className="work-form">
        <div className="answer-title">{title}</div>
        {question && (
          <div className="answer-question"><span className="flag">?</span><span>{question}</span></div>
        )}
        {destructive && (
          <div className="answer-warn">
            <TriangleAlert size={14} /> This agent wants to run a destructive git command. It is blocked at the tool
            layer — don't approve it. Guide it, or do the git yourself if it's truly needed.
          </div>
        )}
        {context && (
          <div className="answer-facts">
            <div className="facts-head">Git ground truth <span className="facts-sub">when it blocked</span></div>
            <div className="facts-row">
              <span className={`facts-pill ${context.clean ? "ok" : "warn"}`}>
                {context.clean ? "working tree clean" : "uncommitted changes"}
              </span>
              <span className={`facts-pill ${context.commits === 0 ? "warn" : "ok"}`}>
                {context.commits} new commit{context.commits === 1 ? "" : "s"}
              </span>
              {context.commits === 0 && context.clean && (
                <span className="facts-note">nothing to lose — likely already implemented</span>
              )}
            </div>
            {context.diffstat.length > 0 && (
              <pre className="facts-pre">{context.diffstat.join("\n")}</pre>
            )}
            {context.status.length > 0 && (
              <pre className="facts-pre">{context.status.join("\n")}</pre>
            )}
          </div>
        )}
        <div className="answer-quick">
          {QUICK_REPLIES.map((q) => (
            <button key={q.label} className="chip" type="button"
              onClick={() => setText(q.text)}>{q.label}</button>
          ))}
        </div>
        <label className="work-label">Your answer</label>
        <textarea className="input fact-text-input" value={text} autoFocus
          placeholder="Answer the agent's question — it restarts with your reply as context…"
          onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="panel-foot spread modal-foot">
        <span className="answer-hint">The task goes back in the queue and runs again with your answer.</span>
        <button className="btn primary" onClick={() => void send()}>Send answer</button>
      </div>
    </Modal>
  );
}

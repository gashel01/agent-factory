import { useEffect, useState, JSX } from "react";
import { Diff } from "./cockpit.js";
import type { ReviewComment, ReviewProps } from "./cockpit.js";
import { fetchJSON } from "./api.js";
import { Skeleton, toast, useEsc } from "./core.js";
import { Modal, sendControl } from "./widgets.js";
import type { TaskModel } from "./model.js";

let commentSeq = 0;

/** Show exactly what an agent changed for a merged ticket (B5). The range
 *  survives the deleted branch because both commits hang off the merge commit. */
export function DiffModal(
  { taskId, title, diff, onClose }:
  { taskId: string; title: string; diff: { repo: string; from: string; to: string }; onClose: () => void },
): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams({ repo: diff.repo, from: diff.from, to: diff.to });
    fetchJSON<{ diff: string }>(`/api/repo/diff?${qs}`)
      .then((r) => setText(r.diff))
      .catch((e) => setErr(String(e)));
  }, [diff.repo, diff.from, diff.to]);
  return (
    <Modal title={`Diff — ${taskId}`} onClose={onClose} wide>
      <div className="diff-title">{title}</div>
      {err ? <p className="hint">Couldn't load the diff: {err}</p>
        : text === null ? <Skeleton lines={4} />
        : text.trim() === "" ? <p className="hint">No file changes recorded for this ticket.</p>
        : <Diff text={text} />}
    </Modal>
  );
}

/** The pépite: review a ticket awaiting approval, pin comments to diff lines,
 *  then approve the merge or send every comment back to the agent as one
 *  "changes" instruction. GitHub-style review — but the reviewee is an agent. */
export function ReviewModal({ task, onClose }: { task: TaskModel; onClose: () => void }): JSX.Element {
  const diff = task.diff!;
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [composing, setComposing] =
    useState<{ file: string; key: string; line: number | null; snippet: string } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    const qs = new URLSearchParams({ repo: diff.repo, from: diff.from, to: diff.to });
    fetchJSON<{ diff: string }>(`/api/repo/diff?${qs}`).then((r) => setText(r.diff)).catch((e) => setErr(String(e)));
  }, [diff.repo, diff.from, diff.to]);
  useEsc(() => { if (composing) setComposing(null); else onClose(); });

  const review: ReviewProps = {
    comments,
    composingKey: composing?.key ?? null,
    onStart: (file, key, line, snippet) => setComposing({ file, key, line, snippet }),
    onCancel: () => setComposing(null),
    onSubmit: (t) => {
      if (composing) setComments((cs) => [...cs, { id: ++commentSeq, ...composing, text: t }]);
      setComposing(null);
    },
    onRemove: (id) => setComments((cs) => cs.filter((c) => c.id !== id)),
  };

  // One instruction the agent can act on: the general note, then each pinned
  // comment with its file, line and the exact code it refers to.
  const compile = (): string => {
    const parts: string[] = [];
    if (note.trim()) parts.push(note.trim());
    for (const c of comments) {
      parts.push(`In ${c.file}${c.line != null ? `:${c.line}` : ""} — ${c.text}\n    > ${c.snippet.trim()}`);
    }
    return parts.join("\n\n");
  };
  const hasFeedback = comments.length > 0 || note.trim().length > 0;

  return (
    <Modal title={`Review — ${task.id}`} onClose={onClose} wide>
      <div className="review-head">
        <div className="diff-title">{task.title}</div>
        <div className="review-sub">
          Ready for your review. Click the <span className="mono">+</span> on a line to pin a comment
          {comments.length > 0 ? ` — ${comments.length} comment${comments.length > 1 ? "s" : ""}.` : "."}
        </div>
      </div>
      {err ? <p className="hint">Couldn't load the diff: {err}</p>
        : text === null ? <Skeleton lines={4} />
        : text.trim() === "" ? <p className="hint">No file changes recorded for this ticket.</p>
        : <Diff text={text} review={review} />}
      <textarea className="input review-note" placeholder="General comment (optional)…"
        value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="panel-foot spread review-foot">
        <button className="btn danger" disabled={!hasFeedback}
          onClick={() => { void sendControl("changes", task.id, compile()); onClose(); }}>
          Request changes{comments.length > 0 ? ` (${comments.length})` : ""}
        </button>
        <button className="btn primary"
          onClick={() => { void sendControl("approve", task.id); onClose(); }}>
          Approve and merge
        </button>
      </div>
    </Modal>
  );
}

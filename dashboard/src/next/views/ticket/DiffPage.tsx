/** The Diff page (#/diff/<taskId>): exactly what an agent changed for one
 *  ticket, with a file list to jump around. The range survives the deleted
 *  branch because both commits hang off the merge commit — until the repo is
 *  rebuilt; then git's error becomes a plain sentence (gitError.ts). For a
 *  ticket awaiting approval the page is the review: pin comments to lines, add
 *  a general note, then approve the merge or send it all back as "changes". */

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "../../../api.js";
import { parseDiff } from "../../../model.js";
import { sendControl } from "../../../control.js";
import { useWarden } from "../../data.js";
import { ArrowLeft, CircleHelp, RotateCw } from "../../icons.js";
import { Topbar } from "../../shell/Topbar.js";
import { Btn, Card, Empty, IconBtn, STATE_LABEL } from "../../ui.js";
import { useTicketActions } from "../board/actions.js";
import { DiffFileView, fileAnchor } from "./DiffView.js";
import type { ReviewComment, ReviewCtl } from "./DiffView.js";
import { plainGitError } from "./gitError.js";

let commentSeq = 0;

export function DiffPage({ taskId }: { taskId: string }): JSX.Element {
  const w = useWarden();
  const act = useTicketActions();
  const t = w.model.tasks.get(taskId);
  const range = t?.diff ?? null;
  const [text, setText] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [composing, setComposing] = useState<{ file: string; key: string; line: number | null; snippet: string } | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!range) return;
    let alive = true;
    setText(null); setLoadFailed(false);
    const qs = new URLSearchParams({ repo: range.repo, from: range.from, to: range.to });
    fetchJSON<{ diff: string }>(`/api/repo/diff?${qs}`)
      .then((r) => { if (alive) setText(r.diff); })
      .catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, [range?.repo, range?.from, range?.to, attempt]);

  const gitErr = text !== null ? plainGitError(text) : null;
  const files = useMemo(() => (text && !gitErr ? parseDiff(text).files : []), [text, gitErr]);
  const back = <IconBtn boxed label="Back to the board" onClick={() => w.go("board")}><ArrowLeft size={17} /></IconBtn>;

  if (!t || !range) {
    return (
      <>
        <Topbar title="Diff" lead={back} />
        <div className="view">
          <Empty title={t ? "No changes recorded for this ticket yet" : `Ticket ${taskId || "?"} isn't in the current run`}
            action={<Btn onClick={() => w.go("board")}>Back to the board</Btn>}>
            {t ? "Its diff appears once the agent has committed work." : "Open the diff from a ticket on the board."}
          </Empty>
        </div>
      </>
    );
  }

  const reviewing = t.state === "AWAITING_APPROVAL";
  const review: ReviewCtl | undefined = reviewing ? {
    comments,
    composingKey: composing?.key ?? null,
    onStart: (file, key, line, snippet) => setComposing({ file, key, line, snippet }),
    onCancel: () => setComposing(null),
    onSubmit: (body) => {
      if (composing) setComments((cs) => [...cs, { id: ++commentSeq, ...composing, text: body }]);
      setComposing(null);
    },
    onRemove: (id) => setComments((cs) => cs.filter((c) => c.id !== id)),
  } : undefined;
  // One instruction the agent can act on: the general note, then each pinned
  // comment with its file, line and the exact code it refers to.
  const compile = (): string => [
    ...(note.trim() ? [note.trim()] : []),
    ...comments.map((c) => `In ${c.file}${c.line != null ? `:${c.line}` : ""} — ${c.text}\n    > ${c.snippet.trim()}`),
  ].join("\n\n");
  const hasFeedback = comments.length > 0 || note.trim().length > 0;
  const adds = files.reduce((s, f) => s + f.adds, 0);
  const dels = files.reduce((s, f) => s + f.dels, 0);
  const sub = `${t.title} · ${STATE_LABEL[t.state].toLowerCase()} · ${range.from.slice(0, 7)}..${range.to.slice(0, 7)}`;

  return (
    <>
      <Topbar title={`Ticket ${t.id}`} sub={sub} lead={back}>
        <Btn kind="ghost" onClick={() => act.open(t.id)}>Ticket history</Btn>
        <a className="btn" title="Open the repo in your IDE" href={`vscode://file/${range.repo.replace(/\\/g, "/")}`}>Open in IDE</a>
      </Topbar>
      <div className="view tk-diff-view">
        {loadFailed ? (
          <div className="tk-callout" role="alert">
            <CircleHelp size={16} />
            <span className="tk-callout-body"><b>Couldn't load the diff.</b> The Warden server didn't answer — check it's still running.</span>
            <Btn small kind="ghost" onClick={() => setAttempt((n) => n + 1)}><RotateCw size={13} /> Try again</Btn>
          </div>
        ) : text === null ? (
          <div className="stack">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton tk-skel" />)}</div>
        ) : gitErr ? (
          <div className="tk-callout" role="status">
            <CircleHelp size={16} />
            <span className="tk-callout-body"><b>{gitErr.title}.</b> {gitErr.detail}</span>
          </div>
        ) : files.length === 0 ? (
          <Empty title="No file changes recorded for this ticket" />
        ) : (
          <div className="tk-diff">
            <nav className="card tk-files" aria-label="Changed files">
              <span className="label">{files.length} file{files.length === 1 ? "" : "s"} · <span className="tk-add">+{adds}</span> <span className="tk-del">−{dels}</span></span>
              {files.map((f) => (
                <a key={f.path} className="tk-files-item" href={`#${fileAnchor(f.path)}`} title={f.path}
                  onClick={(e) => { e.preventDefault(); document.getElementById(fileAnchor(f.path))?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>
                  <span className="mono tk-files-name">{f.path.split("/").pop()}</span>
                  <span className="tk-add">+{f.adds}</span><span className="tk-del">−{f.dels}</span>
                </a>
              ))}
            </nav>
            <div className="stack tk-diff-files">
              {reviewing && (
                <p className="hint">Ready for your review. Use the <span className="mono">+</span> on a line to pin a comment
                  {comments.length > 0 ? ` — ${comments.length} comment${comments.length > 1 ? "s" : ""} to send back.` : "."}</p>
              )}
              {files.map((f) => <DiffFileView key={f.path} f={f} review={review} />)}
            </div>
          </div>
        )}
        {reviewing && (
          <Card className="tk-review-bar">
            <label className="field-label" htmlFor="tk-review-note">General comment (optional)</label>
            <textarea id="tk-review-note" className="input" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the agent should change overall…" />
            <div className="row">
              <Btn kind="danger" disabled={!hasFeedback}
                onClick={() => sendControl("changes", t.id, compile()).then(() => w.go("board"))}>
                Request changes{comments.length > 0 ? ` (${comments.length})` : ""}
              </Btn>
              <span className="spacer" />
              <Btn kind="fill" onClick={() => sendControl("approve", t.id).then(() => w.go("board"))}>Approve and merge</Btn>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { parseDiff } from "./model.js";
import { langFromPath } from "./highlight.js";
import { ChevronDown } from "./icons.js";
import { CodeLine } from "./repo-modal.js";

/** An operator's note pinned to one diff line (the pépite: it loops back to the
 *  agent as "changes" feedback). */
export interface ReviewComment { id: number; file: string; key: string; line: number | null; snippet: string; text: string }

export interface ReviewProps {
  comments: ReviewComment[];
  composingKey: string | null;
  onStart: (file: string, key: string, line: number | null, snippet: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  onRemove: (id: number) => void;
}

/** Inline textarea to compose a comment on one diff line. Cmd/Ctrl+Enter saves. */
export function CommentComposer({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (t: string) => void }): JSX.Element {
  const [t, setT] = useState("");
  return (
    <div className="diff-composer" onClick={(e) => e.stopPropagation()}>
      <textarea autoFocus className="input" placeholder="What's wrong with this line?" value={t}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && t.trim()) { e.preventDefault(); onSubmit(t.trim()); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }} />
      <div className="composer-actions">
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="btn primary sm" disabled={!t.trim()} onClick={() => onSubmit(t.trim())}>Add</button>
      </div>
    </div>
  );
}

/** A unified diff: one collapsible section per file, syntax-highlighted, with a
 *  jump bar when several files changed. With `review`, each line takes an inline
 *  comment thread. */
export function Diff({ text, review }: { text: string; review?: ReviewProps }): JSX.Element {
  const { files } = useMemo(() => parseDiff(text), [text]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (p: string): void =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  if (files.length === 0) return <pre className="diff-pre">{text}</pre>;
  const jump = (path: string): void =>
    document.getElementById(`df-${path}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const totalAdds = files.reduce((s, f) => s + f.adds, 0);
  const totalDels = files.reduce((s, f) => s + f.dels, 0);
  const pending = review?.comments.length ?? 0;
  return (
    <div className="diff-view">
      {/* One-line footprint of the change — file count and total +/−, with the
          review state when the diff is open for comment. */}
      <div className="diff-summary">
        <span className="ds-files">Edited {files.length} {files.length === 1 ? "file" : "files"}</span>
        <span className="chip-add">+{totalAdds}</span><span className="chip-del">−{totalDels}</span>
        {review && (
          <span className="ds-review">
            {pending > 0
              ? `${pending} comment${pending > 1 ? "s" : ""} to send back`
              : "Comment on any line to review"}
          </span>
        )}
      </div>
      {files.length > 1 && (
        <div className="diff-filebar">
          {files.map((f) => (
            <button key={f.path} className="diff-filechip" onClick={() => jump(f.path)}>
              <span className="chip-path">{f.path.split("/").pop()}</span>
              <span className="chip-add">+{f.adds}</span><span className="chip-del">−{f.dels}</span>
            </button>
          ))}
        </div>
      )}
      {files.map((f) => {
        const lang = langFromPath(f.path);
        const shut = collapsed.has(f.path);
        return (
          <section key={f.path} id={`df-${f.path}`} className="diff-file">
            <button className="diff-filehead" onClick={() => toggle(f.path)}>
              <span className={`chev${shut ? " closed" : ""}`}><ChevronDown size={14} /></span>
              <span className="dfh-path">{f.path}</span>
              <span className="dfh-counts"><span className="chip-add">+{f.adds}</span><span className="chip-del">−{f.dels}</span></span>
            </button>
            {!shut && (
              <pre className="diff-pre">
                {f.lines.map((l, i) => {
                  if (l.kind === "hunk") return <div key={i} className="diff-line diff-hunk">{l.text}</div>;
                  const lineKey = `${f.path}#${i}`;
                  const threads = review ? review.comments.filter((c) => c.key === lineKey) : [];
                  return (
                    <div key={i}>
                      <div className={`diff-line diff-${l.kind}${review ? " commentable" : ""}`}>
                        <span className="diff-mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                        <span className="diff-code"><CodeLine code={l.text} lang={lang} /></span>
                        {review && (
                          <button className="diff-add-comment" title="Comment on this line"
                            onClick={() => review.onStart(f.path, lineKey, l.n ?? null, l.text)}>+</button>
                        )}
                      </div>
                      {threads.map((c) => (
                        <div key={c.id} className="diff-comment">
                          <span className="dc-text">{c.text}</span>
                          <button className="dc-del" title="Remove" onClick={() => review!.onRemove(c.id)}>×</button>
                        </div>
                      ))}
                      {review?.composingKey === lineKey && (
                        <CommentComposer onCancel={review.onCancel} onSubmit={review.onSubmit} />
                      )}
                    </div>
                  );
                })}
              </pre>
            )}
          </section>
        );
      })}
    </div>
  );
}

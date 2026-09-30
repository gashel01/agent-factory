/** A unified diff in the new style: one collapsible section per file, line
 *  numbers on the new side, syntax colouring from highlight.ts. In review mode
 *  every line takes a pinned comment (the pépite: those comments go back to the
 *  agent as one "changes" instruction). Parsing is the classic parseDiff. */

import { useState } from "react";
import type { JSX } from "react";
import { langFromPath, tokenizeLine } from "../../../highlight.js";
import type { DiffFile } from "../../../model.js";
import { ChevronDown, ChevronRight, X } from "../../icons.js";
import { Btn, IconBtn } from "../../ui.js";

export interface ReviewComment { id: number; file: string; key: string; line: number | null; snippet: string; text: string }

export interface ReviewCtl {
  comments: ReviewComment[];
  composingKey: string | null;
  onStart: (file: string, key: string, line: number | null, snippet: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  onRemove: (id: number) => void;
}

/** Anchor id of a file section, for the file list's jump links. */
export const fileAnchor = (path: string): string => `tk-file-${path.replace(/[^\w-]/g, "_")}`;

function Composer({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (t: string) => void }): JSX.Element {
  const [t, setT] = useState("");
  return (
    <div className="stack tk-composer">
      <label className="sr-only" htmlFor="tk-line-comment">Comment on this line</label>
      <textarea id="tk-line-comment" className="input" autoFocus placeholder="What's wrong with this line? (Ctrl+Enter to add)" value={t}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && t.trim()) { e.preventDefault(); onSubmit(t.trim()); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }} />
      <div className="row">
        <Btn kind="ghost" small onClick={onCancel}>Cancel</Btn>
        <Btn kind="fill" small disabled={!t.trim()} onClick={() => onSubmit(t.trim())}>Add comment</Btn>
      </div>
    </div>
  );
}

function Code({ text, lang }: { text: string; lang: string }): JSX.Element {
  return <>{tokenizeLine(text, lang).map((tk, i) => <span key={i} className={tk.cls || undefined}>{tk.text}</span>)}</>;
}

export function DiffFileView({ f, review }: { f: DiffFile; review?: ReviewCtl }): JSX.Element {
  const [shut, setShut] = useState(false);
  const lang = langFromPath(f.path);
  return (
    <section id={fileAnchor(f.path)} className="tk-file" aria-label={f.path}>
      <button type="button" className="tk-file-head" aria-expanded={!shut} onClick={() => setShut((v) => !v)}>
        {shut ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        <span className="mono tk-file-path">{f.path}</span>
        <span className="tk-add">+{f.adds}</span><span className="tk-del">−{f.dels}</span>
      </button>
      {!shut && (
        <div className="code tk-code">
          {f.lines.map((l, i) => {
            if (l.kind === "hunk") return <div key={i} className="code-line hunk">{l.text}</div>;
            const key = `${f.path}#${i}`;
            const threads = review ? review.comments.filter((c) => c.key === key) : [];
            return (
              <div key={i}>
                <div className={`code-line ${l.kind === "ctx" ? "" : l.kind} tk-line`}>
                  <span className="code-num">{l.n ?? ""}</span>
                  <span className="code-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                  <span className="tk-line-code"><Code text={l.text} lang={lang} /></span>
                  {review && (
                    <button type="button" className="tk-line-add" aria-label={`Comment on line ${l.n ?? ""} of ${f.path}`}
                      onClick={() => review.onStart(f.path, key, l.n ?? null, l.text)}>+</button>
                  )}
                </div>
                {threads.map((c) => (
                  <div key={c.id} className="row tk-comment">
                    <span className="tk-comment-text">{c.text}</span>
                    <IconBtn small label="Remove this comment" onClick={() => review!.onRemove(c.id)}><X size={13} /></IconBtn>
                  </div>
                ))}
                {review?.composingKey === key && <Composer onCancel={review.onCancel} onSubmit={review.onSubmit} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

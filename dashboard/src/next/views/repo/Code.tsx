/** Source rendering for the repo views: one highlighted line, a whole file with
 *  line numbers, and a unified diff (per-file, collapsible, with a jump bar).
 *  Tokenising is the classic highlight.ts (stateless, one line at a time);
 *  parsing is the classic model.parseDiff — only the markup is new. */

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { langFromPath, tokenizeLine } from "../../../highlight.js";
import { parseDiff } from "../../../model.js";
import { ChevronDown, ChevronRight } from "../../icons.js";
import { diffFailure } from "./errors.js";

/** Files past this many lines render the head only, with a note (a 20k-line
 *  generated file would otherwise freeze the tab). */
const MAX_FILE_LINES = 4000;

export function CodeLine({ code, lang }: { code: string; lang: string }): JSX.Element {
  const toks = tokenizeLine(code, lang);
  return <>{toks.map((t, i) => <span key={i} className={t.cls || undefined}>{t.text}</span>)}</>;
}

export function CodeFile({ content, path }: { content: string; path: string }): JSX.Element {
  const lang = langFromPath(path);
  const lines = content.split("\n");
  const shown = lines.slice(0, MAX_FILE_LINES);
  return (
    <div className="code rp-code" role="region" aria-label={`Contents of ${path}`}>
      {shown.map((ln, i) => (
        <div key={i} className="code-line">
          <span className="code-num">{i + 1}</span>
          <span><CodeLine code={ln} lang={lang} /></span>
        </div>
      ))}
      {lines.length > MAX_FILE_LINES && (
        <p className="hint rp-code-note">Showing the first {MAX_FILE_LINES.toLocaleString()} of {lines.length.toLocaleString()} lines — open it in your editor for the rest.</p>
      )}
    </div>
  );
}

/** A unified diff (git show / git diff output). `empty` is what to say when
 *  the two sides are identical. */
export function DiffView({ text, empty = "No changes." }: { text: string; empty?: string }): JSX.Element {
  const failure = diffFailure(text);
  const { preamble, files } = useMemo(() => parseDiff(text), [text]);
  const [shut, setShut] = useState<Set<string>>(new Set());
  if (failure) return <p className="rp-note">{failure}</p>;
  if (!text.trim()) return <p className="hint">{empty}</p>;
  const toggle = (p: string): void =>
    setShut((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const adds = files.reduce((s, f) => s + f.adds, 0);
  const dels = files.reduce((s, f) => s + f.dels, 0);
  // The commit header git prints before the patch (message + stat), minus the stat bars.
  const message = preamble.filter((l) => !/\|\s+(\d+|Bin)|files? changed|^commit |^Author:|^Date:|^Merge:/.test(l))
    .map((l) => l.trim()).join("\n").trim();
  const fileId = (p: string): string => `rp-df-${p.replace(/[^\w-]/g, "_")}`;
  return (
    <div className="stack rp-diff">
      {message && <pre className="rp-diff-msg">{message}</pre>}
      {files.length === 0 ? <p className="hint">{empty}</p> : (
        <>
          <div className="row rp-diff-sum">
            <span>{files.length} {files.length === 1 ? "file" : "files"} changed</span>
            <span className="rp-add">+{adds}</span><span className="rp-del">−{dels}</span>
          </div>
          {files.length > 1 && (
            <div className="rp-chips" aria-label="Jump to a file">
              {files.map((f) => (
                <button key={f.path} type="button" className="rp-chip"
                  onClick={() => document.getElementById(fileId(f.path))?.scrollIntoView({ block: "start", behavior: "smooth" })}>
                  <span className="mono">{f.path.split("/").pop()}</span>
                  <span className="rp-add">+{f.adds}</span><span className="rp-del">−{f.dels}</span>
                </button>
              ))}
            </div>
          )}
          {files.map((f) => {
            const lang = langFromPath(f.path);
            const closed = shut.has(f.path);
            return (
              <section key={f.path} id={fileId(f.path)} className="rp-dfile">
                <button type="button" className="rp-dfile-head" aria-expanded={!closed} onClick={() => toggle(f.path)}>
                  {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="mono rp-dfile-path">{f.path}</span>
                  <span className="rp-add">+{f.adds}</span><span className="rp-del">−{f.dels}</span>
                </button>
                {!closed && (
                  <div className="code rp-code rp-dfile-body">
                    {f.lines.map((l, i) => l.kind === "hunk"
                      ? <div key={i} className="code-line hunk">{l.text}</div>
                      : (
                        <div key={i} className={`code-line${l.kind === "add" ? " add" : l.kind === "del" ? " del" : ""}`}>
                          <span className="code-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                          <span><CodeLine code={l.text} lang={lang} /></span>
                        </div>
                      ))}
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

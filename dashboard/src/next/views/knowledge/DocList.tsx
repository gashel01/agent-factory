/** What's in the knowledge base: one row per ingested document with its chunk
 *  count and size, or a plain "couldn't be indexed" when ragmcp failed on it,
 *  and a remove button. */

import type { JSX } from "react";
import type { KnowledgeDoc } from "../../../api-shapes.js";
import { BookOpen, Trash2 } from "../../icons.js";
import { Empty, IconBtn } from "../../ui.js";

export function DocList({ docs, loadError, onRemove }: {
  docs: KnowledgeDoc[] | null; loadError: boolean; onRemove: (d: KnowledgeDoc) => void;
}): JSX.Element {
  return (
    <aside className="card kb-list" aria-labelledby="kb-list-title">
      <div className="row kb-list-head">
        <h2 id="kb-list-title" className="card-title">In the knowledge base</h2>
        {docs && <span className="faint">{docs.length} document{docs.length === 1 ? "" : "s"}</span>}
      </div>
      {loadError && <p className="hint" role="alert">Couldn’t load the knowledge base from the server.</p>}
      {docs === null ? (
        <div className="stack" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton kb-skel" />)}
        </div>
      ) : docs.length === 0 ? (
        <Empty icon={<BookOpen size={22} />} title="Nothing here yet">
          Company knowledge that isn’t in the code — business rules, domain notes, a Confluence export — so agents
          honour the “why”, not just the code.
        </Empty>
      ) : (
        <ul className="kb-docs">
          {docs.map((d) => (
            <li key={d.id} className="kb-doc">
              <div className="kb-doc-main">
                <span className="kb-doc-name">{d.name}</span>
                <span className="kb-doc-meta">
                  {d.error
                    ? <span className="kb-doc-err">couldn’t be indexed</span>
                    : <span>{d.chunks ?? 0} chunk{d.chunks === 1 ? "" : "s"}</span>}
                  <span> · {Math.max(1, Math.round(d.size / 1024))} KB</span>
                  {d.addedTs && <span> · added {new Date(d.addedTs).toLocaleDateString()}</span>}
                </span>
              </div>
              <IconBtn small label={`Remove ${d.name}`} onClick={() => onRemove(d)}><Trash2 size={15} /></IconBtn>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

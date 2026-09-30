/** Attached files for a composer (goal, ticket details): thumbnails with a
 *  remove button, plus an "Attach" picker. Upload and the refs appended to the
 *  text come from the classic useFileAttachments hook (core.tsx). */

import { useRef } from "react";
import type { JSX } from "react";
import type { useFileAttachments } from "../../../core.js";
import { Upload, X } from "../../icons.js";

export type Attach = ReturnType<typeof useFileAttachments>;

export function AttachRow({ att }: { att: Attach }): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="nw-attach">
      {att.items.map((a) => (
        <span key={a.path} className="nw-thumb" title={a.name}>
          <img src={a.thumb} alt={a.name} />
          <button type="button" className="nw-thumb-x" aria-label={`Remove ${a.name}`} onClick={() => att.remove(a.path)}>
            <X size={11} />
          </button>
        </span>
      ))}
      <button type="button" className="btn ghost sm" onClick={() => input.current?.click()}>
        <Upload size={14} /> Attach
      </button>
      {att.uploading > 0 && <span className="hint">Uploading {att.uploading}…</span>}
      <input ref={input} type="file" multiple hidden onChange={(e) => { att.pick(e.target.files); e.target.value = ""; }} />
      <span className="faint nw-attach-hint">or paste / drop files into the text</span>
    </div>
  );
}

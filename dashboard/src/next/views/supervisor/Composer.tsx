/** Where the operator writes to the supervisor. Enter sends, Shift+Enter breaks
 *  the line; files can be pasted, dropped or picked — each is uploaded right
 *  away and its path appended to the message so the supervisor can read it
 *  (the classic `useFileAttachments` contract). The draft is only cleared once
 *  the server accepted the turn, so a refused send never eats what was typed. */

import { useRef, useState } from "react";
import type { JSX } from "react";
import { useFileAttachments } from "../../../core.js";
import { Paperclip } from "lucide-react";
import { Send, X } from "../../icons.js";
import type { SupervisorChat } from "./useSupervisorChat.js";

export function Composer({ chat }: { chat: SupervisorChat }): JSX.Element {
  const [msg, setMsg] = useState("");
  const files = useFileAttachments();
  const pickRef = useRef<HTMLInputElement>(null);
  const blocked = chat.thinking || !msg.trim() || files.uploading > 0;

  const send = async (): Promise<void> => {
    if (blocked) return;
    const ok = await chat.send(msg.trim() + files.refs());
    if (ok) { setMsg(""); files.clear(); }
  };

  return (
    <div className="sv-compose">
      {files.items.length > 0 && (
        <ul className="sv-attach" aria-label="Attached files">
          {files.items.map((a) => (
            <li key={a.path} className="sv-attach-item" title={a.name}>
              <img src={a.thumb} alt="" />
              <span className="sv-attach-name">{a.name}</span>
              <button type="button" className="sv-attach-x" aria-label={`Remove ${a.name}`} onClick={() => files.remove(a.path)}>
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sv-compose-box" onDrop={files.drop} onDragOver={(e) => e.preventDefault()}>
        <label htmlFor="sv-input" className="sr-only">Message the supervisor</label>
        <textarea id="sv-input" className="sv-input" rows={1} placeholder="Ask about this run…" value={msg}
          onChange={(e) => setMsg(e.target.value)} onPaste={files.paste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button type="button" className="iconbtn sm" aria-label="Attach files" title="Attach files"
          onClick={() => pickRef.current?.click()}>
          {files.uploading > 0 ? <span className="spinner" aria-hidden="true" /> : <Paperclip size={16} />}
        </button>
        <input ref={pickRef} type="file" multiple hidden tabIndex={-1}
          onChange={(e) => { files.pick(e.target.files); e.target.value = ""; }} />
        <button type="button" className="sv-send" aria-label="Send message" disabled={blocked} onClick={() => void send()}>
          <Send size={15} />
        </button>
      </div>
      <p className="sv-safety">Run commands it suggests only happen when you click them.</p>
    </div>
  );
}

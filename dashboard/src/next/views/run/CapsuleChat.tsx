/** Edit the cockpit in plain words ("add a lint action", "the dev server is on
 *  port 3000"): an agent proposes a new capsule, shown as a line diff of
 *  capsule.json to apply or discard — never applied blind. Plus Regenerate,
 *  which re-runs the onboarding agent from scratch. */

import { useState } from "react";
import type { JSX } from "react";
import { Check, Sparkles, X } from "../../icons.js";
import { Btn } from "../../ui.js";
import type { Cockpit } from "./useCapsule.js";

export function CapsuleChat({ c }: { c: Cockpit }): JSX.Element {
  const [msg, setMsg] = useState("");
  const send = async (): Promise<void> => {
    if (c.chatBusy || !msg.trim()) return;
    if (await c.sendChat(msg)) setMsg("");
  };
  const changes = c.draft?.filter((l) => l.t !== "ctx").length ?? 0;
  return (
    <section className="card rn-chat" aria-label="Edit the cockpit">
      {c.draft && (
        <div className="stack rn-gap-8">
          <b className="row rn-gap-6"><Sparkles size={14} aria-hidden="true" /> Proposed edit — review, then apply</b>
          <div className="code rn-draft">
            {changes === 0 ? <div className="code-line">No change.</div> : c.draft.map((l, i) => (
              <div key={i} className={`code-line${l.t === "add" ? " add" : l.t === "del" ? " del" : ""}`}>
                <span className="code-sign">{l.t === "add" ? "+" : l.t === "del" ? "−" : " "}</span>{l.s}
              </div>
            ))}
          </div>
          <div className="row">
            <Btn small kind="fill" onClick={c.applyChat}><Check size={14} /> Apply</Btn>
            <Btn small kind="ghost" onClick={c.discardChat}><X size={14} /> Discard</Btn>
          </div>
        </div>
      )}
      <form className="row rn-chat-row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input className="input" aria-label="Describe a change to the cockpit" value={msg} disabled={c.chatBusy}
          placeholder="Change the cockpit — e.g. “add a lint action”"
          onChange={(e) => setMsg(e.currentTarget.value)} />
        <Btn kind="fill" small busy={c.chatBusy} disabled={!msg.trim()} onClick={send}>
          <Sparkles size={14} /> {c.chatBusy ? "Editing…" : "Edit"}
        </Btn>
      </form>
      <div className="row rn-wrap">
        <span className="faint rn-small">Or start over from the repository:</span>
        <Btn small kind="ghost" busy={c.gen?.state === "running"} onClick={c.generate}
          title="Re-run the onboarding agent to regenerate this capsule">
          <Sparkles size={13} /> {c.gen?.state === "running" ? "Regenerating…" : "Regenerate"}
        </Btn>
      </div>
    </section>
  );
}
